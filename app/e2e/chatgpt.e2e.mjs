// "Use your ChatGPT plan" end to end against a fake OpenAI (server/test/fake-chatgpt.js): Settings, Brains at
// 1440x900 and 390x844, dark and light; sign-in through the 127.0.0.1 callback (browser on the server's machine) and
// by pasting the address (any other device); welcome, model picker, Test, Save, usage limit, Disconnect; then the
// radio on the plan: a break written on it, then a usage limit: the scripted fallback stands in and Home says why.
// Usage: node e2e/chatgpt.e2e.mjs [distDir] [port] [mediaDir]
// env: VOICE_URL (OpenAI-compatible TTS, e.g. Kokoro .../v1), SHOTS (screenshot dir). No real ChatGPT account.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startFakeChatGPT } from '../../server/test/fake-chatgpt.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? '/tmp/hostcaster-siwc-dist');
const port = Number(process.argv[3] ?? 8671);
const media = process.argv[4] ?? '/tmp/hostcaster-e2e/radio-media';
const VOICE_URL = process.env.VOICE_URL ?? 'http://localhost:8880/v1';
const base = `http://127.0.0.1:${port}`;
const shots = process.env.SHOTS ?? '/tmp/hostcaster-siwc-shots';
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
async function shot(page, name) {
  const hide = (v) => page.evaluate((v) => document.querySelectorAll('.aw-toaster').forEach((t) => (t.style.visibility = v)), v).catch(() => undefined);
  await hide('hidden');
  await page.screenshot({ path: join(shots, `siwc-${name}.png`) });
  await hide('');
}
const visible = (loc, timeout = 8000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const api = (page, method, path, body) =>
  page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(p, { method: m, headers: { 'x-hostcaster': '1', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
    [method, path, body],
  );
const noOverflow = (page) =>
  page.evaluate(() => {
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) return false;
    for (const el of document.querySelectorAll('.aw-sheet *, .aw-cgpt-banner *, .aw-entries *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        console.log(`overflow: ${el.tagName}.${el.className} right=${Math.round(r.right)}`);
        return false;
      }
    }
    return true;
  });

// ------------------------------------------------------------------------------------------------ servers
const fake = await startFakeChatGPT({ port: port + 1 });
const dataDir = mkdtempSync(join(tmpdir(), 'hostcaster-siwc-e2e-'));
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: resolve(here, '../../server'),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_URL: base,
    DATA_DIR: dataDir,
    APP_DIST: dist,
    ALLOW_LOCAL_ACCOUNTS: 'true',
    CHATGPT_ISSUER: fake.base,
    CHATGPT_API_BASE: `${fake.base}/v1`,
    CHATGPT_CALLBACK_PORT: '0',
    FETCH_ALLOW: '100.64.0.0/10,127.0.0.1',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 100; i++) {
  if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
  await wait(100);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let current;
const listen = (page, tag) => {
  current = page;
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.text().startsWith('overflow:')) errors.push(`${tag}: ${m.text()}`);
    else if (m.type() === 'error' && !/Failed to load resource|status of 40[139]/.test(m.text())) errors.push(`${tag}: ${m.text()}`);
  });
};
async function signUp(page, email) {
  await page.goto(`${base}/#/settings/brains`);
  const res = await api(page, 'POST', '/api/auth/local/signup', { email, password: 'a good long password', name: 'Sam Rivers' });
  if (res.status !== 201) throw new Error(`signup ${res.status}`);
  await page.reload();
  await page.locator('.aw-cgpt-banner, .aw-entries').first().waitFor();
  await wait(800);
}
async function setTheme(page, label) {
  await page.goto(`${base}/#/settings/appearance`);
  await page.getByRole('tab', { name: label }).click();
  await wait(300);
  await page.goto(`${base}/#/settings/brains`);
  await wait(800);
}
async function signIn(page, email) {
  await page.goto(`${base}/#/settings/brains`);
  const res = await api(page, 'POST', '/api/auth/local/login', { email, password: 'a good long password' });
  if (res.status !== 200) throw new Error(`login ${res.status}`);
  await page.reload();
  await wait(1500);
}

