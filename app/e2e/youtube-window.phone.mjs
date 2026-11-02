// The YouTube window on a REAL phone, in its Chrome (the phone and desktop apps' rule turned on), with real touch
// (adb input: the phone's own touchscreen events; CDP touch input hangs on this Chrome, CDP mouse for the double tap):
// docked without covering anything, minimize to 200x200, double tap, drag to a corner, close -> the next non-YouTube
// song plays, the "YouTube hidden" chip -> the video and YouTube are back. Raw CDP in a new tab of its own (Playwright's
// connectOverCDP waits on the phone's frozen background tabs). Serve a build with e2e/fixtures/serve-dist.mjs, then:
//   adb reverse tcp:8721 tcp:8721; adb forward tcp:9333 localabstract:chrome_devtools_remote
//   adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -d http://localhost:8721/#/
//   node e2e/youtube-window.phone.mjs [http://localhost:8721] [http://127.0.0.1:9333]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:8721';
const devtools = process.argv[3] ?? 'http://127.0.0.1:9333';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
const VIDEOS = (process.env.VIDEOS ?? 'M7lc1UVf-VE,aqz-KE-bpKQ').split(',');
const ADB = process.env.ADB ?? 'adb';
const SERIAL = process.env.SERIAL;
const adb = (...args) => execFileSync(ADB, [...(SERIAL ? ['-s', SERIAL] : []), 'shell', 'input', ...args.map(String)], { stdio: 'ignore', timeout: 20000 });
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} real phone: ${name}${detail && !ok ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the tab the phone shows (open it first: adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main
// -d <baseUrl>), through its own page socket: tabs made over CDP stay in the background on Android, where touch never
// reaches them, and the phone's tabs do not answer through the browser socket
const shown = (await (await fetch(`${devtools}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(base));
if (!shown) throw new Error(`open ${base} in the phone's Chrome first`);
const ws = new WebSocket(shown.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message));
    else res(msg.result);
  }
};
const S = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.delete(id) && rej(new Error(`${method} timed out`)), 30000);
  });
await S('Page.enable');
await S('Runtime.enable');

async function evaluate(fn, arg) {
  const expression = `(${fn})(${JSON.stringify(arg ?? null)})`;
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function until(fn, arg, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(fn, arg).catch(() => false)) return true;
    await wait(250);
  }
  return false;
}
async function go(url) {
  await S('Page.navigate', { url });
  await until(() => Boolean(window.__hostcaster?.player && window.__hostcaster?.youtubeNeedsScreen && document.querySelector('.aw-app')), null, 30000);
}
const center = (sel) =>
  evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
