// Seek bar on touch screens: tap-to-seek and drag-to-seek really move the audio (player state AND the media element),
// and the bar keeps moving after a seek and into the next song. Phone, both tablet sizes, and a mouse on desktop.
//   node e2e/seek-touch.e2e.mjs <baseUrl> [mediaDir]
// baseUrl: a build served by e2e/fixtures/serve-dist.mjs; mediaDir: e2e/fixtures/make-media.sh demo (full-length songs).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:8741';
const media = process.argv[3] ?? '/tmp/hostcaster-e2e/demo-media';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-seek-shots';
mkdirSync(shots, { recursive: true });
const SONGS = ['01 Golden Hour.mp3', '02 Highway Bloom.mp3', '03 Low Tide.mp3'];
const TOL = 6000;
let failed = 0;
const errors = [];

function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (page, fn, arg, timeout = 15000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(
    () => true,
    () => false,
  );
/** player position, the media element's position, the bar's value, duration (ms) */
const read = (page, sel) =>
  page.evaluate((s) => {
    const p = window.__hostcaster.player;
    const el = p.active?.element;
    return {
      pos: p.state.positionMs,
      audio: el ? el.currentTime * 1000 : -1,
      bar: Number(document.querySelector(s)?.value ?? -1),
      dur: p.state.durationMs,
      id: p.state.track?.id,
      st: `${p.state.status}${p.state.holding ? ' holding' : ''}`,
    };
  }, sel);
const near = (a, b) => Math.abs(a - b) <= TOL;
const fmt = (r) => `pos ${Math.round(r.pos / 1000)}s audio ${Math.round(r.audio / 1000)}s bar ${Math.round(r.bar / 1000)}s of ${Math.round(r.dur / 1000)}s ${r.st}`;

async function touch(cdp, type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }] });
}
/** x of a fraction along the range's track (the thumb is 14px; its centre runs from 7px to width-7px) */
const at = (box, f) => ({ x: box.x + 7 + (box.width - 14) * f, y: box.y + box.height / 2 });

async function tapSeek(page, cdp, sel, f, mouse) {
  const box = await page.locator(sel).boundingBox();
  const { x, y } = at(box, f);
  if (mouse) return page.mouse.click(x, y);
  await touch(cdp, 'touchStart', x, y);
  await wait(60);
  await touch(cdp, 'touchEnd', x, y);
}

async function dragSeek(page, cdp, sel, from, to, mouse, holdMs = 400) {
  const box = await page.locator(sel).boundingBox();
  const a = at(box, from);
  const b = at(box, to);
  if (mouse) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y);
  } else {
    await touch(cdp, 'touchStart', a.x, a.y);
    for (let i = 1; i <= 12; i++) {
      await wait(25);
      await touch(cdp, 'touchMove', a.x + ((b.x - a.x) * i) / 12, a.y);
    }
  }
  await wait(holdMs);
  const held = await read(page, sel);
  if (mouse) await page.mouse.up();
  else await touch(cdp, 'touchEnd', b.x, b.y);
  return held;
}

/** tap + drag + keeps moving + next song, on the seek bar `sel` */
async function seekChecks(page, cdp, tag, sel, mouse) {
  let r = await read(page, sel);
  const dur = r.dur;
  await tapSeek(page, cdp, sel, 0.5, mouse);
  await wait(700);
  r = await read(page, sel);
  check(`${tag}: tap moves the song to the middle`, near(r.pos, dur * 0.5) && near(r.audio, dur * 0.5), fmt(r));
  await wait(2200);
  const later = await read(page, sel);
  check(`${tag}: bar keeps moving after the tap`, later.audio > r.audio + 1200 && near(later.bar, later.audio), fmt(later));

  const held = await dragSeek(page, cdp, sel, 0.2, 0.8, mouse);
  check(`${tag}: bar follows the finger while held`, near(held.bar, dur * 0.8), fmt(held));
  await wait(700);
  r = await read(page, sel);
  check(`${tag}: drag moves the song`, near(r.pos, dur * 0.8) && near(r.audio, dur * 0.8), fmt(r));
  await wait(2200);
  const after = await read(page, sel);
  check(`${tag}: bar keeps moving after the drag`, after.audio > r.audio + 1200 && near(after.bar, after.audio), fmt(after));

  // near the end: the next song starts and the bar follows it from 0
  const id = after.id;
  await dragSeek(page, cdp, sel, 0.8, 0.995, mouse, 100);
  const next = await until(page, (old) => window.__hostcaster.player.state.track?.id !== old && window.__hostcaster.player.state.positionMs > 1500, id, 20000);
  await wait(1500);
  const n = await read(page, sel);
  check(`${tag}: next song plays and the bar follows it`, next && n.id !== id && n.audio < 20000 && near(n.bar, n.audio), fmt(n));
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const configs = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'tablet-portrait', viewport: { width: 800, height: 1280 }, touch: true },
  { name: 'tablet-landscape', viewport: { width: 1280, height: 800 }, touch: true },
  { name: 'desktop-mouse', viewport: { width: 1440, height: 900 }, touch: false },
];
for (const c of configs.filter((x) => !process.env.ONLY || process.env.ONLY.split(',').includes(x.name))) {
  const ctx = await browser.newContext({
    viewport: c.viewport,
    deviceScaleFactor: c.touch ? 2 : 1,
    isMobile: c.touch,
    hasTouch: c.touch,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${c.name}: ${e.message}`));
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${base}/#/library`);
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor();
  await page.locator('[data-testid=pick-files]').setInputFiles(SONGS.map((s) => join(media, s)));
  await until(page, (n) => document.querySelectorAll('.aw-track').length === n, SONGS.length, 30000);
  const row = page.locator('.aw-track__main').first(); // the list's first song: the others follow it
  if (c.touch) await row.tap();
  else await row.dblclick();
  const playing = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 500);
  check(`${c.name}: plays`, playing);
  const desktop = c.viewport.width >= 900;
  if (desktop) await seekChecks(page, cdp, `${c.name} bar`, '.aw-playerbar input[aria-label=Seek]', !c.touch);
  if (desktop) await page.goto(`${base}/#/now-playing`);
  else await page.getByRole('button', { name: 'Open Now Playing' }).tap();
  await page.locator('.aw-np input[aria-label=Seek]').waitFor();
  await wait(900);
  await seekChecks(page, cdp, `${c.name} Now Playing`, '.aw-np input[aria-label=Seek]', !c.touch);
  await page.screenshot({ path: join(shots, `seek-${c.name}.png`) });
  await ctx.close();
}
await browser.close();
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
