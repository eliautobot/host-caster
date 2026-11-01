// Launch smoke test of a PACKAGED Host-Caster desktop app, for every system (CI runs it on Windows, macOS and Linux
// after packaging; it needs no keys, no network and no screen tricks beyond Xvfb on Linux).
//   HC_EXE=<installed or unpacked app binary> node e2e/smoke.mjs
//     Windows: %LOCALAPPDATA%\Programs\Host-Caster\Host-Caster.exe (after the silent NSIS install) or the portable zip's
//     macOS:   <copied from the dmg>/Host-Caster.app/Contents/MacOS/Host-Caster
//     Linux:   the AppImage (with APPIMAGE_EXTRACT_AND_RUN=1 when FUSE 2 is missing) or /opt/Host-Caster/host-caster
// env: SHOTS (screenshots, default <tmp>/hc-smoke-shots), OUT (result JSON), HC_SMOKE_LABEL (names the screenshots).
// Checks: the app starts and opens its window on app://host-caster, the page has the desktop bridge (and no Node), the
// local helper answers only with the launch secret, the sign-in screen shows and reaches a Host-Caster server (the
// self-hosted server of this repo, started here on 127.0.0.1), Settings > Desktop app opens with the ChatGPT plan off,
// the update check reads a manifest, nothing logs a page error, and the app is still running after a short idle.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const { _electron } = createRequire(join(repo, 'app/package.json'))('playwright');

const EXE = process.env.HC_EXE;
if (!EXE) {
  console.error('Set HC_EXE to the packaged app binary');
  process.exit(2);
}
const label = process.env.HC_SMOKE_LABEL ?? process.platform;
const shots = process.env.SHOTS ?? join(tmpdir(), 'hc-smoke-shots');
const out = process.env.OUT ?? join(shots, `smoke-${label}.json`);
const version = JSON.parse(readFileSync(join(repo, 'app/package.json'), 'utf8')).version;
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'hc-smoke-'));

const results = [];
let failed = 0;
const t0 = Date.now();
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`);
  if (!ok) failed++;
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${results.at(-1)}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: join(shots, `${label}-${name}.png`) }).catch(() => undefined);

// ---------------------------------------------------------------------------------------------- a server to sign in to
// the self-hosted server from this repo (no online edition, no keys), on a free port
const serverPort = await new Promise((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});
const serverBase = `http://127.0.0.1:${serverPort}`;
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: join(repo, 'server'),
  env: { ...process.env, PORT: String(serverPort), HOST: '127.0.0.1', PUBLIC_URL: serverBase, DATA_DIR: join(work, 'server-data'), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => (serverErr = (serverErr + d).slice(-2000)));
let serverUp = false;
for (let i = 0; i < 80 && !serverUp; i++) {
  serverUp = await fetch(`${serverBase}/api/health`).then((r) => r.ok, () => false);
  if (!serverUp) await wait(250);
}
check('self-hosted server for the sign-in screen', serverUp, serverUp ? serverBase : serverErr.split('\n').slice(-3).join(' '));

// the update manifest: this very version, so no notice (the check itself must work)
const manifest = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  const code = (() => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e4 + Number(m[3]) * 100 : 1;
  })();
  res.end(JSON.stringify({ version, versionCode: code, notes: [], minimumSupported: 0, files: {} }));
});
await new Promise((r) => manifest.listen(0, '127.0.0.1', r));

