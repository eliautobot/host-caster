// Accounts + server end-to-end check (owner: server agent): onboarding, sign-in (local, Google, X through a fake
// OAuth server), sync, Connections (Google services, ICS/RSS, AI apps over MCP), Account, Data, delete account.
// Usage: node e2e/server.e2e.mjs [distDir] [port]
// Starts its own Host-Caster server (real node process) on 127.0.0.1:<port> serving <distDir>, plus fake providers.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startFakeProviders } from '../../server/test/fake-providers.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? '/tmp/hostcaster-server-dist');
const port = Number(process.argv[3] ?? 8664);
const base = `http://127.0.0.1:${port}`;
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
mkdirSync(shots, { recursive: true });

const results = [];
const errors = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
  console.log(results.at(-1));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Screenshot without the toast stack (toasts from earlier steps would cover the page). */
async function shot(page, name) {
  const hide = (v) => page.evaluate((v) => document.querySelectorAll('.aw-toaster').forEach((t) => (t.style.visibility = v)), v).catch(() => undefined);
  await hide('hidden');
  await page.screenshot({ path: join(shots, `server-${name}.png`) });
  await hide('');
}
const hash = (page) => page.evaluate(() => location.hash);
const visible = (loc, timeout = 8000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const api = (page, method, path, body) =>
  page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p, {
        method: m,
        headers: { 'x-hostcaster': '1', ...(b ? { 'content-type': 'application/json' } : {}) },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
    [method, path, body],
  );
/** Nothing sticks out on the right: the page does not scroll sideways and no content box ends past the viewport. */
const noOverflow = (page) =>
  page.evaluate(() => {
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) return false;
    for (const el of document.querySelectorAll('.aw-acct-stack *, .aw-bare__inner *, .aw-settings__nav *')) {
      if (el.closest('[aria-hidden="true"], .aw-bare__mark')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        console.log(`overflow: ${el.tagName}.${el.className} right=${Math.round(r.right)}`);
        return false;
      }
    }
    return true;
  });

// ------------------------------------------------------------------------------------------------ servers
const cleanups = [];
const fake = await startFakeProviders({ after: (fn) => cleanups.push(fn) });
const dataDir = mkdtempSync(join(tmpdir(), 'hostcaster-e2e-'));
const { PUBLIC_URL: _unused, ...fakeEnv } = fake.env;
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: resolve(here, '../../server'),
  env: {
    ...process.env,
    ...fakeEnv,
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_URL: base,
    DATA_DIR: dataDir,
    APP_DIST: dist,
    ALLOW_LOCAL_ACCOUNTS: 'true',
    FETCH_ALLOW: '127.0.0.1',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 100; i++) {
  if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
  await wait(100);
}