// page CSS px -> screen px (found once by tapping a known screen point)
let cal = { dpr: 3, dx: 0, dy: 0 };
async function calibrate() {
  // a blank layer catches the calibration tap, so it presses nothing in the app
  await evaluate(() => {
    window.__tapAt = undefined;
    const layer = document.createElement('div');
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
    layer.addEventListener('pointerdown', (e) => {
      window.__tapAt = { x: e.clientX, y: e.clientY, dpr: devicePixelRatio };
      setTimeout(() => layer.remove(), 300);
    });
    document.body.appendChild(layer);
  });
  const vw = await evaluate(() => innerWidth);
  const sx = Math.round(vw * 1.5);
  const sy = 1200;
  adb('tap', sx, sy);
  await until(() => Boolean(window.__tapAt), null, 5000);
  const t = await evaluate(() => window.__tapAt);
  cal = { dpr: t.dpr, dx: sx / t.dpr - t.x, dy: sy / t.dpr - t.y };
}
const screen = (p) => [Math.round((p.x + cal.dx) * cal.dpr), Math.round((p.y + cal.dy) * cal.dpr)];
async function tap(sel) {
  const p = await center(sel);
  if (!p) return false;
  adb('tap', ...screen(p));
  return true;
}
async function drag(sel, x, y) {
  const p = await center(sel);
  adb('swipe', ...screen(p), ...screen({ x, y }), 700);
  await wait(700);
}
async function doubleClick(sel) {
  const p = await center(sel);
  for (const clickCount of [1, 2]) {
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount });
  }
}
async function shot(name) {
  const { data } = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${shots}/ytw-realphone-${name}.png`, Buffer.from(data, 'base64'));
}

const geo = () =>
  evaluate(() => {
    const h = document.querySelector('.aw-yt-host');
    const m = document.querySelector('.aw-yt-mini');
    const r = h?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    const root = document.documentElement;
    const s = window.__hostcaster.player.state;
    return {
      w: r ? Math.round(r.width * 10) / 10 : 0,
      h: r ? Math.round(r.height * 10) / 10 : 0,
      shown: h?.style.opacity === '1',
      onTop: Boolean(hit && h?.contains(hit)),
      mini: m ? m.style.display !== 'none' : false,
      corner: m?.dataset.corner,
      dock: root.dataset.ytDock,
      res: ['top', 'bottom'].map((k) => parseFloat(root.style.getPropertyValue(`--yt-res-${k}`)) || 0),
      chip: Boolean(document.querySelector('.aw-yt-chip')),
      status: s.status,
      source: s.track?.source,
      vw: innerWidth,
      vh: innerHeight,
    };
  });

/** visible interactive elements of the app under the window (none allowed) */
const covered = () =>
  evaluate(() => {
    const boxes = [document.querySelector('.aw-yt-host'), document.querySelector('.aw-yt-mini')].filter((e) => e && getComputedStyle(e).display !== 'none' && e.style.opacity !== '0').map((e) => e.getBoundingClientRect());
    const out = [];
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="switch"], [tabindex]:not([tabindex="-1"])')) {
      if (el.closest('.aw-yt-mini, .aw-yt-host, .aw-yt-slot')) continue;
      const r = el.getBoundingClientRect();
      let [x1, y1, x2, y2] = [r.left, r.top, r.right, r.bottom];
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const pr = p.getBoundingClientRect();
          [x1, y1, x2, y2] = [Math.max(x1, pr.left), Math.max(y1, pr.top), Math.min(x2, pr.right), Math.min(y2, pr.bottom)];
        }
      }
      if (x2 - x1 < 1 || y2 - y1 < 1 || getComputedStyle(el).visibility === 'hidden') continue;
      if (boxes.some((b) => x1 < b.right - 0.5 && b.left < x2 - 0.5 && y1 < b.bottom - 0.5 && b.top < y2 - 0.5)) out.push(el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20));
    }
    return out.slice(0, 4);
  });

const playingNow = (src) => until((s) => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === s, src, 15000);
async function playing(src) {
  if (await playingNow(src)) return true;
  // the phone's browser wants a tap before sound (autoplay rules): tap play, as a listener does
  await tap('.aw-mini__play');
  return playingNow(src);
}

try {
  await go(`${base}/#/`);
  await evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('hostcaster');
      r.onsuccess = () => res(r.result);
    });
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
  await go(`${base}/?r=1#/`);
  await wait(1500);
  await calibrate();
  await evaluate(() => {
    localStorage.removeItem('hostcaster:yt-mini-corner');
    localStorage.removeItem('hostcaster:yt-size');
    window.__hostcaster.youtubeNeedsScreen(true);
  });
  const yt = (id, n) => ({ id: `phone-yt-${n}`, title: `YouTube ${n}`, artist: 'Test', album: '', durationMs: 600000, source: 'youtube', ref: id, playCount: 0, addedAt: 0, createdAt: 0, updatedAt: 0 });
  const tone = (n) => ({ id: `phone-tone-${n}`, title: `Radio ${n}`, artist: 'Test', album: '', durationMs: 180000, source: 'stream', ref: `${base}/e2e-tone.wav`, playCount: 0, addedAt: 0, createdAt: 0, updatedAt: 0 });
  await evaluate((q) => void window.__hostcaster.player.playQueue(q), [yt(VIDEOS[0], 1), tone(1), yt(VIDEOS[1] ?? VIDEOS[0], 2), tone(2)]);
  check('a YouTube song plays', await playing('youtube'));
  await wait(1500);
  let g = await geo();
  check(`docked window ${g.w}x${g.h} in a ${g.vw}x${g.vh} screen, on top, room kept`, g.mini && g.shown && g.onTop && g.w >= 200 && g.h >= 200 && g.dock === 'br' && g.res[1] > 200, JSON.stringify(g));
  for (const route of ['#/', '#/library', '#/settings']) {
    await evaluate((r) => (location.hash = r), route);
    await wait(1200);
    const c = await covered();
    check(`${route}: nothing interactive under the window`, c.length === 0, c.join(', '));
  }
  await evaluate(() => (location.hash = '#/'));
  await wait(800);
  await shot('1-docked');

  await tap('.aw-yt-mini__size');
  await wait(800);
  g = await geo();
  check('minimize (tap): exactly 200x200', g.w === 200 && g.h === 200, `${g.w}x${g.h}`);
  await shot('2-small');
  await doubleClick('.aw-yt-mini__grip');
  await wait(800);
  g = await geo();
  check('double click on the bar: large again', g.w > 200, `${g.w}x${g.h}`);

  await drag('.aw-yt-mini__grip', g.vw * 0.25, g.vh * 0.25);
  g = await geo();
  check('drag (touch) to the top left: window and room move', g.corner === 'tl' && g.dock === 'tl' && g.res[0] > 200 && g.res[1] === 0, JSON.stringify(g));
  const c = await covered();
  check('top left: nothing interactive under the window', c.length === 0, c.join(', '));
  await shot('3-topleft');
  await drag('.aw-yt-mini__grip', g.vw * 0.75, g.vh * 0.75);
  g = await geo();
  check('drag back to the bottom right', g.corner === 'br' && g.dock === 'br', JSON.stringify(g));

  await tap('.aw-yt-mini__close');
  check('close (tap): the next non-YouTube song plays', await playingNow('stream'));
  await wait(800);
  g = await geo();
  check('close: video hidden, no room kept, chip shows', !g.mini && !g.shown && !g.dock && g.chip, JSON.stringify(g));
  await shot('4-hidden-chip');

  await tap('.aw-yt-chip');
  await wait(500);
  g = await geo();
  check('chip (tap): gone', !g.chip);
  await evaluate(() => void window.__hostcaster.player.next());
  check('chip: YouTube plays again', await playing('youtube'));
  await wait(1500);
  g = await geo();
  check('chip: the window is back, docked', g.mini && g.shown && g.onTop && Boolean(g.dock), JSON.stringify(g));
  await shot('5-back');
  await evaluate(() => window.__hostcaster.player.pause());
} catch (err) {
  failed++;
  console.log(`FAIL real phone: ${String(err).slice(0, 200)}`);
} finally {
  await S('Page.navigate', { url: 'about:blank' }).catch(() => {});
  ws.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
