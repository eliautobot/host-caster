// The YouTube window in the phone and desktop apps' mode (visible player rule on), checked in a real browser with a
// real YouTube video at 390x844 and 1440x900: it docks in room the app keeps free (no button, link or field of
// Home, Library, Settings or Now Playing under it, in any corner, scrolled to the top or the bottom), its close
// button hides it and the next non-YouTube song plays, the "YouTube hidden" chip brings it back and YouTube plays
// again, minimize is exactly 200x200, a drag moves it (and its room) to each corner, and with only YouTube songs
// left a hidden video pauses with a note. Needs network (YouTube).
//   node e2e/youtube-window.e2e.mjs [baseUrl]   (serve a build with e2e/fixtures/serve-dist.mjs: it adds the tone)
// baseUrl must be a host NAME (http://localhost:PORT): YouTube refuses label videos on a bare-IP origin.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:8721';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
const VIDEOS = (process.env.VIDEOS ?? 'M7lc1UVf-VE,aqz-KE-bpKQ').split(',');
const only = process.env.ONLY; // phone | desktop
// a real phone's Chrome (adb forward tcp:9333 localabstract:chrome_devtools_remote; adb reverse tcp:PORT tcp:PORT)
const cdp = process.env.CDP;
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail && !ok ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const yt = (id, n) => ({ id: `win-yt-${n}`, title: `YouTube ${n}`, artist: 'Test', album: '', durationMs: 600000, source: 'youtube', ref: id, playCount: 0, addedAt: 0, createdAt: 0, updatedAt: 0 });
const tone = (n) => ({ id: `win-tone-${n}`, title: `Radio ${n}`, artist: 'Test', album: '', durationMs: 180000, source: 'stream', ref: `${base}/e2e-tone.wav`, playCount: 0, addedAt: 0, createdAt: 0, updatedAt: 0 });

const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(viewport, mobile) {
  const ctx = cdp ? browser.contexts()[0] : await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark' });
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
    // the app writes its settings row shortly after the first load
    let s;
    for (let i = 0; i < 50 && !s; i++) {
      s = await new Promise((res) => {
        const q = db.transaction('settings').objectStore('settings').get('app');
        q.onsuccess = () => res(q.result);
      });
      if (!s) await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((res) => {
      const t = db.transaction('settings', 'readwrite');
      t.objectStore('settings').put({ ...s, onboarded: true });
      t.oncomplete = res;
    });
  });
  await page.goto(`${base}/#/`);
  await page.reload();
  await page.waitForFunction(() => window.__hostcaster?.youtubeNeedsScreen && document.querySelector('.aw-app'), undefined, { timeout: 30000 });
  // the phone and desktop apps' rule, in a browser
  await page.evaluate(() => window.__hostcaster.youtubeNeedsScreen(true));
  return { ctx, page, errors };
}

