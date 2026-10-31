// A YouTube station plays through unattended: real IFrame player (public videos), real brain + voice, host breaks
// between songs, one video whose owner turned embedding off. Measures every transition and checks gap budgets.
//   node e2e/youtube-radio.e2e.mjs [baseUrl]
// baseUrl must be a host NAME (http://localhost:PORT): YouTube refuses label videos embedded on a bare-IP origin.
// env: BRAIN_URL + BRAIN_MODEL (OpenAI-compatible; BRAIN_KEY_FILE for a key), VOICE_URL + VOICE_MODEL + VOICE_A/B
//      (OpenAI-compatible speech; VOICE_KEY_FILE), FLAG=1 adds --autoplay-policy=no-user-gesture-required (default:
//      none, the radio is started with a real click like a listener's tap), TALK_OVER=1 talk over every intro
//      (default: the second half of the breaks), VIDEOS=id:sec,id:sec,... (BAD=id = the embedding-off one),
//      SEEK=1 jump to 8 s before each song's end once its break is ready (long videos), OUT=result.json, SHOTS=dir,
//      MAX_MS (whole run, default 9 min), LEGACY=1 (old builds: measure only, no ahead checks expected).
// Keys are read from files and never printed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:8782';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
const out = process.env.OUT ?? '/tmp/hostcaster-yt-radio.json';
mkdirSync(shots, { recursive: true });
const keyOf = (f) => (f ? readFileSync(f, 'utf8').trim() : undefined);
const BRAIN = { url: process.env.BRAIN_URL ?? 'http://localhost:11434/v1', model: process.env.BRAIN_MODEL ?? 'llama3.2', key: keyOf(process.env.BRAIN_KEY_FILE) };
const VOICE = { url: process.env.VOICE_URL ?? 'http://localhost:8880/v1', model: process.env.VOICE_MODEL ?? 'kokoro', key: keyOf(process.env.VOICE_KEY_FILE), a: process.env.VOICE_A ?? 'af_heart', b: process.env.VOICE_B ?? 'am_michael' };
// short public videos (19-31 s) keep the run short; DvH1oUPy6pw has embedding turned off by its owner
const VIDEOS = (process.env.VIDEOS ?? 'jNQXAC9IVRw:19,zK-__R-wyig:20,DvH1oUPy6pw:30,-kBswNVJGX0:27,SpNv5xXYpCI:29,hvfZUzkuk2M:30')
  .split(',')
  .map((s) => ({ id: s.split(':')[0], sec: Number(s.split(':')[1] ?? 30) }));
const BAD = process.env.BAD ?? 'DvH1oUPy6pw';
const MAX_MS = Number(process.env.MAX_MS ?? 9 * 60_000);
const LEGACY = process.env.LEGACY === '1';
const BUDGET = { endToVoiceMs: 1000, hostEndToSongMs: 1500 };

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
  console.log(results.at(-1));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chromium', args: process.env.FLAG === '1' ? ['--autoplay-policy=no-user-gesture-required'] : [] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// the lab clock: every voice element that starts or ends sound, stamped in page time
await ctx.addInitScript(() => {
  const lab = (window.__lab = { t0: performance.now(), ev: [] });
  const push = (e) => lab.ev.push({ at: Math.round(performance.now() - lab.t0), ...e });
  lab.push = push;
  // the app's IndexedDB, raw (works on any build): settings, hosts, stations, brains, voices
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('hostcaster');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => (db.close(), res(req?.result));
      t.onerror = () => rej(t.error);
    });
  };
  window.__idb = {
    get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
    put: (store, v) => tx(store, 'readwrite', (s) => s.put(v)),
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    if (!this.__labWired) {
      this.__labWired = true;
      this.addEventListener('playing', () => push({ ev: 'audio-on', dur: Math.round((this.duration || 0) * 1000) }));
      this.addEventListener('ended', () => push({ ev: 'audio-off' }));
    }
    return play.apply(this, a);
  };
});

