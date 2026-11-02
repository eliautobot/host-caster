// Radio end-to-end on a built app with a real local brain and voice. Usage:
//   node e2e/radio.e2e.mjs [baseUrl] [mediaDir]
// env: BRAIN_URL (OpenAI-compatible, e.g. Ollama .../v1), BRAIN_MODEL, VOICE_URL (OpenAI-compatible TTS, e.g. Kokoro
// .../v1), VOICE_A / VOICE_B (voice ids for the two hosts), SHOTS (screenshot dir), OUT (result JSON).
// mediaDir holds two tagged songs (any length under ~60 s keeps the run short).
// Flow: connect brain + voice in Settings, give Maya and Jules that brain and voice, import the songs, go on air,
// follow the opening break between song 1 and 2 (captions, talk over intro), then a typed call-in, then history.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8663';
const media = process.argv[3] ?? '/tmp/hostcaster-e2e/radio-media'; // make it: e2e/fixtures/make-media.sh radio
const BRAIN_URL = process.env.BRAIN_URL ?? 'http://localhost:11434/v1';
const BRAIN_MODEL = process.env.BRAIN_MODEL ?? 'llama3.2';
const VOICE_URL = process.env.VOICE_URL ?? 'http://localhost:8880/v1';
const VOICE_A = process.env.VOICE_A ?? 'af_heart';
const VOICE_B = process.env.VOICE_B ?? 'am_michael';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
const out = process.env.OUT ?? '/tmp/hostcaster-radio-e2e/result.json';
mkdirSync(shots, { recursive: true });

const results = [];
const errors = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
  console.log(results.at(-1));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: join(shots, `radio-${name}.png`) });
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/Failed to load resource|401/.test(t)) errors.push(t);
  if (/\[hostcaster\]/.test(t)) console.log(`  console ${secs()}s: ${t.slice(0, 200)}`);
});
const calls = { brain: [], voice: [] };
page.on('response', (r) => {
  const u = r.url();
  if (u.startsWith(BRAIN_URL) && u.includes('/chat/completions')) calls.brain.push(r.status());
  if (u.startsWith(VOICE_URL) && u.includes('/audio/speech')) calls.voice.push(r.status());
});

