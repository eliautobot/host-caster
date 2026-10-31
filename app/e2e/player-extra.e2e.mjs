// Player + library, second pass: voice with nothing loaded, drag and drop, folder import, crossfade, long breaks
// (maxMs), delete + storage, the server library (signed in), light theme screens. Usage:
//   node e2e/player-extra.e2e.mjs [baseUrl] [mediaDir]
// baseUrl: a Host-Caster server serving the build with MUSIC_DIR set; mediaDir: made by e2e/fixtures/make-media.sh player.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8662';
const media = process.argv[3] ?? '/tmp/hostcaster-e2e/player-media'; // make it: e2e/fixtures/make-media.sh player
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
mkdirSync(shots, { recursive: true });

const SONGS = ['01 Morning Light.mp3', '02 Coffee Run.mp3', '03 Late Train.mp3', '04 Neon Harbor.m4a', '05 Salt Air.flac', '06 Static Bloom.mp3'];
const results = [];
const errors = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
  console.log(results.at(-1));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (page, fn, arg, timeout = 15000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(
    () => true,
    () => false,
  );
const P = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => P(page, () => window.__hostcaster.player.state);
const levels = (page) => P(page, () => window.__hostcaster.player.levels());
const shot = (page, name) => page.screenshot({ path: join(shots, `player-${name}.png`) });
const rows = (page) => page.locator('.aw-track').count();
const watchErrors = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${tag}: ${m.text()}`));
};
async function setTheme(page, label) {
  await page.goto(`${base}/#/settings/appearance`);
  await page.getByRole('tab', { name: label }).click();
  await wait(300);
}
async function playRow(page, title) {
  await page.locator('.aw-track', { hasText: title }).first().locator('.aw-track__main').click();
  return until(page, (t) => window.__hostcaster.player.state.track?.title === t && window.__hostcaster.player.state.status === 'playing', title);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

// ------------------------------------------------------------------------------------------------ desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  watchErrors(page, 'desktop');
  await page.goto(`${base}/#/library`);
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor();

  // 1. a voice clip with nothing loaded (call-in before the first song)
  const voice = await P(page, async () => {
    const sr = 22050;
    const n = Math.round(sr * 1.4);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / sr) * 2 * Math.PI * 440) * 9000, true);
    const p = window.__hostcaster.player;
    const t0 = performance.now();
    const done = p.playVoice(new Blob([buf], { type: 'audio/wav' }));
    await new Promise((r) => setTimeout(r, 400));
    const mid = { ...p.levels(), status: p.state.status };
    await done;
    return { mid, ms: Math.round(performance.now() - t0), after: p.levels().voicePlaying };
  });
  check(
    'voice clip plays with nothing loaded',
    voice.mid.voicePlaying && voice.mid.status === 'idle' && voice.mid.context === 'running' && voice.ms > 1200 && !voice.after,
    `${voice.ms} ms, ${JSON.stringify(voice.mid)}`,
  );

  // the empty library leads to the music services too
  await page.getByRole('button', { name: /Music services/ }).click();
  check('empty library: Music services opens its settings', await until(page, () => location.hash.includes('/settings/music-services'), undefined, 5000));
  await page.goto(`${base}/#/library`);
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor();

  // 2. drag and drop two songs onto the window
  const dropFiles = SONGS.slice(0, 2).map((name) => ({ name, b64: readFileSync(join(media, name)).toString('base64') }));
  const dt = await page.evaluateHandle((files) => {
    const d = new DataTransfer();
    for (const f of files) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      d.items.add(new File([bin], f.name, { type: 'audio/mpeg' }));
    }
    return d;
  }, dropFiles);
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
  await page.dispatchEvent('body', 'dragover', { dataTransfer: dt });
  await wait(250);
  const overlay = await page.locator('.aw-drop').isVisible();
  await shot(page, 'drop-desktop');
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  check('drop overlay shows', overlay);
  check('drag and drop imports', await until(page, () => document.querySelectorAll('.aw-track').length === 2, undefined, 20000), `${await rows(page)} rows`);

  // signed out: no server library entry
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await wait(250);
  check('signed out: no server library option', (await page.getByRole('menuitem', { name: 'Sync server library' }).count()) === 0);
  check('Add music lists the music services', await page.getByRole('menuitem', { name: 'From a music service' }).isVisible());
  await page.keyboard.press('Escape');

  // 3. a whole folder (sub folders walked; covers, playlists and copies skipped)
  await page.locator('[data-testid=pick-folder]').setInputFiles(media);
  const folderOk = await until(page, () => document.querySelectorAll('.aw-track').length === 7 && !document.querySelector('.aw-import'), undefined, 40000);
  const toasts = (await page.locator('.aw-toast').allInnerTexts()).join(' || ').replace(/\n/g, ' ');
  check('folder import adds the rest, skips copies', folderOk, `${await rows(page)} rows; ${toasts}`);

  // 4. crossfade from Settings -> Playback
  await page.goto(`${base}/#/settings/playback`);
  await page.getByRole('switch', { name: 'Crossfade songs' }).click();
  await wait(300);
  await shot(page, 'settings-playback-desktop');
  check('crossfade on (6 s default)', (await P(page, () => window.__hostcaster.player.crossfade)) === 6000);
  await page.goto(`${base}/#/library`);
  // the first row, so a next song exists (repeat is off)
  await page.locator('.aw-track').first().locator('.aw-track__main').click();
  await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.index === 0);
  const first = await state(page);
  await P(page, (d) => window.__hostcaster.player.seek(d - 9000), first.durationMs);
  const switched = await until(page, (t) => window.__hostcaster.player.state.track?.title !== t, first.track.title, 9000);
  await wait(1500);
  const mid = await P(page, () => {
    const p = window.__hostcaster.player;
    return p.decks.map((d) => ({ gain: d.gainValue, playing: d.element ? !d.element.paused : false, t: d.element?.currentTime }));
  });
  const both = mid.filter((d) => d.playing).length === 2 && mid.some((d) => d.gain > 0.05 && d.gain < 0.95);
  await wait(6000);
  const end = await P(page, () => window.__hostcaster.player.decks.map((d) => ({ gain: d.gainValue, playing: d.element ? !d.element.paused : false })));
  check('crossfade: next song starts while the last one fades', switched && both, JSON.stringify(mid));
  check('crossfade: old deck stops after the fade', end.filter((d) => d.playing).length === 1 && end.some((d) => d.playing && d.gain > 0.95), JSON.stringify(end));
  await P(page, () => window.__hostcaster.player.setCrossfade(0));

  // 5. a long break with its own maxMs: runs past the song, then the player moves on by itself
  const cur = await state(page);
  const hold = await P(page, async (d) => {
    const p = window.__hostcaster.player;
    const beat = setInterval(() => p.markActivity(), 1000);
    let aborted = '';
    p.holdAfterCurrent((signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = String(signal.reason)))), { maxMs: 4000 });
    p.seek(d - 1200);
    const t0 = performance.now();
    while (!p.state.holding && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    const heldAt = performance.now();
    while (p.state.holding && performance.now() - heldAt < 10000) await new Promise((r) => setTimeout(r, 50));
    clearInterval(beat);
    await new Promise((r) => setTimeout(r, 500));
    return { held: Math.round(performance.now() - heldAt - 500), aborted, status: p.state.status, title: p.state.track?.title };
  }, cur.durationMs);
  check('break with maxMs 4 s is cut at 4 s, next song plays', hold.held > 3500 && hold.held < 5500 && hold.aborted === 'timeout' && hold.status === 'playing' && hold.title !== cur.track.title, JSON.stringify(hold));

  // 6. delete a song: row, file and storage go
  await P(page, () => window.__hostcaster.player.pause());
  const sizeBefore = await page.locator('.aw-page__subtitle, .aw-page-header__subtitle').first().innerText().catch(() => '');
  await page.locator('.aw-track', { hasText: 'untagged-demo-tone' }).getByRole('button', { name: /More for/ }).click();
  await page.getByRole('menuitem', { name: 'Delete from this device' }).click();
  await wait(300);
  await shot(page, 'delete-confirm-desktop');
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).click();
  const gone = await until(page, () => ![...document.querySelectorAll('.aw-track')].some((r) => r.textContent.includes('untagged-demo-tone')));
  await wait(800);
  const sizeAfter = await page.locator('.aw-page__subtitle, .aw-page-header__subtitle').first().innerText().catch(() => '');
  check('delete removes the song and frees storage', gone && (await rows(page)) === 6 && sizeBefore !== sizeAfter, `${sizeBefore} -> ${sizeAfter}`);

  // 6b. Media Session, talk over intro, shuffle/repeat keys, queue edits, search, artist page
  await page.locator('.aw-track').first().locator('.aw-track__main').click();
  await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.index === 0);
  await wait(400);
  const msess = await P(page, () => ({
    title: navigator.mediaSession.metadata?.title,
    art: navigator.mediaSession.metadata?.artwork?.length ?? 0,
    state: navigator.mediaSession.playbackState,
    now: window.__hostcaster.player.state.track?.title,
  }));
  check('Media Session: metadata + playing', msess.title === msess.now && msess.state === 'playing', JSON.stringify(msess));

  const intro = await P(page, async () => {
    const wav = (sec, hz) => {
      const sr = 22050;
      const n = Math.round(sr * sec);
      const v = new DataView(new ArrayBuffer(44 + n * 2));
      const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      str(0, 'RIFF');
      v.setUint32(4, 36 + n * 2, true);
      str(8, 'WAVEfmt ');
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, sr, true);
      v.setUint32(28, sr * 2, true);
      v.setUint16(32, 2, true);
      v.setUint16(34, 16, true);
      str(36, 'data');
      v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / sr) * 2 * Math.PI * hz) * 9000, true);
      return new Blob([v.buffer], { type: 'audio/wav' });
    };
    const p = window.__hostcaster.player;
    const first = p.state.track.title;
    const seen = {};
    p.holdAfterCurrent(async () => {
      await p.playVoice(wav(0.8, 330));
      await p.introNext(0.2);
      const v2 = p.playVoice(wav(1.6, 440));
      await new Promise((r) => setTimeout(r, 700));
      seen.during = { title: p.state.track?.title, status: p.state.status, music: p.levels().music, voice: p.levels().voicePlaying };
      await v2;
    });
    p.seek(p.state.durationMs - 1000);
    const t0 = performance.now();
    while (!p.state.holding && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
    while (p.state.holding && performance.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 900));
    return { first, ...seen, after: { title: p.state.track?.title, pos: Math.round(p.state.positionMs), music: p.levels().music } };
  });
  check(
    'talk over intro: next song starts ducked under the voice, then unducks',
    intro.during?.title !== intro.first && intro.during?.status === 'playing' && Math.abs(intro.during.music - 0.2) < 0.03 && intro.during.voice && Math.abs(intro.after.music - 1) < 0.03 && intro.after.pos > 1500,
    JSON.stringify(intro),
  );

  await P(page, () => document.activeElement?.blur());
  const order = (await state(page)).queue.map((t) => t.id).join();
  await page.keyboard.press('s');
  const sh = await state(page);
  await page.keyboard.press('s');
  const unsh = await state(page);
  check('S toggles shuffle (current song kept, order restored)', sh.shuffle && sh.track.id === unsh.track.id && sh.queue[sh.index].id === sh.track.id && unsh.queue.map((t) => t.id).join() === order && !unsh.shuffle);
  const reps = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('r');
    reps.push((await state(page)).repeat);
  }
  check('R cycles repeat', reps.join() === 'all,one,off', reps.join());

  const cur2 = await state(page);
  const pick = cur2.queue.at(-1).title;
  await page.locator('.aw-track', { hasText: pick }).first().getByRole('button', { name: /More for/ }).click();
  await page.getByRole('menuitem', { name: 'Play next' }).click();
  await wait(300);
  const pn = await state(page);
  check('Play next puts the song right after the current one', pn.queue[pn.index + 1]?.title === pick, pn.queue.map((t) => t.title).join(' > '));
  await page.goto(`${base}/#/now-playing`);
  await page.getByRole('button', { name: `Remove ${pick} from the queue` }).first().click();
  await wait(300);
  const rq = await state(page);
  check('remove from the queue', rq.queue[rq.index + 1]?.title !== pick && rq.queue.length === pn.queue.length - 1, `${pn.queue.length} -> ${rq.queue.length}`);
  await page.getByRole('button', { name: 'Close' }).first().click();

  await page.goto(`${base}/#/library`);
  await page.getByPlaceholder('Search your library').fill('harbor');
  await wait(300);
  const found = await page.locator('.aw-track').allInnerTexts();
  check('library search (title, album)', found.length === 2 && found.every((t) => /Harbor/.test(t)), `${found.length} rows`);
  await page.getByPlaceholder('Search your library').fill('');
  await page.goto(`${base}/#/library?tab=artists`);
  await page.getByRole('link', { name: /The Quiet Tides/ }).first().click();
  await page.getByRole('heading', { name: 'The Quiet Tides' }).waitFor({ timeout: 5000 }).catch(() => undefined);
  await wait(500);
  await shot(page, 'artist-desktop');
  check('artist page lists their songs', (await page.locator('.aw-track').count()) === 2);
  await P(page, () => window.__hostcaster.player.pause());

  // 7. the server library: sign in (local account), sync, play a server song through Web Audio, seek (Range)
  const email = `player-${Date.now()}@example.test`;
  const signup = await P(
    page,
    async (body) => {
      const r = await fetch('/api/auth/local/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'X-HostCaster': '1' }, body: JSON.stringify(body) });
      return r.status;
    },
    { email, password: 'correct horse battery staple', name: 'Player Test', app: false },
  );
  await page.goto(`${base}/#/library`);
  await page.reload();
  await page.locator('.aw-track').first().waitFor();
  const synced = await until(page, () => [...document.querySelectorAll('.aw-library__sources button')].some((b) => b.textContent === 'Server'), undefined, 8000);
  if (!synced) {
    const btn = page.getByRole('button', { name: 'Show its songs' });
    if (await btn.isVisible().catch(() => false)) await btn.click();
  }
  const hasServer = await until(page, () => [...document.querySelectorAll('.aw-library__sources button')].some((b) => b.textContent === 'Server'), undefined, 10000);
  check('signed in: server songs synced', signup < 300 && hasServer, `signup ${signup}, auto ${synced}`);
  await page.locator('.aw-library__sources').getByRole('button', { name: 'Server' }).click();
  await wait(400);
  await shot(page, 'server-library-desktop');
  const serverRows = await rows(page);
  check('server filter lists its 2 songs', serverRows === 2, `${serverRows} rows`);
  const srvPlaying = await playRow(page, 'Salt Air');
  await wait(800);
  const srv = await state(page);
  const srvLv = await levels(page);
  check('server song plays through Web Audio', srvPlaying && srv.track.source === 'server' && srvLv.routed === true && srv.positionMs > 300, `${srv.track?.source} @ ${Math.round(srv.positionMs)} routed ${srvLv.routed}`);
  await P(page, () => window.__hostcaster.player.seek(15000));
  await wait(1200);
  const srv2 = await state(page);
  check('server song seeks (Range)', srv2.positionMs > 15000 && srv2.positionMs < 18000 && srv2.status === 'playing', `${Math.round(srv2.positionMs)}`);

  // light theme, desktop
  await setTheme(page, 'Light');
  await page.goto(`${base}/#/library`);
  await wait(700);
  await shot(page, 'library-songs-desktop-light');
  await page.goto(`${base}/#/library?tab=albums`);
  await wait(500);
  await shot(page, 'library-albums-desktop-light');
  await page.goto(`${base}/#/now-playing`);
  await wait(900);
  await shot(page, 'nowplaying-desktop-light');
  await page.goto(`${base}/#/settings/playback`);
  await wait(500);
  await shot(page, 'settings-playback-desktop-light');
  await P(page, () => window.__hostcaster.player.pause());
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ phone, light
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await ctx.newPage();
  watchErrors(page, 'phone');
  await setTheme(page, 'Light');
  await page.goto(`${base}/#/library`);
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor();
  await wait(400);
  await shot(page, 'library-empty-phone-light');
  await page.locator('[data-testid=pick-files]').setInputFiles(SONGS.map((s) => join(media, s)));
  check('phone light: import', await until(page, () => document.querySelectorAll('.aw-track').length === 6, undefined, 30000));
  await wait(700);
  await shot(page, 'library-songs-phone-light');
  await page.locator('.aw-track', { hasText: 'Static Bloom' }).locator('.aw-track__main').tap();
  check('phone light: plays', await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 400));
  await wait(400);
  await shot(page, 'mini-phone-light');
  await page.getByRole('button', { name: 'Open Now Playing' }).tap();
  await wait(900);
  await shot(page, 'nowplaying-phone-light');
  await page.getByRole('tab', { name: 'Up next' }).tap();
  await wait(400);
  await shot(page, 'queue-phone-light');
  await page.getByRole('button', { name: 'Close' }).first().tap();
  await page.goto(`${base}/#/settings/playback`);
  await wait(500);
  await shot(page, 'settings-playback-phone-light');
  check('phone: shortcuts card hidden', (await page.getByText('Keyboard shortcuts', { exact: true }).count()) === 0);
  await setTheme(page, 'Dark');
  await page.goto(`${base}/#/settings/playback`);
  await wait(400);
  await shot(page, 'settings-playback-phone');
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ on air (radio)
// The starter station on air over the library: Now Playing must keep its controls on screen with the on-air strip
// and a long station queue, and a break must hand back to music.
for (const [w, h, tag] of [
  [390, 844, 'phone'],
  [1440, 900, 'desktop'],
]) {
  const phone = tag === 'phone';
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone, colorScheme: 'dark' });
  const page = await ctx.newPage();
  watchErrors(page, `onair-${tag}`);
  await page.goto(`${base}/#/library`);
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor();
  await page.locator('[data-testid=pick-files]').setInputFiles(SONGS.map((s) => join(media, s)));
  await until(page, () => document.querySelectorAll('.aw-track').length === 6, undefined, 30000);
  const station = await P(page, async () => {
    const r = window.__hostcaster.radio;
    const id = r.state.stationId ?? 'seed-station-881';
    await r.start(id);
    return id;
  });
  const onAir = await until(page, () => window.__hostcaster.radio.state.onAir && window.__hostcaster.player.state.status === 'playing', undefined, 15000);
  await page.goto(`${base}/#/now-playing`);
  await wait(1000);
  await shot(page, `onair-nowplaying-${tag}`);
  const ctl = await page.locator('.aw-np .aw-transport--lg').boundingBox();
  const strip = await page.locator('.aw-np .aw-onair--sheet').boundingBox().catch(() => null);
  const art = await page.locator('.aw-np__art').boundingBox();
  const fits = art && art.y >= 40 && ctl && ctl.y > 0 && ctl.y + ctl.height < h && (!strip || strip.y + strip.height < h);
  check(`${tag}: on air, Now Playing keeps controls + on-air strip on screen`, onAir && fits, `station ${station}, art top ${art && Math.round(art.y)}, transport ${ctl && Math.round(ctl.y + ctl.height)}, strip ${strip && Math.round(strip.y + strip.height)} of ${h}`);
  await P(page, () => window.__hostcaster.player.seek(window.__hostcaster.player.state.durationMs - 1500));
  const held = await until(page, () => window.__hostcaster.player.state.holding, undefined, 10000);
  await wait(800);
  await shot(page, `onair-break-${tag}`);
  const back = await until(page, () => !window.__hostcaster.player.state.holding && window.__hostcaster.player.state.status === 'playing', undefined, 90000);
  check(`${tag}: a break airs, then the music comes back`, held && back);
  // no AI brain on the starter hosts: the scripted fallback spoke, Home says so with Connect, each host card says why
  const last = await P(page, () => window.__hostcaster.radio.state.lastBreak);
  check(`${tag}: no AI brain -> the scripted fallback wrote the break`, Boolean(last?.lines?.length), last?.lines?.map((l) => l.text).join(' / ').slice(0, 100));
  await page.goto(`${base}/#/`);
  const banner = page.locator('[data-fallback-banner]');
  check(`${tag}: Home banner "reading scripted lines" with Connect`, await banner.waitFor({ timeout: 8000 }).then(() => true, () => false) && /reading scripted lines/.test((await banner.textContent()) ?? '') && (await banner.getByRole('button', { name: 'Connect' }).isVisible()));
  check(`${tag}: host cards say they read scripted lines`, (await page.locator('[data-noai]').count()) > 0);
  await shot(page, `onair-fallback-home-${tag}`);
  await P(page, () => window.__hostcaster.radio.stop());
  await ctx.close();
}

await browser.close();
console.log(`\n${results.length - failed}/${results.length} passed`);
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
process.exitCode = failed || errors.length ? 1 : 0;