// MOCK the server's YouTube routes (no Google account in tests): the listener's Liked videos are these public videos
await ctx.route('**/api/config', async (r) => {
  const res = await r.fetch();
  const j = await res.json();
  await r.fulfill({ json: { ...j, signIn: { ...j.signIn, google: true } } });
});
await ctx.route('**/api/google/status', (r) => r.fulfill({ json: { connected: true, email: 'listener@example.com', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] } }));
await ctx.route('**/api/google/youtube/playlists', (r) => r.fulfill({ json: { playlists: [{ id: 'LL', title: 'Liked videos', count: VIDEOS.length, liked: true }] } }));
await ctx.route('**/api/google/youtube/playlist/**', (r) =>
  r.fulfill({
    json: {
      // no embeddable flag: like a video blocked in this country, only the player can tell (checked ahead)
      items: VIDEOS.map((v, i) => ({ videoId: v.id, title: `Lab Artist ${i + 1} - Lab Song ${i + 1}${v.id === BAD ? ' (embedding off)' : ''}`, channel: `Lab Artist ${i + 1}`, thumbnail: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, durationMs: v.sec * 1000 })),
    },
  }),
);

await page.goto(`${base}/`);
await page.waitForFunction(() => window.__hostcaster?.radio, undefined, { timeout: 30000 });
await page.waitForFunction(async () => Boolean(await window.__idb.get('settings', 'app')), undefined, { timeout: 30000, polling: 250 });
await page.evaluate(async () => {
  const s = await window.__idb.get('settings', 'app');
  await window.__idb.put('settings', { ...s, onboarded: true });
});

// import Liked videos and make a station from it (the real screens)
await page.goto(`${base}/#/services/youtube`);
await page.reload();
await page.getByRole('button', { name: /^Liked videos/ }).click({ timeout: 20000 });
await page.getByRole('heading', { name: 'Liked videos' }).waitFor({ timeout: 20000 });
await page.getByRole('button', { name: 'Make a station' }).click();
await page.getByText('Station ready').first().waitFor({ timeout: 10000 }).catch(() => undefined);
const stationId = await page.evaluate(async () => (await window.__idb.all('stations')).find((s) => s.sources.some((x) => x.kind === 'youtube-playlist'))?.id);
check('station made from Liked videos (YouTube)', Boolean(stationId));

// the hosts think with the lab brain and speak with the lab voice; a break after every song
await page.evaluate(
  async ({ stationId, BRAIN, VOICE, talkOver }) => {
    const db = window.__idb;
    const now = Date.now();
    await db.put('brains', { id: 'lab-brain', name: 'Lab brain', kind: 'openai', baseUrl: BRAIN.url, apiKey: BRAIN.key, model: BRAIN.model, transport: 'device', createdAt: now, updatedAt: now });
    await db.put('voices', { id: 'lab-voice', name: 'Lab voice', kind: 'openai-compatible', baseUrl: VOICE.url, apiKey: VOICE.key, model: VOICE.model, transport: 'device', createdAt: now, updatedAt: now });
    const st = await db.get('stations', stationId);
    const ids = st.hostIds.slice(0, 2);
    let k = 0;
    for (const id of ids) {
      const h = await db.get('hosts', id);
      await db.put('hosts', { ...h, brainId: 'lab-brain', voice: { ...h.voice, voiceProviderId: 'lab-voice', voiceId: k++ ? VOICE.b : VOICE.a, speed: 1, pitch: 1 }, updatedAt: now });
    }
    const segments = Object.fromEntries(Object.keys(st.segments).map((key) => [key, key === 'songs']));
    await db.put('stations', { ...st, hostIds: ids, talkEvery: 1, talkLength: 'short', talkOverIntro: talkOver, shuffle: false, segments, updatedAt: now });
    const set = await db.get('settings', 'app');
    await db.put('settings', { ...set, activeStationId: stationId, onboarded: true });
  },
  { stationId, BRAIN, VOICE, talkOver: process.env.TALK_OVER === '1' },
);