// ------------------------------------------------------------------------------------------------ brain
// no AI yet: Home says the hosts read scripted lines, Brains offers no "built-in host" to pick
await page.goto(`${base}/#/welcome`);
await page.getByRole('button', { name: 'Skip setup' }).click();
await page.waitForURL(/#\/$/);
check('no AI yet: Home banner, scripted lines', await page.locator('[data-fallback-banner]').waitFor({ timeout: 15000 }).then(() => true, () => false));
await page.goto(`${base}/#/settings/brains`);
const note = await page.locator('[data-fallback-note]').waitFor({ timeout: 10000 }).then(() => true, () => false);
check('Brains: no built-in host entry, the scripted fallback explained', note && (await page.getByText(/Built-in host/i).count()) === 0);
await page.getByRole('button', { name: 'Add a brain' }).click();
await page.getByRole('button', { name: /^Ollama/ }).click();
await page.getByLabel('Server address').fill(BRAIN_URL);
await page.getByRole('button', { name: 'Load models' }).click();
await page.getByRole('combobox', { name: 'Model' }).waitFor({ timeout: 20000 });
await page.getByRole('combobox', { name: 'Model' }).selectOption(BRAIN_MODEL);
await page.getByRole('button', { name: 'Test' }).click();
const tested = await page.locator('.aw-statusline--ok').waitFor({ timeout: 90000 }).then(() => true, () => false);
check('brain test answers', tested, (await page.locator('.aw-statusline').first().textContent().catch(() => ''))?.slice(0, 120));
await shot(page, 'e2e-brain-sheet');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByText(/Ollama/).first().waitFor();
check('the first AI goes to every host that had none', await page.getByText(/now think with it/).first().waitFor({ timeout: 8000 }).then(() => true, () => false));
await page.goto(`${base}/#/`);
await wait(1200);
check('with an AI the Home banner is gone', !(await page.locator('[data-fallback-banner]').isVisible()) && (await page.locator('[data-noai]').count()) === 0);

// ------------------------------------------------------------------------------------------------ voice
await page.goto(`${base}/#/settings/voices`);
await page.getByRole('button', { name: 'Add a voice engine' }).click();
await page.getByRole('button', { name: /^Kokoro/ }).click();
await page.getByLabel('Server address').fill(VOICE_URL);
await wait(300);
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.locator('.aw-entry__title', { hasText: 'Kokoro' }).waitFor();
check('voice engine saved', true);

// ------------------------------------------------------------------------------------------------ hosts
for (const [id, voice] of [
  ['seed-host-maya', VOICE_A],
  ['seed-host-jules', VOICE_B],
]) {
  await page.goto(`${base}/#/hosts/${id}`);
  const brainSel = page.getByRole('combobox', { name: 'Brain' });
  await brainSel.waitFor();
  const ollama = (await brainSel.locator('option:not([disabled])').allTextContents()).find((l) => /Ollama/.test(l));
  await brainSel.selectOption({ label: ollama });
  if (id === 'seed-host-maya') check('host Brain picker: AI brains only', !(await brainSel.locator('option').allTextContents()).some((l) => /built-?in/i.test(l)));
  await page.getByRole('combobox', { name: 'Speech engine' }).selectOption({ label: 'Kokoro' });
  const voiceSel = page.getByRole('combobox', { name: 'Voice', exact: true });
  await page.waitForFunction((v) => [...document.querySelectorAll('option')].some((o) => o.value === v), voice, { timeout: 20000 });
  await voiceSel.selectOption(voice);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('All changes saved').or(page.getByRole('button', { name: /Delete host/ })).first().waitFor();
  await wait(300);
}
check('hosts use the brain and voice', true);

// ------------------------------------------------------------------------------------------------ songs + station
await page.goto(`${base}/#/library`);
const files = readdirSync(media).filter((f) => /\.(mp3|m4a|flac|ogg|wav)$/i.test(f)).sort().map((f) => join(media, f));
await page.locator('[data-testid=pick-files]').setInputFiles(files);
const imported = await page.waitForFunction((n) => document.querySelectorAll('.aw-track').length >= n, files.length, { timeout: 30000 }).then(() => true, () => false);
check('songs imported', imported, `${files.length} files`);

await page.goto(`${base}/#/stations/seed-station-881`);
await page.getByRole('switch', { name: 'Shuffle' }).click();
// a break after every song: two breaks back to back test the talk-over-intro hand-off
await page.getByRole('slider', { name: 'Talk every' }).focus();
await page.keyboard.press('Home');
// talk mix Music: every break names the song that just played too (the default leans to the listener's day and
// back-announces only one break in three)
await page.getByRole('slider', { name: 'Talk mix' }).focus();
await page.keyboard.press('Home');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await wait(500);

// ------------------------------------------------------------------------------------------------ on air
await page.goto(`${base}/#/`);
await page.evaluate(() => {
  const w = window;
  w.__breaks = [];
  w.__hostcaster.radio.on('break', (b) => w.__breaks.push(b));
});
await page.getByRole('region', { name: 'Your station' }).getByRole('button', { name: 'Go on air' }).click();
const startedAt = Date.now();
const timeline = [];
let shotsTaken = 0;
let introOverlap = false;
let lastKey = '';
let afterFirst;
let secondStart;
while (Date.now() - startedAt < 240_000) {
  const s = await page.evaluate(() => {
    const r = window.__hostcaster.radio.state;
    const p = window.__hostcaster.player.state;
    return { phase: r.phase, line: r.lineIndex, caption: r.caption, speaking: r.speakingHostId, notice: r.notice, index: p.index, status: p.status, title: p.track?.title, breaks: window.__breaks.length, lines: r.script?.length };
  });
  const key = `${s.phase}|${s.line}|${s.index}|${s.breaks}`;
  if (key !== lastKey) {
    lastKey = key;
    timeline.push({ t: secs(), ...s });
    console.log(`  ${secs()}s ${s.phase} line=${s.line ?? '-'} track=${s.index}:${s.title} ${s.status}${s.caption ? ` "${s.caption.slice(0, 70)}"` : ''}${s.notice ? ` NOTICE ${s.notice}` : ''}`);
  }
  if (s.phase === 'talking' && s.index === 1 && s.line === (s.lines ?? 0) - 1) introOverlap = true;
  if (s.phase === 'talking' && s.caption) {
    if (shotsTaken === 0) {
      await shot(page, 'e2e-onair-home-desktop');
      shotsTaken++;
    } else if (shotsTaken === 1 && s.line >= 1) {
      await page.goto(`${base}/#/now-playing`);
      await wait(400);
      await shot(page, 'e2e-onair-nowplaying-desktop');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/#/`);
      await wait(400);
      await shot(page, 'e2e-onair-home-phone');
      await page.goto(`${base}/#/now-playing`);
      await wait(400);
      await shot(page, 'e2e-onair-nowplaying-phone');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/#/`);
      shotsTaken++;
    }
  }
  if (s.breaks >= 1 && s.phase === 'music' && !afterFirst) {
    afterFirst = { ...(await page.evaluate(() => window.__hostcaster.player.state)), at: Date.now() };
  }
  if (s.breaks >= 1 && s.phase === 'talking' && afterFirst && !secondStart) secondStart = { at: Date.now(), index: s.index };
  if (s.breaks >= 2 && s.phase === 'music') break;
  await wait(150);
}
const first = await page.evaluate(() => window.__breaks[0]);
const songOne = timeline.find((x) => x.index === 0 && x.title)?.title ?? '';
const songTwo = timeline.find((x) => x.index === 1 && x.title)?.title ?? '';
check('opening break aired', Boolean(first), first ? `${first.lines.length} lines` : timeline.at(-1)?.notice ?? 'none');
if (first) {
  const voices = new Set(first.lines.map((l) => l.hostId));
  check('both hosts talk', voices.size >= 2, [...voices].join(','));
  check('break sits between song 1 and 2', first.songBefore?.title === songOne && first.songAfter?.title === songTwo, `${first.songBefore?.title} -> ${first.songAfter?.title}`);
  const text = first.lines.map((l) => l.text).join(' ');
  check('song that played is back-announced (talk mix: Music)', text.toLowerCase().includes(songOne.toLowerCase()));
  check('next song introduced', text.toLowerCase().includes(songTwo.toLowerCase()));
  const all = (await page.evaluate(() => window.__breaks)).flatMap((b) => b.lines.map((l) => l.text)).join(' ');
  check('no made-up songs', !/midnight city|m83|fleetwood/i.test(all));
  check('no markdown or emoji in lines', !/[*#_`]|\p{Extended_Pictographic}/u.test(text));
}
check('captions shown while talking', timeline.some((x) => x.phase === 'talking' && x.caption), `${timeline.filter((x) => x.phase === 'talking').length} line changes`);
check('talk over intro (song 2 starts under the last line)', introOverlap);
check('brain calls ok', calls.brain.length > 0 && calls.brain.every((s) => s === 200), calls.brain.join(','));
check('voice calls ok', calls.voice.length > 0 && calls.voice.every((s) => s === 200), `${calls.voice.length} clips`);
check('music resumes with song 2', afterFirst?.status === 'playing' && afterFirst?.track?.title === songTwo, `${afterFirst?.status} ${afterFirst?.track?.title}`);
const second = await page.evaluate(() => window.__breaks[1]);
check('second break after song 2 (talk every song)', second?.songBefore?.title === songTwo, `${second?.songBefore?.title} -> ${second?.songAfter?.title}`);
const gap = secondStart && afterFirst ? (secondStart.at - afterFirst.at) / 1000 : 0;
check('second break waits for song 2 to end', gap >= 12, `${gap.toFixed(1)} s of music between breaks`);
check('second break is not another opening', Boolean(second) && !/welcome to/i.test(second.lines[0]?.text ?? ''), second?.lines[0]?.text.slice(0, 60));

// ------------------------------------------------------------------------------------------------ call-in
await page.goto(`${base}/#/`);
// Home offers the live call and the chat (e2e/call.e2e.mjs); the on-air call-in below is what AI apps and MCP use
check('Home offers Call and Message', (await page.getByRole('button', { name: 'Call the station' }).count()) > 0 && (await page.getByRole('button', { name: /Message the hosts/ }).count()) > 0);
await shot(page, 'e2e-callin-desktop');
void page.evaluate((s) => window.__hostcaster.radio.talkNow(s).catch(() => undefined), 'Shout-out to my sister Ana, she just got a new job as a nurse!');
const callStart = Date.now();
let callShot = false;
while (Date.now() - callStart < 90_000) {
  const s = await page.evaluate(() => ({ phase: window.__hostcaster.radio.state.phase, caption: window.__hostcaster.radio.state.caption, callin: window.__breaks.some((b) => b.topics.includes('callin')) }));
  if (s.phase === 'talking' && s.caption && !callShot) {
    callShot = true;
    await shot(page, 'e2e-callin-onair-desktop');
  }
  if (s.callin && s.phase === 'music') break;
  await wait(200);
}
const call = await page.evaluate(() => window.__breaks.find((b) => b.topics.includes('callin')));
check('call-in answered on air', Boolean(call) && call.topics.includes('callin'), call ? `${call.lines.length} lines in ${((Date.now() - callStart) / 1000).toFixed(1)} s` : 'none');
if (call) check('call-in mentions Ana', /ana/i.test(call.lines.map((l) => l.text).join(' ')));

// ------------------------------------------------------------------------------------------------ song request
{
  const st = await page.evaluate(() => {
    const p = window.__hostcaster.player.state;
    return { cur: p.track?.title, next: p.queue[p.index + 1]?.title, titles: [...new Set(p.queue.map((t) => t.title))] };
  });
  const want = st.titles.find((t) => t !== st.cur && t !== st.next);
  if (!want) check('song request (needs 3 songs in the media dir)', false, st.titles.join(', '));
  else {
    void page.evaluate((s) => window.__hostcaster.radio.talkNow(s).catch(() => undefined), `Could you play ${want} next?`);
    const t1 = Date.now();
    let req;
    while (Date.now() - t1 < 90_000 && !req) {
      req = await page.evaluate(() => window.__breaks.filter((b) => b.topics.includes('callin'))[1]);
      await wait(250);
    }
    const queued = await page.evaluate(() => {
      const p = window.__hostcaster.player.state;
      return [p.track?.title, p.queue[p.index + 1]?.title];
    });
    check('song request answered on air', Boolean(req), req ? req.lines.map((l) => l.text).join(' ').slice(0, 140) : 'none');
    check('requested song mentioned', Boolean(req) && req.lines.map((l) => l.text).join(' ').toLowerCase().includes(want.toLowerCase()));
    check('requested song queued next', queued.includes(want), `now ${queued[0]}, next ${queued[1]}, wanted ${want}`);
    const played = await page.waitForFunction((w) => window.__hostcaster.player.state.track?.title === w, want, { timeout: 120_000 }).then(() => true, () => false);
    check('requested song plays', played);
  }
}

// ------------------------------------------------------------------------------------------------ history
await page.goto(`${base}/#/on-air`);
await page.locator('.aw-break').first().waitFor();
await wait(300);
await shot(page, 'e2e-history-desktop');
check('history lists the breaks', (await page.locator('.aw-break').count()) >= 4);
await page.setViewportSize({ width: 390, height: 844 });
await wait(300);
await shot(page, 'e2e-history-phone');
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${base}/#/`);
await wait(500);
await shot(page, 'e2e-home-after-desktop');
await page.evaluate(() => window.__hostcaster.radio.stop());

const hosts = await page.evaluate(async () => {
  const d = await new Promise((res) => {
    const req = indexedDB.open('hostcaster');
    req.onsuccess = () => res(req.result);
  });
  return new Promise((res) => {
    const tx = d.transaction('hosts').objectStore('hosts').getAll();
    tx.onsuccess = () => res(Object.fromEntries(tx.result.map((h) => [h.id, h.name])));
  });
}).catch(() => ({}));
writeFileSync(out, JSON.stringify({ breaks: await page.evaluate(() => window.__breaks).catch(() => [first, second, call].filter(Boolean)), hosts, timeline, calls }, null, 2));
await browser.close();
if (errors.length) console.log('PAGE ERRORS:\n' + [...new Set(errors)].join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed in ${secs()} s`);
process.exit(failed ? 1 : 0);