try {
  // ---------------------------------------------------------------------------------------------- desktop, dark
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  listen(page, 'desktop');

  // signed out: the banner is there, the sheet asks for a Host-Caster sign-in first
  await page.goto(`${base}/#/settings/brains`);
  check('banner offers Continue with ChatGPT', await visible(page.locator('.aw-cgpt-banner').getByRole('button', { name: 'Continue with ChatGPT' })));
  check('button carries data-oai-siwc-button', (await page.locator('[data-oai-siwc-button]').count()) >= 1);
  await page.getByRole('button', { name: 'Add a brain' }).click();
  check('add sheet has the subscription tile', await visible(page.getByRole('button', { name: /Use your ChatGPT plan/ })));
  await shot(page, 'add-sheet-desktop-dark');
  await page.getByRole('button', { name: /Use your ChatGPT plan/ }).click();
  check('signed out: sign in to the server first', await visible(page.getByText('Sign in to your Host-Caster server first')));
  await shot(page, 'signed-out-desktop-dark');
  await page.keyboard.press('Escape');

  await signUp(page, 'sam@example.com');
  await shot(page, 'brains-banner-desktop-dark');

  // Continue with ChatGPT: a new tab, fake consent, back to the server's 127.0.0.1 listener
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.locator('.aw-cgpt-banner').getByRole('button', { name: 'Continue with ChatGPT' }).click()]);
  check('waiting panel shows the paste step', await visible(page.getByLabel('Address from the ChatGPT tab')));
  await wait(400);
  await shot(page, 'waiting-desktop-dark');
  await popup.waitForLoadState('domcontentloaded');
  check('callback page says Return to Host-Caster', await visible(popup.getByRole('heading', { name: 'Return to Host-Caster' }), 15000), popup.url().replace(/code=[^&]+/, 'code=***'));
  check('callback page drops the code from the address bar', !popup.url().includes('code='), popup.url());
  await shot(popup, 'callback-tab');
  await popup.close();
  const authorize = fake.log.find((r) => r.path === '/api/accounts/authorize');
  check('authorize: dynamic registration with agent_name_hint Host-Caster', authorize?.query.client_id === 'dynamic_agent_client' && authorize?.query.agent_name_hint === 'Host-Caster');
  check('authorize: host id + PKCE S256', /^urn:ietf:params:oauth:jwk-thumbprint:sha-256:/.test(authorize?.query.ext_agent_host_id ?? '') && authorize?.query.code_challenge_method === 'S256');

  // welcome (once), connected card, models, usage line
  check('welcome dialog appears', await visible(page.getByRole('dialog').getByText('You’re using your ChatGPT plan'), 10000));
  await shot(page, 'welcome-desktop-dark');
  await page.getByRole('button', { name: 'Got it' }).click();
  check('connected account shown', await visible(page.locator('.aw-cgpt-account').getByText('Alex Listener')));
  const model = page.getByRole('combobox', { name: 'Model' });
  await model.waitFor({ timeout: 10000 });
  const options = await model.locator('option').allTextContents();
  check('model picker lists the account models', options.join('|') === 'GPT-6.1 Sol|GPT-6.1 Luna', options.join('|'));
  check('Using ChatGPT plan + Manage usage', await visible(page.locator('.aw-cgpt-using').getByRole('link', { name: /Manage usage/ })));
  check('Manage usage opens ChatGPT usage settings', (await page.locator('.aw-cgpt-using a').getAttribute('href')) === 'https://chatgpt.com/settings/usage');
  await model.selectOption('gpt-6.1-luna');
  await page.getByRole('button', { name: 'Test' }).click();
  check('Test answers on the plan', await visible(page.locator('.aw-statusline--ok'), 20000), (await page.locator('.aw-statusline').first().textContent().catch(() => ''))?.slice(0, 100));
  await shot(page, 'connected-desktop-dark');
  const sent = JSON.parse(fake.log.filter((r) => r.path === '/v1/responses').at(-1)?.body ?? '{}');
  check('Responses request: store false, stream true, instructions, chosen model', sent.store === false && sent.stream === true && Boolean(sent.instructions) && sent.model === 'gpt-6.1-luna' && !('temperature' in sent) && !('max_output_tokens' in sent));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const entry = page.locator('.aw-entry', { hasText: 'ChatGPT plan' });
  check('brain saved and listed as Using ChatGPT plan', await visible(entry.getByText(/Using ChatGPT plan/)));
  check('banner hides once a plan brain exists', !(await page.locator('.aw-cgpt-banner').isVisible()));
  await page.reload();
  await wait(1200);
  check('welcome does not come back', !(await page.getByText('You’re using your ChatGPT plan').isVisible()));
  await shot(page, 'brains-list-desktop-dark');

  // usage limit: Test from the list, then the sheet shows the compact limit message
  await fetch(`${fake.base}/__control`, { method: 'POST', body: JSON.stringify({ failNext: 'limit' }) });
  await entry.getByRole('button', { name: 'Test' }).click();
  check('limit shows in the list', await visible(entry.getByText(/usage limit reached/i), 15000));
  await entry.locator('.aw-entry__open').click();
  check('sheet shows Usage limit reached with Manage usage first', await visible(page.locator('.aw-cgpt-limit').getByRole('link', { name: 'Manage usage' })));
  await shot(page, 'limit-desktop-dark');
  check('desktop sheet fits', await noOverflow(page));

  // disconnect: revoked, back to Continue with ChatGPT (registration kept), other account offered
  await page.locator('.aw-cgpt-account').getByRole('button', { name: 'Disconnect' }).click();
  check('disconnect revokes at ChatGPT', await visible(page.getByText('ChatGPT disconnected')));
  check('fake saw the revocation', fake.log.some((r) => r.path === '/api/accounts/oauth/revoke'));
  check('offers a different account after sign-out', await visible(page.getByRole('button', { name: 'Use a different ChatGPT account' })));
  await wait(1500);
  check('no stray error after disconnect', (await page.locator('.aw-sheet .aw-statusline--error').count()) === 0, await page.locator('.aw-sheet .aw-statusline--error').first().textContent().catch(() => ''));
  await shot(page, 'disconnected-desktop-dark');
  await page.keyboard.press('Escape');
  await ctx.close();

  // ---------------------------------------------------------------------------------------------- phone: paste
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  let captured;
  // a phone has nothing on 127.0.0.1: the tab ends on "can't be reached" and the user copies that address. (Route
  // handlers do not see redirect targets, so the consent answer is read here and the tab shows the error page.)
  await phone.route((url) => url.href.startsWith(`${fake.base}/api/accounts/authorize`), async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    captured = res.headers().location;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>This site can’t be reached</h1><p>127.0.0.1 refused to connect.</p>' });
  });
  const ph = await phone.newPage();
  listen(ph, 'phone');
  await signIn(ph, 'sam@example.com');
  const phEntry = ph.locator('.aw-entry', { hasText: 'ChatGPT plan' });
  check('phone: synced plan brain shows not connected', await visible(phEntry.getByText(/ChatGPT not connected/), 10000));
  await phEntry.locator('.aw-entry__open').click();
  await shot(ph, 'signed-out-phone-dark');
  check('phone sheet fits (signed out)', await noOverflow(ph));
  const [tab] = await Promise.all([phone.waitForEvent('page'), ph.getByRole('button', { name: 'Continue with ChatGPT' }).click()]);
  await tab.waitForLoadState().catch(() => undefined);
  for (let i = 0; i < 50 && !captured; i++) await wait(100);
  check('reauth reuses the issued client id (no new registration)', fake.clients.size === 1 && !fake.log.filter((r) => r.path === '/api/accounts/authorize').at(-1)?.query.agent_name_hint);
  check('tab ended on the 127.0.0.1 address', Boolean(captured), captured?.replace(/code=[^&]+/, 'code=***'));
  await tab.close();
  await ph.getByLabel('Address from the ChatGPT tab').fill(captured ?? '');
  await wait(400);
  check('phone: no "finishes by itself" hint', !(await ph.getByText('finishes by itself').isVisible()));
  await shot(ph, 'paste-phone-dark');
  check('phone waiting panel fits', await noOverflow(ph));
  await ph.getByRole('button', { name: 'Connect', exact: true }).click();
  check('phone: pasted address connects', await visible(ph.locator('.aw-cgpt-account').getByText('Alex Listener'), 10000));
  await ph.getByRole('combobox', { name: 'Model' }).waitFor({ timeout: 10000 });
  await shot(ph, 'connected-phone-dark');
  check('phone connected sheet fits', await noOverflow(ph));
  await ph.getByRole('button', { name: 'Save', exact: true }).click();
  await wait(600);
  await shot(ph, 'brains-list-phone-dark');
  await phone.close();

  // ---------------------------------------------------------------------------------------------- light theme
  for (const [w, h, tag] of [
    [1440, 900, 'desktop'],
    [390, 844, 'phone'],
  ]) {
    const lc = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'light', ...(w < 500 ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
    const lp = await lc.newPage();
    listen(lp, `light-${tag}`);
    await signIn(lp, 'sam@example.com');
    await setTheme(lp, 'Light');
    const lEntry = lp.locator('.aw-entry', { hasText: 'ChatGPT plan' });
    await lEntry.locator('.aw-entry__open').click();
    await lp.locator('.aw-cgpt-account').waitFor({ timeout: 10000 });
    await wait(500);
    const bg = await lp.locator('.aw-cgpt-tile').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    check(`light ${tag}: black ChatGPT tile`, bg === 'rgb(0, 0, 0)', bg);
    await shot(lp, `connected-${tag}-light`);
    check(`light ${tag} fits`, await noOverflow(lp));
    await lp.keyboard.press('Escape');
    await wait(500);
    await lp.getByRole('button', { name: 'Add a brain' }).click();
    await lp.getByRole('button', { name: /Use your ChatGPT plan/ }).waitFor({ timeout: 5000 }).catch(() => undefined);
    await wait(500);
    await shot(lp, `add-sheet-${tag}-light`);
    await lp.keyboard.press('Escape');
    if (tag === 'phone') await setTheme(lp, 'Dark');
    await lc.close();
  }
  // a second Host-Caster user sees no one else's ChatGPT account
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const op = await other.newPage();
  listen(op, 'other-user');
  await signUp(op, 'kim@example.com');
  await setTheme(op, 'Light');
  const st = await api(op, 'GET', '/api/chatgpt/status');
  check('another user is not connected to Sam’s ChatGPT', st.body?.connected === false && !st.body?.account, JSON.stringify(st.body).slice(0, 80));
  await shot(op, 'brains-banner-desktop-light');
  await other.close();

  // ---------------------------------------------------------------------------------------------- radio on the plan
  const rc = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const rp = await rc.newPage();
  listen(rp, 'radio');
  await signIn(rp, 'sam@example.com');
  await setTheme(rp, 'Dark');
  // a voice the server can reach (Kokoro); hosts think on the ChatGPT plan
  await rp.goto(`${base}/#/settings/voices`);
  await rp.getByRole('button', { name: 'Add a voice engine' }).click();
  await rp.getByRole('button', { name: /^Kokoro/ }).click();
  await rp.getByLabel('Server address').fill(VOICE_URL);
  await wait(300);
  await rp.getByRole('button', { name: 'Save', exact: true }).click();
  await rp.locator('.aw-entry__title', { hasText: 'Kokoro' }).waitFor();
  for (const [id, voice] of [
    ['seed-host-maya', 'af_heart'],
    ['seed-host-jules', 'am_michael'],
  ]) {
    await rp.goto(`${base}/#/hosts/${id}`);
    await rp.getByRole('combobox', { name: 'Brain' }).waitFor();
    await rp.getByRole('combobox', { name: 'Brain' }).selectOption({ label: 'ChatGPT plan · gpt-6.1-sol' }).catch(async () => {
      const labels = await rp.getByRole('combobox', { name: 'Brain' }).locator('option').allTextContents();
      await rp.getByRole('combobox', { name: 'Brain' }).selectOption({ label: labels.find((l) => /ChatGPT plan/.test(l)) });
    });
    await rp.getByRole('combobox', { name: 'Speech engine' }).selectOption({ label: 'Kokoro' });
    await rp.waitForFunction((v) => [...document.querySelectorAll('option')].some((o) => o.value === v), voice, { timeout: 20000 });
    await rp.getByRole('combobox', { name: 'Voice', exact: true }).selectOption(voice);
    await rp.getByRole('button', { name: 'Save', exact: true }).click();
    await rp.getByText('All changes saved').or(rp.getByRole('button', { name: /Delete host/ })).first().waitFor();
    await wait(300);
  }
  await rp.goto(`${base}/#/library`);
  const files = readdirSync(media).filter((f) => /\.(mp3|m4a|flac|ogg|wav)$/i.test(f)).sort().map((f) => join(media, f));
  await rp.locator('[data-testid=pick-files]').setInputFiles(files);
  await rp.waitForFunction((n) => document.querySelectorAll('.aw-track').length >= n, files.length, { timeout: 30000 });
  await rp.goto(`${base}/#/stations/seed-station-881`);
  await rp.getByRole('switch', { name: 'Shuffle' }).click();
  await rp.getByRole('slider', { name: 'Talk every' }).focus();
  await rp.keyboard.press('Home');
  await rp.getByRole('button', { name: 'Save', exact: true }).click();
  await wait(500);
  await rp.goto(`${base}/#/`);
  await rp.evaluate(() => {
    window.__breaks = [];
    window.__hostcaster.radio.on('break', (b) => window.__breaks.push(b));
  });
  const before = fake.log.filter((r) => r.path === '/v1/responses').length;
  await rp.getByRole('region', { name: 'Your station' }).getByRole('button', { name: 'Go on air' }).click();
  const until = async (fn, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const v = await rp.evaluate(fn).catch(() => undefined);
      if (v) return v;
      await wait(250);
    }
    return undefined;
  };
  const first = await until(() => window.__breaks[0], 150_000);
  check('a break aired on the ChatGPT plan', Boolean(first), first?.lines.map((l) => l.text).join(' / ').slice(0, 120));
  check('it was written by the plan (Responses API)', fake.log.filter((r) => r.path === '/v1/responses').length > before);
  check('break text came from the plan', /ChatGPT plan/.test(first?.lines.map((l) => l.text).join(' ') ?? ''));
  // the plan hits its limit: the next break is the scripted fallback's, Home says why with Manage usage
  await fetch(`${fake.base}/__control`, { method: 'POST', body: JSON.stringify({ failNext: 'limit' }) });
  const notice = await until(() => window.__hostcaster.radio.state.notice?.includes('usage limit') && window.__hostcaster.radio.state.notice, 200_000);
  check('limit: the scripted fallback stood in', /^The scripted fallback stood in: ChatGPT usage limit reached/.test(notice ?? ''), notice);
  // the notice is set once the stand-in break has aired: the latest break is the scripted fallback's
  const standIn = await rp.evaluate(() => window.__breaks.at(-1));
  check('the stand-in break aired with scripted lines', Boolean(standIn) && !/written on a ChatGPT plan/.test(standIn.lines.map((l) => l.text).join(' ')), standIn?.lines.map((l) => l.text).join(' / ').slice(0, 120));
  await rp.goto(`${base}/#/`);
  check('Home says why, with Manage usage', await visible(rp.locator('.aw-hero__notice').getByRole('link', { name: 'Manage usage' }), 10000), (await rp.locator('.aw-hero__notice').textContent().catch(() => ''))?.slice(0, 160));
  check('Manage usage goes to ChatGPT usage settings', (await rp.locator('.aw-hero__notice a').first().getAttribute('href')) === 'https://chatgpt.com/settings/usage');
  await shot(rp, 'home-limit-desktop-dark');
  await rp.setViewportSize({ width: 390, height: 844 });
  await wait(500);
  await shot(rp, 'home-limit-phone-dark');
  await rp.evaluate(() => window.__hostcaster.radio.stop());
  await rc.close();
} catch (err) {
  check('run finished', false, err.stack?.split('\n').slice(0, 3).join(' / '));
  await current?.screenshot({ path: join(shots, 'siwc-fail.png') }).catch(() => undefined);
  console.log(`failed at ${await current?.evaluate(() => location.href).catch(() => '?')}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await fake.close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (errors.length) console.log(`page errors:\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