const browser = await chromium.launch();
let current; // last page, for a screenshot when a step throws
const listen = (page, tag) => {
  current = page;
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.name}: ${e.message} @ ${(e.stack ?? '').split('\n').slice(1, 3).join(' ')}`));
  page.on('console', (m) => {
    if (m.text().startsWith('overflow:')) errors.push(`${tag}: ${m.text()}`);
    else if (m.type() === 'error' && !/Failed to load resource|status of 40[139]/.test(m.text())) errors.push(`${tag}: ${m.text()}`);
  });
};

try {
  // ---------------------------------------------------------------------------------------------- desktop, local
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  listen(page, 'desktop');

  // first run -> onboarding
  await page.goto(`${base}/`);
  check('first run opens onboarding', await page.waitForURL(/#\/welcome/, { timeout: 10000 }).then(() => true, () => false), await hash(page));
  await page.getByRole('heading', { name: 'Your own radio station' }).waitFor();
  await wait(300);
  await shot(page, 'welcome-desktop');
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByLabel('Your name').fill('Sam');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('heading', { name: 'Pick your hosts' }).waitFor();
  const hostCards = page.locator('.aw-onb-host');
  check('hosts step lists hosts', (await hostCards.count()) > 0, `${await hostCards.count()} hosts`);
  await wait(600);
  await shot(page, 'onb-hosts-desktop');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('heading', { name: 'Where is your music?' }).waitFor();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('heading', { name: 'How should your hosts think?' }).waitFor();
  const brainChoices = await page.getByRole('radio').allTextContents();
  check('brain step: AI choices only, plus Set up later', !brainChoices.some((t) => /built-?in/i.test(t)) && brainChoices.some((t) => /Set up later/.test(t)) && brainChoices.some((t) => /Your ChatGPT plan/.test(t)), brainChoices.map((t) => t.slice(0, 22)).join(' | '));
  await page.getByRole('radio', { name: /A model on my network/ }).click();
  await shot(page, 'onb-brain-desktop');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('heading', { name: /You are on air, Sam/ }).waitFor();
  check('done step offers the follow-up', await visible(page.getByRole('button', { name: 'Connect your model' })));
  await shot(page, 'onb-done-desktop');
  await page.getByRole('button', { name: 'Later, take me home' }).click();
  await page.waitForURL(/#\/$/);
  check('no AI connected yet: Home says the hosts read scripted lines', await visible(page.locator('[data-fallback-banner]')));
  await page.reload();
  await wait(1500);
  check('onboarding only on the first run', (await hash(page)) === '#/', await hash(page));

  // settings in local mode
  await page.goto(`${base}/#/settings`);
  const meCard = page.locator('.aw-settings__me');
  await meCard.waitFor();
  check('settings card: local mode', (await meCard.innerText()).includes('Local only') && (await meCard.innerText()).includes('Sam'));
  await shot(page, 'settings-local-desktop');

  // sign-in screen
  await meCard.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Sign in to sync' }).waitFor();
  check('sign-in offers Google', await visible(page.getByRole('button', { name: 'Continue with Google' })));
  check('sign-in offers X', await visible(page.getByRole('button', { name: 'Continue with X' })));
  check('sign-in offers device only', await visible(page.getByRole('button', { name: 'Use on this device only' })));
  await shot(page, 'signin-desktop');

  // local account
  await page.getByRole('button', { name: 'Use email and password' }).click();
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Your name').fill('Sam Rivers');
  await page.getByLabel('Email').fill('sam@example.com');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  check('short password is refused', await visible(page.getByText(/at least 8|Password/i)));
  await page.getByLabel('Password').fill('a good long password');
  await page.getByRole('button', { name: 'Create account' }).click();
  check('local sign-up signs in', await visible(page.getByText(/Signed in as Sam Rivers/)));
  await page.waitForURL(/#\/settings$/, { timeout: 8000 }).catch(() => undefined);
  check('back to settings after sign-in', (await hash(page)) === '#/settings', await hash(page));
  await wait(1500);
  const meText = await meCard.innerText();
  check('settings card shows the account', meText.includes('sam@example.com') && meText.includes('Account'), meText.replace(/\n/g, ' | '));

  // sync: the local hosts/stations/profile went up
  let synced = false;
  for (let i = 0; i < 30 && !synced; i++) {
    const s = await api(page, 'GET', '/api/sync');
    synced = s.status === 200 && (s.body?.doc?.hosts?.length ?? 0) > 0 && s.body?.doc?.profile?.name === 'Sam';
    if (!synced) await wait(500);
  }
  check('first sync pushes hosts, stations and profile', synced);

  // account page
  await page.goto(`${base}/#/settings/account`);
  check('account shows Synced', await visible(page.getByText('Synced').first(), 15000));
  check('account lists sign-in ways', await visible(page.getByText('Ways to sign in')));
  await wait(300);
  await shot(page, 'account-local-desktop');

  // link X from Account
  await page.locator('.aw-acct-row', { hasText: /^X/ }).getByRole('button', { name: 'Link' }).click();
  check('X linked', await visible(page.getByText('X connected'), 15000));
  await page.waitForURL(/#\/settings\/account/);
  check('X row shows the handle', await visible(page.locator('.aw-acct-row', { hasText: 'radiofan' })));

  // connections: link Google with calendar + gmail
  fake.state.googleUser = 'sam';
  await page.goto(`${base}/#/settings/connections`);
  await page.getByRole('button', { name: 'Link Google' }).click();
  check('Google linked', await visible(page.getByText('Google connected'), 15000));
  await page.waitForURL(/#\/settings\/connections$/, { timeout: 8000 }).catch(() => undefined);
  check('Google card connected', await visible(page.getByText('Connected as sam@gmail.test')));
  const calToggle = page.getByRole('switch', { name: 'Google Calendar' });
  check('calendar switched on after consent', await calToggle.isChecked().catch(() => false));
  const calRow = page.locator('.aw-acct-row', { hasText: 'Google Calendar' });
  await calRow.getByRole('button', { name: 'Check' }).click();
  check('calendar check reads events', await visible(calRow.getByText(/events? in the next 36 hours/)));
  await page.getByRole('switch', { name: 'Gmail' }).click();
  const mailRow = page.locator('.aw-acct-row', { hasText: 'Gmail' });
  await mailRow.getByRole('button', { name: 'Check' }).click();
  check('gmail check reads unread', await visible(mailRow.getByText(/3 unread, 1 important/)));
  // YouTube was not granted: switching it on asks Google again (incremental consent)
  await page.getByRole('switch', { name: 'YouTube' }).click();
  check('youtube consent returns', await visible(page.getByText('Google connected'), 15000));
  await page.waitForURL(/#\/settings\/connections$/, { timeout: 8000 }).catch(() => undefined);
  await wait(800);
  check('youtube switched on', await page.getByRole('switch', { name: 'YouTube' }).isChecked().catch(() => false));
  const gs = await api(page, 'GET', '/api/google/status');
  check('google status has short + full scopes', gs.body?.scopes?.includes('youtube') && gs.body.scopes.includes('https://www.googleapis.com/auth/youtube.readonly'), JSON.stringify(gs.body?.scopes));
  const auth = fake.log.filter((l) => l.path === '/google/auth').at(-1);
  check('incremental consent asks offline + granted scopes', auth?.query.access_type === 'offline' && auth?.query.include_granted_scopes === 'true' && /youtube/.test(auth?.query.scope));

  // ICS + RSS through the server
  await page.getByLabel('Calendar link').fill(`${fake.base}/feed.ics`);
  await page.getByLabel('Calendar link').press('Enter');
  check('ICS link added', await visible(page.getByText('Calendar added')));
  await page.getByLabel('Feed link').fill(`${fake.base}/feed.rss`);
  await page.getByLabel('Feed link').press('Enter');
  check('RSS feed added', await visible(page.getByText('Feed added')));
  await page.getByLabel('Feed link').fill(`${fake.base}/big`);
  await page.getByLabel('Feed link').press('Enter');
  check('non-feed is refused', await visible(page.getByText(/not an RSS|too big|large/i)));
  const ssrf = await api(page, 'POST', '/api/fetch-text', { url: 'http://169.254.169.254/latest/meta-data' });
  check('fetch-text blocks cloud metadata', ssrf.status >= 400, `${ssrf.status} ${ssrf.body?.error?.code}`);

  // AI apps: make a connection, call it over MCP like ChatGPT would
  await page.getByLabel('Connection name').fill('ChatGPT');
  await page.getByRole('button', { name: 'New connection' }).click();
  const conRow = page.locator('.aw-acct-row', { hasText: 'ChatGPT' });
  check('connection row with URL', await visible(conRow.getByText(/\/mcp\//)));
  await conRow.getByRole('button', { name: 'Copy URL' }).click();
  const mcpUrl = await page.evaluate(() => navigator.clipboard.readText());
  check('copied URL is the MCP endpoint', mcpUrl.startsWith(`${base}/mcp/`), mcpUrl.replace(/mcp\/.+/, 'mcp/…'));
  const rpc = async (id, method, params) => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return r.json();
  };
  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  const tools = await rpc(2, 'tools/list', {});
  const names = tools.result?.tools?.map((t) => t.name) ?? [];
  check('MCP initialize + tools/list', Boolean(init.result?.serverInfo) && ['now_playing', 'list_hosts', 'send_note_to_hosts', 'queue_segment', 'request_song', 'add_life_event'].every((n) => names.includes(n)), names.join(','));
  const sent = await rpc(3, 'tools/call', { name: 'send_note_to_hosts', arguments: { text: 'Sam passed the exam today' } });
  check('MCP tools/call', !sent.result?.isError, JSON.stringify(sent.result?.content?.[0]?.text ?? sent.error).slice(0, 80));
  const inbox = await api(page, 'GET', '/api/inbox');
  check('note lands in the inbox', JSON.stringify(inbox.body).includes('Sam passed the exam today'));
  await page.locator('.aw-acct-howto summary', { hasText: 'Connect ChatGPT' }).click();
  await wait(300);
  await shot(page, 'connections-desktop');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(200);
  await shot(page, 'connections-bottom-desktop');

  // account with Google + X + password
  await page.goto(`${base}/#/settings/account`);
  await page.getByText('Ways to sign in').waitFor();
  await wait(500);
  check('account lists Google with scopes', await visible(page.locator('.aw-acct-row', { hasText: /Calendar, Gmail, YouTube/ })));
  await shot(page, 'account-desktop');

  // data: export, import
  await page.goto(`${base}/#/settings/data`);
  await page.getByRole('button', { name: 'Export backup' }).waitFor();
  await wait(800);
  await shot(page, 'data-desktop');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  const backupPath = join(dataDir, 'backup.json');
  await download.saveAs(backupPath);
  const backupText = readFileSync(backupPath, 'utf8');
  check('backup file has hosts', /"hosts"/.test(backupText) && backupText.length > 200, `${backupText.length} bytes`);
  check('backup has no API keys by default', !/sk-[A-Za-z0-9]{6}/.test(backupText));
  await page.locator('input[type=file][accept*="json"]').setInputFiles(backupPath);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  check('backup restored', await visible(page.getByText('Backup restored')));
  await page.waitForLoadState('load');
  await wait(2000);
  // a restored backup never belonged to the account on this device: when it holds songs or records of its own, the
  // app asks once whether they join the account (this backup came from the same account)
  if (await visible(page.locator('[data-testid="join-question"]'), 5000)) {
    await page.getByRole('button', { name: 'Add them' }).click();
    await wait(1500);
  }

  // sign out: the account's data leaves this device (it stays in the account), a clean first run
  await page.goto(`${base}/#/settings/account`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  check('signed out, the data is safe in the account', await visible(page.getByText('Your stations and settings are safe in your account.'), 15000));
  await page.goto(`${base}/#/settings/account`);
  check('signed out', await visible(page.getByText('You are in local mode')));
  await page.goto(`${base}/#/settings`);
  check('the account profile left the device after sign-out', !(await page.locator('.aw-settings__me').innerText()).includes('Sam'));

  // sign back in with Google: same account (Google identity is linked), its data comes back
  await page.goto(`${base}/#/sign-in`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  check('Google sign-in returns', await visible(page.getByText(/Signed in as Sam Rivers/), 15000));
  await page.goto(`${base}/#/settings`);
  check('the account profile is back after signing in', await visible(page.locator('.aw-settings__me', { hasText: 'Sam' }), 15000));
  await ctx.close();

  // ---------------------------------------------------------------------------------------------- new device, X sign-in, delete
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p2 = await ctx2.newPage();
  listen(p2, 'device2');
  await p2.goto(`${base}/`);
  await p2.getByRole('button', { name: 'I have an account' }).click();
  await p2.getByRole('button', { name: 'Continue with X' }).click();
  check('X sign-in on a new device', await visible(p2.getByText(/Signed in as Sam Rivers/), 15000));
  await wait(2500);
  check('onboarding skipped: the account did it already', (await hash(p2)) === '#/', await hash(p2));
  // the synced profile + hosts came down
  await wait(2500);
  await p2.goto(`${base}/#/settings`);
  const me2 = await p2.locator('.aw-settings__me').innerText();
  check('synced profile on the new device', me2.includes('Sam'), me2.replace(/\n/g, ' | '));
  fake.state.denyNext = true;
  await p2.goto(`${base}/#/settings/account`);
  await p2.getByRole('button', { name: 'Sign out', exact: true }).click();
  // signing out restarts the app on a clean first run
  await visible(p2.getByText('Your stations and settings are safe in your account.'), 15000);
  await p2.goto(`${base}/#/sign-in`);
  await p2.getByRole('button', { name: 'Continue with Google' }).click();
  check('cancelled consent shows a clear error', await visible(p2.getByText('You cancelled the sign-in.'), 15000));
  await shot(p2, 'signin-error-desktop');
  // a brand-new Google user, then delete that account
  fake.state.googleUser = 'gina';
  await p2.getByRole('button', { name: 'Continue with Google' }).click();
  check('new Google account', await visible(p2.getByText(/Signed in as User gina/), 15000));
  await p2.goto(`${base}/#/settings/account`);
  await p2.getByRole('button', { name: 'Delete account' }).click();
  await p2.getByLabel('Type "DELETE" to confirm').fill('DELETE');
  await wait(500);
  await shot(p2, 'delete-account-desktop');
  await p2.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click();
  check('account deleted', await visible(p2.getByText('Account deleted')));
  const me = await api(p2, 'GET', '/api/me');
  check('deleted account is signed out', me.status === 401);
  await ctx2.close();

  // ---------------------------------------------------------------------------------------------- phone 390x844
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const ph = await ctx3.newPage();
  listen(ph, 'phone');
  await ph.goto(`${base}/`);
  await ph.waitForURL(/#\/welcome/, { timeout: 10000 }).catch(() => undefined);
  await ph.getByRole('heading', { name: 'Your own radio station' }).waitFor();
  await wait(300);
  await shot(ph, 'welcome-phone');
  check('phone welcome fits', await noOverflow(ph));
  await ph.getByRole('button', { name: 'Get started' }).click();
  await ph.getByRole('button', { name: 'Next' }).click();
  await ph.getByRole('heading', { name: 'Pick your hosts' }).waitFor();
  await wait(600);
  await shot(ph, 'onb-hosts-phone');
  check('phone hosts step fits', await noOverflow(ph));
  await ph.getByRole('button', { name: 'Next' }).click();
  await ph.getByRole('button', { name: 'Next' }).click();
  await wait(600);
  await shot(ph, 'onb-brain-phone');
  await ph.getByRole('button', { name: 'Next' }).click();
  await ph.getByRole('button', { name: 'Later, take me home' }).click();
  await ph.waitForURL(/#\/$/);
  await ph.goto(`${base}/#/sign-in`);
  await ph.getByRole('heading', { name: 'Sign in to sync' }).waitFor();
  await wait(200);
  await shot(ph, 'signin-phone');
  check('phone sign-in fits', await noOverflow(ph));
  await ph.getByRole('button', { name: 'Use email and password' }).click();
  await ph.getByLabel('Email').fill('sam@example.com');
  await ph.getByLabel('Password').fill('a good long password');
  await ph.getByRole('button', { name: 'Sign in', exact: true }).click();
  check('phone local sign-in', await visible(ph.getByText(/Signed in as Sam Rivers/)));
  await wait(2000);
  for (const [route, name] of [
    ['/settings', 'settings'],
    ['/settings/account', 'account'],
    ['/settings/connections', 'connections'],
    ['/settings/data', 'data'],
  ]) {
    await ph.goto(`${base}/#${route}`);
    await wait(1200);
    await shot(ph, `${name}-phone`);
    check(`phone ${name} fits`, await noOverflow(ph));
  }
  // start over: delete this device's data -> signed out, first run again
  await ph.getByRole('button', { name: 'Delete data on this device' }).click();
  await ph.getByRole('dialog').getByRole('button', { name: 'Delete everything' }).click();
  check('wiped device starts fresh', await ph.waitForURL(/#\/welcome/, { timeout: 15000 }).then(() => true, () => false), await hash(ph));
  const after = await api(ph, 'GET', '/api/me');
  check('wiped device is signed out', after.status === 401);
  await ctx3.close();
} catch (err) {
  check('run finished', false, err.stack?.split('\n').slice(0, 3).join(' / '));
  await current?.screenshot({ path: join(shots, 'server-fail.png') }).catch(() => undefined);
  console.log(`failed at ${await current?.evaluate(() => location.href).catch(() => '?')}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  for (const fn of cleanups) await fn();
  rmSync(dataDir, { recursive: true, force: true });
}

if (errors.length) console.log(`page errors:\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
