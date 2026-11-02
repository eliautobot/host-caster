// The seek bar on a REAL phone, in its Chrome, with real touch (adb input: tap, and motionevent DOWN/MOVE/UP for a
// drag that holds before it lets go): tap-to-seek and drag-to-seek move the audio, the bar keeps moving after a seek
// and into the next song. Logs the slider's event order (pointer, touch, input, change) for each gesture.
// Serve a build with e2e/fixtures/serve-dist.mjs and put 3 songs in <dist>/seek-media/1.mp3..3.mp3, then:
//   adb reverse tcp:8741 tcp:8741; adb forward tcp:9333 localabstract:chrome_devtools_remote
//   adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -d http://localhost:8741/#/library
//   ADB=... SERIAL=... [WIDTH=1280] node e2e/seek-touch.phone.mjs [http://localhost:8741] [http://127.0.0.1:9333]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:8741';
const devtools = process.argv[3] ?? 'http://127.0.0.1:9333';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
const ADB = process.env.ADB ?? 'adb';
const SERIAL = process.env.SERIAL;
const input = (...args) => execFileSync(ADB, [...(SERIAL ? ['-s', SERIAL] : []), 'shell', 'input', ...args.map(String)], { stdio: 'ignore', timeout: 20000 });
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} real phone: ${name}${detail ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
await S('Runtime.enable');
async function evaluate(fn, arg) {
  const expression = `(${fn})(${JSON.stringify(arg ?? null)})`;
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
const rect = (sel) =>
  evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, sel);
// page CSS px -> screen px, from two taps at known screen points (the page may be zoomed: WIDTH below)
let cal = { sx: 3, sy: 3, ox: 0, oy: 0 };
async function tapAt(sx, sy) {
  await evaluate(() => {
    window.__tapAt = undefined;
    const layer = document.createElement('div');
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
    layer.addEventListener('pointerdown', (e) => {
      window.__tapAt = { x: e.clientX, y: e.clientY };
      setTimeout(() => layer.remove(), 200);
    });
    document.body.appendChild(layer);
  });
  input('tap', sx, sy);
  await until(() => Boolean(window.__tapAt), null, 5000);
  const t = await evaluate(() => window.__tapAt);
  await wait(350);
  return t;
}
async function calibrate() {
  const a = await tapAt(300, 900);
  const b = await tapAt(780, 1500);
  const sx = (780 - 300) / (b.x - a.x);
  const sy = (1500 - 900) / (b.y - a.y);
  cal = { sx, sy, ox: 300 - a.x * sx, oy: 900 - a.y * sy };
}
const screen = (p) => [Math.round(p.x * cal.sx + cal.ox), Math.round(p.y * cal.sy + cal.oy)];
const along = (box, f) => ({ x: box.x + 8 + (box.width - 16) * f, y: box.y + box.height / 2 });
async function tapCenter(sel) {
  const r = await rect(sel);
  input('tap', ...screen({ x: r.x + r.width / 2, y: r.y + r.height / 2 }));
}
async function shot(name) {
  const { data } = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${shots}/seek-realphone-${name}.png`, Buffer.from(data, 'base64'));
}
/** every event the seek bar sees, in order (cleared per gesture) */
const watch = (sel) =>
  evaluate((s) => {
    const el = document.querySelector(s);
    window.__ev = [];
    if (el.__watched) return;
    el.__watched = true;
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchend', 'touchcancel', 'input', 'change'])
      el.addEventListener(t, (e) => window.__ev.push(`${t}${t === 'input' || t === 'change' ? `=${Math.round(e.target.value / 1000)}` : ''}`), { passive: true });
  }, sel);
const events = () => evaluate(() => (window.__ev ?? []).join(' '));
const read = (sel) =>
  evaluate((s) => {
    const p = window.__hostcaster.player;
    const el = p.active?.element;
    return { pos: p.state.positionMs, audio: el ? el.currentTime * 1000 : -1, bar: Number(document.querySelector(s)?.value ?? -1), dur: p.state.durationMs, id: p.state.track?.id };
  }, sel);
const TOL = 7000;
const near = (a, b) => Math.abs(a - b) <= TOL;
const fmt = (r) => `pos ${Math.round(r.pos / 1000)}s audio ${Math.round(r.audio / 1000)}s bar ${Math.round(r.bar / 1000)}s of ${Math.round(r.dur / 1000)}s`;

async function seekChecks(tag, sel) {
  await watch(sel);
  let box = await rect(sel);
  const dur = (await read(sel)).dur;
  // tap
  input('tap', ...screen(along(box, 0.5)));
  await wait(900);
  let r = await read(sel);
  check(`${tag}: tap moves the song to the middle`, near(r.pos, dur * 0.5) && near(r.audio, dur * 0.5), `${fmt(r)}; ${await events()}`);
  await wait(2200);
  let later = await read(sel);
  check(`${tag}: bar keeps moving after the tap`, later.audio > r.audio + 1200 && near(later.bar, later.audio), fmt(later));
  // drag, hold, let go
  await watch(sel);
  box = await rect(sel);
  const a = screen(along(box, 0.2));
  const b = screen(along(box, 0.8));
  input('motionevent', 'DOWN', ...a);
  for (let i = 1; i <= 10; i++) input('motionevent', 'MOVE', Math.round(a[0] + ((b[0] - a[0]) * i) / 10), a[1]);
  await wait(500);
  const held = await read(sel);
  check(`${tag}: bar follows the finger while held`, near(held.bar, dur * 0.8), fmt(held));
  input('motionevent', 'UP', ...b);
  await wait(900);
  r = await read(sel);
  check(`${tag}: drag moves the song`, near(r.pos, dur * 0.8) && near(r.audio, dur * 0.8), `${fmt(r)}; ${await events()}`);
  await wait(2200);
  later = await read(sel);
  check(`${tag}: bar keeps moving after the drag`, later.audio > r.audio + 1200 && near(later.bar, later.audio), fmt(later));
  // a quick swipe (no hold) to near the end: the next song plays and the bar follows it
  const id = later.id;
  box = await rect(sel);
  input('swipe', ...screen(along(box, 0.85)), ...screen(along(box, 0.995)), 250);
  const next = await until((old) => window.__hostcaster.player.state.track?.id !== old && window.__hostcaster.player.state.positionMs > 1500, id, 25000);
  await wait(1500);
  const n = await read(sel);
  check(`${tag}: next song plays and the bar follows it`, next && n.audio < 25000 && near(n.bar, n.audio), fmt(n));
}

// WIDTH=1280: the tablet layout (player bar) on the phone's screen: a wider page, zoomed out to fit
const width = Number(process.env.WIDTH ?? 0);
const widen = () =>
  width &&
  evaluate((w) => {
    document.querySelector('meta[name=viewport]')?.setAttribute('content', `width=${w}`);
  }, width);
// songs: from the build's seek-media folder into the library, through the file picker's change event
await S('Page.navigate', { url: `${base}/#/library` });
await until(() => Boolean(window.__hostcaster?.player && document.querySelector('[data-testid=pick-files]')), null, 30000);
await widen();
await wait(800);
const have = await evaluate(() => document.querySelectorAll('.aw-track').length);
if (have < 3) {
  await evaluate(async () => {
    const dt = new DataTransfer();
    for (const n of [1, 2, 3]) {
      const blob = await (await fetch(`/seek-media/${n}.mp3`)).blob();
      dt.items.add(new File([blob], `${n}.mp3`, { type: 'audio/mpeg' }));
    }
    const el = document.querySelector('[data-testid=pick-files]');
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  check('songs imported', await until(() => document.querySelectorAll('.aw-track').length >= 3, null, 40000));
}
await calibrate();
await wait(500);
await tapCenter('.aw-track__main');
const isPlaying = () => until(() => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 500, null, 8000);
let plays = await isPlaying();
if (!plays) {
  // the tap paused a song restored from the last run: press play (as a user gesture)
  await S('Runtime.evaluate', { expression: 'window.__hostcaster.player.play()', awaitPromise: true, userGesture: true });
  plays = await isPlaying();
}
check('plays', plays);
const desktop = await evaluate(() => document.querySelector('.aw-app')?.dataset.layout === 'desktop');
if (desktop) await seekChecks('bar', '.aw-playerbar input[aria-label=Seek]');
if (desktop) {
  await evaluate(() => {
    location.hash = '#/now-playing';
  });
  await until(() => Boolean(document.querySelector('.aw-np input[aria-label=Seek]')), null, 20000);
} else {
  await tapCenter('.aw-mini__open');
  await until(() => Boolean(document.querySelector('.aw-np input[aria-label=Seek]')), null, 20000);
}
await wait(1200);
await calibrate();
await seekChecks('Now Playing', '.aw-np input[aria-label=Seek]');
await shot(desktop ? 'tablet' : 'phone');
await evaluate(() => window.__hostcaster.player.pause());
ws.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