// timeline: player, radio, YouTube and break preparation events
await page.reload();
await page.waitForFunction(() => window.__hostcaster?.radio && window.__hostcaster?.services?.youtube, undefined, { timeout: 30000 });
if (process.env.DEBUG === '1') await page.evaluate(() => (window.__labDebug = true));
await page.evaluate(() => {
  const { player, radio, services } = window.__hostcaster;
  const push = window.__lab.push;
  const pending = () => radio.pending;
  player.on('trackstart', (t) => push({ ev: 'trackstart', id: t.ref }));
  player.on('trackend', (t) => push({ ev: 'trackend', id: t.ref, ready: Boolean(pending()?.ready), prepping: Boolean(pending() && !pending().done) }));
  player.on('error', (e) => push({ ev: 'error', msg: e.message }));
  player.on('skipped', ({ track, reason }) => push({ ev: 'skipped', id: track.ref, reason }));
  services.youtube.on('play', () => push({ ev: 'yt-play', id: player.state.track?.ref }));
  services.youtube.on('ended', () => push({ ev: 'yt-ended', id: player.state.track?.ref }));
  if (window.__labDebug) {
    const onState = services.youtube.onState.bind(services.youtube);
    services.youtube.onState = (st) => {
      push({ ev: 'yt-state', st, id: player.state.track?.ref, pos: player.state.positionMs });
      onState(st);
    };
  }
  radio.on('line', (l) => push({ ev: 'line', host: l.hostId, text: l.text.slice(0, 60) }));
  radio.on('break', (b) => push({ ev: 'break', after: b.songAfter?.title ?? '', before: b.songBefore?.title ?? '', lines: b.lines.length }));
  let phase = radio.state.phase;
  radio.on('state', (s) => {
    if (s.phase !== phase) push({ ev: `phase-${s.phase}`, notice: s.notice });
    phase = s.phase;
  });
  const prepare = radio.prepare.bind(radio);
  radio.prepare = async (...a) => {
    const t = performance.now();
    push({ ev: 'prep-start', kind: a[1] });
    const b = await prepare(...a);
    push({ ev: 'prep-done', ms: Math.round(performance.now() - t), tookMs: b?.tookMs, writeMs: b?.writeMs, lines: b?.lines?.length, standIn: b?.standIn });
    // every clip voiced (the break was ready at the first one)
    if (b) void Promise.all(b.clips).then(() => push({ ev: 'clips-done', ms: Math.round(performance.now() - t) }));
    return b;
  };
});

// go on air with a real click (a listener's tap: the only user gesture of the whole run)
await page.goto(`${base}/#/`);
const goOnAir = page.getByRole('button', { name: 'Go on air' }).first();
await goOnAir.waitFor({ timeout: 15000 });
await goOnAir.click();
const t0 = Date.now();

const playable = VIDEOS.filter((v) => v.id !== BAD).map((v) => v.id);
const halfway = Math.ceil((playable.length - 1) / 2);
let talkOverOn = process.env.TALK_OVER === '1';
let seekedFor = '';
for (;;) {
  await wait(1000);
  const s = await page.evaluate(() => {
    const ev = window.__lab.ev;
    const { player, radio } = window.__hostcaster;
    return {
      started: [...new Set(ev.filter((e) => e.ev === 'trackstart').map((e) => e.id))],
      breaks: ev.filter((e) => e.ev === 'break').length,
      status: player.state.status,
      ref: player.state.track?.ref,
      pos: player.state.positionMs,
      dur: player.state.durationMs,
      ready: Boolean(radio.pending?.ready),
      phase: radio.state.phase,
    };
  });
  // the second half of the breaks talks over the next song's intro (unless every break does)
  if (!talkOverOn && s.breaks >= halfway) {
    talkOverOn = true;
    await page.evaluate(async (id) => {
      const st = await window.__idb.get('stations', id);
      await window.__idb.put('stations', { ...st, talkOverIntro: true, updatedAt: Date.now() });
      await window.__hostcaster.radio.reload();
    }, stationId);
  }
  if (process.env.SEEK === '1' && s.ready && s.status === 'playing' && s.ref !== seekedFor && s.dur > 20_000 && s.dur - s.pos > 12_000) {
    seekedFor = s.ref;
    await page.evaluate((ms) => window.__hostcaster.player.seek(ms), s.dur - 8000);
  }
  const allPlayed = playable.every((id) => s.started.includes(id));
  if ((allPlayed && s.breaks >= playable.length - 1 && s.phase === 'music') || Date.now() - t0 > MAX_MS) break;
  if (s.status === 'paused' && Date.now() - t0 > 60_000) {
    await wait(20_000); // give a stalled player a last chance, then stop measuring
    const st = await page.evaluate(() => window.__hostcaster.player.state.status);
    if (st === 'paused') break;
  }
}
await page.screenshot({ path: join(shots, 'yt-radio-end.png') });
const ev = await page.evaluate(() => window.__lab.ev);
const toasts = await page.locator('[role=status], [role=alert], .aw-toast').allInnerTexts().catch(() => []);
await page.evaluate(() => window.__hostcaster.radio.stop());