/** The window (bar + video) and every visible interactive element of the app that overlaps it. */
const coverage = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('.aw-yt-host');
    const mini = document.querySelector('.aw-yt-mini');
    const hr = host?.getBoundingClientRect();
    const shown = host && host.style.opacity === '1';
    if (!shown) return { shown: false, offenders: [] };
    const boxes = [hr];
    if (mini && mini.style.display !== 'none') boxes.push(mini.getBoundingClientRect());
    const vw = innerWidth;
    const vh = innerHeight;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      let [x1, y1, x2, y2] = [r.left, r.top, r.right, r.bottom];
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const pr = p.getBoundingClientRect();
          x1 = Math.max(x1, pr.left);
          y1 = Math.max(y1, pr.top);
          x2 = Math.min(x2, pr.right);
          y2 = Math.min(y2, pr.bottom);
        }
      }
      [x1, y1, x2, y2] = [Math.max(x1, 0), Math.max(y1, 0), Math.min(x2, vw), Math.min(y2, vh)];
      const cs = getComputedStyle(el);
      if (x2 - x1 < 1 || y2 - y1 < 1 || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
      return { x1, y1, x2, y2 };
    };
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="slider"], [role="link"], [tabindex]:not([tabindex="-1"])';
    const offenders = [];
    let count = 0;
    // an open sheet is modal: only what is in the top one can be used
    const sheets = document.querySelectorAll('.aw-sheet-root[data-state="open"]');
    const scope = sheets.length ? sheets[sheets.length - 1] : document;
    for (const el of scope.querySelectorAll(sel)) {
      if (host.contains(el) || mini?.contains(el) || el.closest('.aw-yt-slot')) continue;
      const v = visible(el);
      if (!v) continue;
      count++;
      for (const b of boxes) {
        if (v.x1 < b.right - 0.5 && b.left < v.x2 - 0.5 && v.y1 < b.bottom - 0.5 && b.top < v.y2 - 0.5) {
          offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)}]`);
          break;
        }
      }
    }
    return { shown: true, count, offenders: [...new Set(offenders)].slice(0, 5), w: Math.round(hr.width), h: Math.round(hr.height) };
  });

const geo = (page) =>
  page.evaluate(() => {
    const h = document.querySelector('.aw-yt-host');
    const m = document.querySelector('.aw-yt-mini');
    const r = h?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    const root = document.documentElement;
    const s = window.__hostcaster.player.state;
    return {
      w: r ? Math.round(r.width * 10) / 10 : 0,
      h: r ? Math.round(r.height * 10) / 10 : 0,
      x: r ? Math.round(r.left) : 0,
      y: r ? Math.round(r.top) : 0,
      shown: h?.style.opacity === '1',
      onTop: Boolean(hit && h?.contains(hit)),
      mini: m ? m.style.display !== 'none' : false,
      corner: m?.dataset.corner,
      dock: root.dataset.ytDock,
      res: ['top', 'bottom', 'left', 'right'].map((k) => parseFloat(root.style.getPropertyValue(`--yt-res-${k}`)) || 0),
      chip: Boolean(document.querySelector('.aw-yt-chip')),
      status: s.status,
      source: s.track?.source,
      id: s.track?.id,
      waiting: s.waiting,
    };
  });

async function until(page, fn, arg, ms = 20000) {
  try {
    await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 });
    return true;
  } catch {
    return false;
  }
}
const isPlaying = (page, source, ms) => until(page, (src) => { const s = window.__hostcaster.player.state; return s.status === 'playing' && s.track?.source === src; }, source, ms);
async function playing(page, source) {
  if (await isPlaying(page, source, cdp ? 8000 : 30000)) return true;
  if (!cdp) return false;
  // a real phone's browser asks for a tap before sound (autoplay rules): tap play, as a listener does
  const play = page.locator('.aw-mini__play, .aw-playerbar .aw-transport__play').first();
  if (await play.count()) await play.tap().catch(() => play.click());
  return isPlaying(page, source, 20000);
}

async function pages(page, label, routes) {
  for (const route of routes) {
    await page.evaluate((r) => (location.hash = r), route);
    await wait(900);
    for (const at of ['top', 'bottom']) {
      if (at === 'bottom') {
        await page.evaluate(() => {
          const m = document.querySelector('.aw-main');
          if (m) m.scrollTop = m.scrollHeight;
        });
        await wait(300);
      }
      const c = await coverage(page);
      check(`${label}: ${route} (${at}) nothing interactive under the window`, c.shown && c.offenders.length === 0, `${c.shown ? '' : 'window not shown '}${c.offenders.join(', ')}`);
    }
  }
}

async function dragTo(page, x, y) {
  const bar = await page.locator('.aw-yt-mini__grip').boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
  await wait(500);
}

async function run(kind) {
  const phone = kind === 'phone';
  const vp = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const { ctx, page, errors } = await open(vp, phone);
  const real = cdp ? await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) : vp;
  const L = cdp ? `real phone ${real.width}x${real.height}` : `${kind} ${vp.width}x${vp.height}`;

  // a YouTube song plays: the window docks bottom right, large, and the app keeps its room
  await page.evaluate((q) => window.__hostcaster.player.playQueue(q), [yt(VIDEOS[0], 1), tone(1), yt(VIDEOS[1] ?? VIDEOS[0], 2), tone(2)]);
  check(`${L}: YouTube plays`, await playing(page, 'youtube'));
  await wait(800);
  let g = await geo(page);
  check(`${L}: docked window shows the video, at least 200x200, on top`, g.mini && g.shown && g.onTop && g.w >= 200 && g.h >= 200, JSON.stringify(g));
  check(`${L}: docked bottom right with its room kept`, g.dock === 'br' && (phone ? g.res[1] > 200 : g.res[3] > 200), JSON.stringify(g));
  const large = { w: g.w, h: g.h, res: g.res };
  await page.screenshot({ path: `${shots}/ytw-${kind}-1-docked.png` });
  await pages(page, L, ['#/', '#/library', '#/settings']);

  // Now Playing: the video sits in the art area; nothing interactive under it
  await page.evaluate(() => (location.hash = '#/now-playing'));
  await page.waitForSelector('[data-testid="youtube-slot"]', { timeout: 10000 });
  await wait(900);
  g = await geo(page);
  check(`${L}: Now Playing shows the video in the art area`, !g.mini && g.shown && g.w >= 200 && g.h >= 200, JSON.stringify(g));
  let c = await coverage(page);
  check(`${L}: Now Playing: nothing interactive under the video`, c.offenders.length === 0, c.offenders.join(', '));
  if (phone) {
    await page.getByRole('tab', { name: 'Up next' }).click();
    await wait(900);
    g = await geo(page);
    c = await coverage(page);
    check(`${L}: Now Playing, Up next: the window docks and covers nothing`, g.mini && g.shown && c.offenders.length === 0, `${JSON.stringify(g)} ${c.offenders.join(', ')}`);
    await page.screenshot({ path: `${shots}/ytw-${kind}-2-np-upnext.png` });
    await page.getByRole('tab', { name: 'Now playing' }).click();
  }
  await page.evaluate(() => (location.hash = '#/'));
  await wait(900);

  // minimize: exactly 200x200, less room kept; the button and a double tap toggle it
  await page.locator('.aw-yt-mini__size').click();
  await wait(500);
  g = await geo(page);
  const sum = (r) => r.reduce((a, b) => a + b, 0);
  check(`${L}: minimize makes the video exactly 200x200`, g.w === 200 && g.h === 200, `${g.w}x${g.h}`);
  check(`${L}: minimized, the app gets room back`, sum(g.res) < sum(large.res) && g.dock === 'br', `${g.res} vs ${large.res}`);
  check(`${L}: the size button says what it does`, (await page.locator('.aw-yt-mini__size').getAttribute('aria-label')) === 'Larger video');
  await page.screenshot({ path: `${shots}/ytw-${kind}-3-small.png` });
  await pages(page, `${L} small`, ['#/']);
  const grip = await page.locator('.aw-yt-mini__grip').boundingBox();
  if (phone) {
    await page.touchscreen.tap(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await wait(120);
    await page.touchscreen.tap(grip.x + grip.width / 2, grip.y + grip.height / 2);
  } else await page.mouse.dblclick(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await wait(500);
  g = await geo(page);
  check(`${L}: a double tap on the bar makes it large again`, g.w === large.w && g.h === large.h, `${g.w}x${g.h}`);

  // drag to each corner: the room follows, nothing is covered
  const W = real.width;
  const H = real.height;
  const spots = { tl: [W * 0.3, H * 0.25], tr: [W * 0.7, H * 0.25], bl: [W * 0.3, H * 0.75], br: [W * 0.7, H * 0.75] };
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    await dragTo(page, ...spots[corner]);
    g = await geo(page);
    const side = phone ? (corner[0] === 't' ? 0 : 1) : corner[1] === 'l' ? 2 : 3;
    check(`${L}: drag to ${corner}: window and its room move there`, g.corner === corner && g.dock === corner && g.res[side] > 200 && g.w >= 200 && g.h >= 200, JSON.stringify(g));
    c = await coverage(page);
    check(`${L}: in ${corner} nothing interactive under the window`, c.offenders.length === 0, c.offenders.join(', '));
    if (corner === 'tl') await page.screenshot({ path: `${shots}/ytw-${kind}-4-topleft.png` });
  }

  // keyboard: the window's buttons are reachable and labelled, in order
  const labels = await page.locator('.aw-yt-mini button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
  check(`${L}: window buttons labelled in order`, labels.join('|') === 'Open Now Playing|Smaller video|Hide video', labels.join('|'));

  // close: the video hides, the next non-YouTube song plays, a chip says YouTube is hidden
  await page.locator('.aw-yt-mini__close').click();
  check(`${L}: close: the next non-YouTube song plays`, await playing(page, 'stream'));
  await wait(600);
  g = await geo(page);
  check(`${L}: close: no window, no room kept, chip shows`, !g.mini && !g.shown && !g.dock && g.chip, JSON.stringify(g));
  check(`${L}: close: the YouTube songs wait behind`, await page.evaluate(() => window.__hostcaster.player.state.queue.map((t) => t.source).join(',') === 'stream,youtube,youtube,stream'));
  await page.screenshot({ path: `${shots}/ytw-${kind}-5-hidden-chip.png` });
  // the next song is not a YouTube one while hidden
  await page.evaluate(() => window.__hostcaster.player.next());
  check(`${L}: hidden: the next song skips the YouTube ones`, await playing(page, 'stream'));
  g = await geo(page);
  check(`${L}: hidden: it is the second radio song`, g.id === 'win-tone-2', g.id);

  // the chip: the video is back and YouTube plays again
  await page.locator('.aw-yt-chip').click();
  await wait(300);
  g = await geo(page);
  check(`${L}: chip: gone after a tap`, !g.chip);
  await page.evaluate(() => window.__hostcaster.player.next());
  check(`${L}: chip: YouTube plays again`, await playing(page, 'youtube'));
  await wait(800);
  g = await geo(page);
  check(`${L}: chip: the window shows again, docked`, g.mini && g.shown && g.onTop && Boolean(g.dock), JSON.stringify(g));

  // only YouTube left: hidden pauses with a note, the chip plays it again
  await page.evaluate((q) => window.__hostcaster.player.playQueue(q), [yt(VIDEOS[1] ?? VIDEOS[0], 3)]);
  check(`${L}: YouTube only: plays`, await playing(page, 'youtube'));
  await page.locator('.aw-yt-mini__close').click();
  const paused = await until(page, () => window.__hostcaster.player.state.waiting === 'video' && window.__hostcaster.player.state.status === 'paused', undefined, 10000);
  check(`${L}: YouTube only, hidden: playback pauses`, paused);
  check(`${L}: ... with a short clear note`, await until(page, () => document.body.innerText.includes('Paused while the video is hidden'), undefined, 5000));
  await page.screenshot({ path: `${shots}/ytw-${kind}-6-paused-note.png` });
  await page.locator('.aw-yt-chip').first().click();
  check(`${L}: chip: the YouTube song plays on`, await playing(page, 'youtube'));
  await wait(600);
  g = await geo(page);
  check(`${L}: and shows in the window`, g.mini && g.shown && g.onTop, JSON.stringify(g));

  // light theme: the window follows the app's colours
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await wait(300);
  const bg = await page.locator('.aw-yt-mini').evaluate((el) => getComputedStyle(el).backgroundColor);
  check(`${L}: light theme: the window is light`, /rgb\((2[0-9]{2}), (2[0-9]{2}), (2[0-9]{2})\)/.test(bg), bg);
  await page.screenshot({ path: `${shots}/ytw-${kind}-7-light.png` });

  check(`${L}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  if (cdp) await page.close();
  else await ctx.close();
}

for (const kind of cdp ? ['phone'] : ['phone', 'desktop']) if (!only || only === kind) await run(kind);
if (!cdp) await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
