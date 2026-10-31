// Phone apps' YouTube rule, checked in a browser at phone size: the player is always on screen and at least
// 200x200 CSS px (Now Playing slot, or the mini window when Now Playing is closed or covered), tappable, and the mini
// window can be dragged to another corner. Needs network (YouTube). node e2e/youtube-visible.e2e.mjs <baseUrl>
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:8698';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${base}/`);
await page.waitForFunction(() => window.__hostcaster?.player && window.__hostcaster?.youtubeNeedsScreen, undefined, { timeout: 30000 });
await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('hostcaster');
    r.onsuccess = () => res(r.result);
  });
  const s = await new Promise((res) => {
    const q = db.transaction('settings').objectStore('settings').get('app');
    q.onsuccess = () => res(q.result);
  });
  await new Promise((res) => {
    const t = db.transaction('settings', 'readwrite');
    t.objectStore('settings').put({ ...s, onboarded: true });
    t.oncomplete = res;
  });
});
await page.reload();
await page.waitForFunction(() => window.__hostcaster?.youtubeNeedsScreen, undefined, { timeout: 30000 });

const geo = () =>
  page.evaluate(() => {
    const h = document.querySelector('.aw-yt-host');
    const m = document.querySelector('.aw-yt-mini');
    const r = h?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return {
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      x: r ? Math.round(r.left) : 0,
      y: r ? Math.round(r.top) : 0,
      opacity: h?.style.opacity,
      pe: h?.style.pointerEvents,
      onTop: Boolean(hit && h?.contains(hit)),
      mini: m ? m.style.display !== 'none' : false,
      corner: m?.dataset.corner,
      status: window.__hostcaster.player.state.status,
    };
  });

// web default first: parked, invisible (unchanged web behaviour)
const yt = (id) => ({ id: `vis-${id}`, title: id, artist: 'Test', album: '', durationMs: 30000, source: 'youtube', ref: id, playCount: 0, addedAt: 0, createdAt: 0, updatedAt: 0 });
await page.evaluate((q) => window.__hostcaster.player.playQueue(q), [yt('jNQXAC9IVRw'), yt('zK-__R-wyig')]);
await page.waitForFunction(() => window.__hostcaster.player.state.status === 'playing', undefined, { timeout: 30000 });
let g = await geo();
check('web: player parked and hidden when Now Playing is closed (unchanged)', g.opacity === '0' && !g.mini, JSON.stringify(g));

await page.evaluate(() => window.__hostcaster.youtubeNeedsScreen(true));
await wait(300);
g = await geo();
check('phone rule: mini window shows the playing video', g.mini && g.opacity === '1' && g.w >= 200 && g.h >= 200, `${g.w}x${g.h}`);
check('mini window is on top and tappable', g.onTop && g.pe === 'auto');
check('mini window starts bottom right', g.corner === 'br' && g.x + g.w > 390 - 20 && g.y > 844 / 2, `${g.x},${g.y}`);
await page.screenshot({ path: `${shots}/yt-visible-mini.png` });

// drag by the bar to the top left
const bar = page.locator('.aw-yt-mini__bar');
const bb = await bar.boundingBox();
await page.mouse.move(bb.x + 20, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(60, 160, { steps: 8 });
await page.mouse.up();
await wait(300);
g = await geo();
check('drag moves the mini window to the top-left corner', g.corner === 'tl' && g.x < 390 / 2 && g.y < 844 / 2 && g.w >= 200, `${g.corner} ${g.x},${g.y}`);

// Now Playing: the video fills the art slot, at least 200 px tall
await page.locator('.aw-yt-mini__open').click();
await page.waitForSelector('[data-testid="youtube-slot"]', { timeout: 10000 });
await wait(600);
g = await geo();
check('Now Playing: video in the slot, at least 200x200', !g.mini && g.opacity === '1' && g.w >= 200 && g.h >= 200, `${g.w}x${g.h}`);
check('Now Playing: video on top and tappable', g.onTop && g.pe === 'auto');
await page.screenshot({ path: `${shots}/yt-visible-nowplaying.png` });

// something over the slot (the track menu): the video moves to the mini window instead of hiding
const menu = page.locator('.aw-np__top button').last();
await menu.click();
await wait(600);
g = await geo();
check('slot covered by a sheet: mini window instead (never hidden)', g.mini && g.opacity === '1' && g.onTop && g.w >= 200, JSON.stringify(g));
await page.screenshot({ path: `${shots}/yt-visible-covered.png` });
await page.keyboard.press('Escape');
await wait(400);

// back to the web rule: parked again
await page.evaluate(() => window.__hostcaster.youtubeNeedsScreen(false));
await page.goto(`${base}/#/`);
await wait(500);
g = await geo();
check('rule off again: parked as on the web', g.opacity === '0' && !g.mini, JSON.stringify(g));
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