// ---- per transition: song end -> ident / first host word, host done -> next song playing ------------------------
const at = (from, pred) => ev.find((e) => e.at >= from && pred(e));
const transitions = [];
for (const end of ev.filter((e) => e.ev === 'trackend')) {
  const nextPlay = at(end.at, (e) => e.ev === 'yt-play' && e.id !== end.id);
  const sting = at(end.at, (e) => e.ev === 'audio-on');
  const line0 = at(end.at, (e) => e.ev === 'line');
  const back = at(end.at + 1, (e) => e.ev === 'phase-music');
  // a line in this device's voice (stand-in) is spoken without an audio element: its line event is the voice
  const audio = line0 ? at(line0.at, (e) => e.ev === 'audio-on') : undefined;
  const voice = audio && (!back || audio.at <= back.at) ? audio : line0;
  const lastOff = back ? ([...ev].reverse().find((e) => e.ev === 'audio-off' && e.at <= back.at && e.at > (line0?.at ?? end.at)) ?? back) : undefined;
  transitions.push({
    after: end.id,
    prepared: end.ready,
    endToSting: sting ? sting.at - end.at : null,
    endToVoice: voice ? voice.at - end.at : null,
    endToNextSong: nextPlay ? nextPlay.at - end.at : null,
    hostEndToNextSong: nextPlay && lastOff && line0 && line0.at < (nextPlay?.at ?? 0) + 60000 ? nextPlay.at - lastOff.at : null,
    talkOver: Boolean(nextPlay && lastOff && nextPlay.at < lastOff.at),
  });
}
const preps = ev.filter((e) => e.ev === 'prep-done');
const allClips = ev.filter((e) => e.ev === 'clips-done').map((e) => e.ms);
console.log('transitions', JSON.stringify(transitions));
console.log('preps', JSON.stringify(preps.map((p, i) => ({ readyMs: p.ms, writeMs: p.writeMs, allClipsMs: allClips[i], lines: p.lines, standIn: p.standIn }))));

const started = [...new Set(ev.filter((e) => e.ev === 'trackstart').map((e) => e.id))];
const errorsSeen = ev.filter((e) => e.ev === 'error').map((e) => e.msg);
check('every playable video played, unattended', playable.every((id) => started.includes(id)), `${started.length}/${playable.length}: ${started.join(' ')}`);
check('the embedding-off video never started', !started.includes(BAD));
if (!LEGACY) check('the embedding-off video was skipped with a short note', ev.some((e) => e.ev === 'skipped' && e.id === BAD), ev.find((e) => e.ev === 'skipped')?.reason);
const names = ev.filter((e) => e.ev === 'break').map((e) => e.after);
check('no break announced the embedding-off video', !names.some((n) => /embedding off/.test(n)), names.join(' | '));
check('no "did not start playing" for playable videos', !errorsSeen.some((m) => /did not start playing/.test(m)) && !toasts.some((t) => /did not start playing/.test(t)), errorsSeen.join(' | '));
check('a break after every song', ev.filter((e) => e.ev === 'break').length >= playable.length - 1, `${ev.filter((e) => e.ev === 'break').length} breaks`);
const ready = transitions.filter((t) => t.prepared && t.endToVoice !== null);
check(`prepared breaks: song end -> host voice < ${BUDGET.endToVoiceMs} ms`, ready.length > 0 && ready.every((t) => t.endToVoice < BUDGET.endToVoiceMs), ready.map((t) => t.endToVoice).join(', '));
const plain = transitions.filter((t) => !t.talkOver && t.hostEndToNextSong !== null);
check(`host done -> next song playing < ${BUDGET.hostEndToSongMs} ms`, plain.length > 0 && plain.every((t) => t.hostEndToNextSong < BUDGET.hostEndToSongMs), plain.map((t) => t.hostEndToNextSong).join(', '));
const over = transitions.filter((t) => t.talkOver);
check('talk over the intro: the next song starts under the last line', LEGACY || over.length > 0, `${over.length} breaks`);
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

writeFileSync(out, JSON.stringify({ base, transitions, preps, ev, results }, null, 1));
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