// ---------------------------------------------------------------------------------------------- the app
const errors = [];
let app;
try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [],
    timeout: 120000,
    env: {
      ...process.env,
      HOSTCASTER_SERVER: serverBase,
      HOSTCASTER_USER_DATA: join(work, 'user-data'),
      HOSTCASTER_NO_PROTOCOL: '1',
      HOSTCASTER_PASSWORD_STORE: 'basic',
      HOSTCASTER_UPDATE_URL: `http://127.0.0.1:${manifest.address().port}/latest.json`,
    },
  });
  const page = await app.firstWindow({ timeout: 60000 });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|401/.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 200)));
  await page.waitForLoadState('domcontentloaded');
  check('the app starts and opens its window on app://host-caster', page.url().startsWith('app://host-caster/'), page.url());
  check('window title', (await page.title()) === 'Host-Caster', await page.title());
  // the window shows on ready-to-show, which can come a moment after the page loads (slow CI runners, no window manager)
  let visible = false;
  for (const t0 = Date.now(); !visible && Date.now() - t0 < 15000; await new Promise((r) => setTimeout(r, 250))) {
    visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
  }
  check('the window is shown', visible);
  await page.locator('#root *').first().waitFor({ timeout: 30000 }).catch(() => undefined);
  await shot(page, '1-start');

  const bridge = await page.evaluate(() => ({
    version: window.hostcasterDesktop?.version,
    platform: window.hostcasterDesktop?.platform,
    helper: window.hostcasterDesktop?.helper?.url,
    node: typeof require !== 'undefined' || typeof process !== 'undefined',
  }));
  check(`desktop bridge with version ${version} on ${process.platform}, no Node in the page`, bridge.version === version && bridge.platform === process.platform && !bridge.node, JSON.stringify(bridge));
  const guard = await page.evaluate(async (h) => {
    const bare = await fetch(`${h}/health`).then((r) => r.status, () => 0);
    const own = await fetch(`${h}/health`, { headers: { 'x-hc-helper': window.hostcasterDesktop.helper.token } }).then((r) => r.status, () => 0);
    return { bare, own };
  }, bridge.helper);
  check('local helper on 127.0.0.1 answers only with the launch secret', /^http:\/\/127\.0\.0\.1:\d+$/.test(bridge.helper ?? '') && guard.bare === 401 && guard.own === 200, JSON.stringify(guard));

  // sign-in screen, reaching the server
  await page.goto('app://host-caster/#/sign-in');
  const heading = page.getByRole('heading', { name: /Sign in/ }).first();
  const signIn = await heading.waitFor({ timeout: 30000 }).then(() => true, () => false);
  check('sign-in screen visible', signIn, signIn ? await heading.textContent() : page.url());
  // sign-in choices show only once the server answered (its /api/config says which ones it has)
  const choices = page.getByText(/Continue with|Sign in with email|Use email and password|no sign-in set up yet/).first();
  const reached = await choices.waitFor({ timeout: 20000 }).then(() => true, () => false);
  const notAnswering = await page.getByText(/not answering|No server set yet/).count();
  check('the sign-in screen reaches the server', reached && !notAnswering, reached ? await choices.textContent() : 'no sign-in choices');
  await shot(page, '2-sign-in');

  // Settings > Desktop app
  await page.goto('app://host-caster/#/settings/desktop');
  const planSwitch = page.getByRole('switch', { name: /ChatGPT plan brains on this computer/ });
  const settingsOk = await planSwitch.waitFor({ timeout: 20000 }).then(() => true, () => false);
  check('Settings > Desktop app opens, ChatGPT plan off by default', settingsOk && (await planSwitch.getAttribute('aria-checked')) === 'false');
  await shot(page, '3-desktop-settings');

  const upd = await page.evaluate(() => window.hostcasterDesktop.checkForUpdate());
  check('update check reads the manifest (no newer version)', upd?.checked === true && !upd.update && upd.latest === version, JSON.stringify(upd));

  await wait(5000);
  const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).then((n) => n > 0, () => false);
  check('still running after idling', alive && !page.isClosed());
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('the smoke test finished', false, err.message.split('\n')[0]);
} finally {
  await app?.close().catch(() => undefined);
  server.kill();
  await new Promise((r) => manifest.close(r));
  await wait(500);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

writeFileSync(out, `${JSON.stringify({ exe: EXE, version, platform: process.platform, failed, results }, null, 2)}\n`);
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
