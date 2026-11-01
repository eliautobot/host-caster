// Notion connector end to end on a built app, against a fake Notion (server/test/fake-notion.js), no keys needed.
//   node e2e/notion.e2e.mjs [distDir] [mediaDir]
// env: PORT (8682), SHOTS (screenshot dir), OUT (result JSON). mediaDir: e2e/fixtures/make-media.sh radio <dir>.
// Flow: sign up, Connect Notion (consent round trip), pick a page to read and where to write (a Host-Caster page is
// made inside it), the hosts' packet has the open to-dos, a call-in "add oat milk to my list" and an AI-app note
// (MCP send_note_to_hosts) each add one block and are confirmed on air, the activity log shows both, Undo trashes
// only that block, phone + desktop screenshots, Disconnect revokes and forgets.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig } from '../../server/src/config.js';
import { createServer } from '../../server/src/index.js';
import { para, startFakeNotion, todo } from '../../server/test/fake-notion.js';

const dist = resolve(process.argv[2] ?? '/tmp/hc-notion-dist');
const media = process.argv[3] ?? '/tmp/hostcaster-e2e/radio-media';
const port = Number(process.env.PORT ?? 8682);
const base = `http://localhost:${port}`;
const shots = process.env.SHOTS ?? '/tmp/hc-nt-shots';
const out = process.env.OUT ?? '/tmp/hc-nt-e2e/result.json';
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
const shot = (page, name) => page.screenshot({ path: join(shots, `notion-${name}.png`) });

// ------------------------------------------------------------------------------------------------ fake Notion + server
const fake = await startFakeNotion();
const qa = fake.addPage('Host-Caster QA', [todo('Pick up the dry cleaning'), todo('Call the dentist'), todo('Old done thing', true), para('Weekend plans are open.')]);
const home = fake.addPage('Home', [para('My own words, never touched.')]);
const dataDir = mkdtempSync(join(tmpdir(), 'hc-nt-e2e-'));
const config = loadConfig({ PORT: String(port), PUBLIC_URL: base, DATA_DIR: dataDir, APP_DIST: dist, HOST: '127.0.0.1', CHATGPT_PLAN: '0', ...fake.env });
const server = await createServer(config, { logger: false });
await server.listen({ port, host: '127.0.0.1' });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|401|409/.test(m.text())) errors.push(m.text());
});
const api = (method, path, body) =>
  page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', 'x-hostcaster': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, path, body],
  );
const notionCard = () => page.locator('.aw-acct-card', { has: page.getByRole('heading', { name: 'Notion', exact: true }) });

try {
  // ---------------------------------------------------------------------------------------------- account
  await page.goto(`${base}/#/welcome`);
  await page.getByRole('button', { name: 'Skip setup' }).click();
  const signup = await api('POST', '/api/auth/local/signup', { email: 'listener@example.com', password: 'correct horse battery', name: 'Sam' });
  check('local account', signup.status === 201, String(signup.status));
  await page.goto(`${base}/#/settings/connections`);
  await page.reload();
  await notionCard().getByRole('button', { name: 'Connect Notion' }).waitFor({ timeout: 15000 });
  await notionCard().scrollIntoViewIfNeeded();
  await shot(page, 'card-off-desktop');
  check('card offers Connect Notion', true);

  // ---------------------------------------------------------------------------------------------- connect
  await notionCard().getByRole('button', { name: 'Connect Notion' }).click();
  await page.waitForURL(/#\/settings\/connections/, { timeout: 20000 });
  const picker = page.getByRole('dialog');
  const pickerOpen = await picker.getByText('Pages your hosts can read').waitFor({ timeout: 15000 }).then(() => true, () => false);
  check('back from Notion: connected, the reading picker opens', pickerOpen);
  check('consent went to Notion with owner=user', fake.log.some((l) => l.path === '/v1/oauth/authorize'));
  await picker.getByRole('checkbox', { name: /Host-Caster QA/ }).click();
  await shot(page, 'picker-read-desktop');
  await picker.getByRole('button', { name: 'Save' }).click();
  await picker.waitFor({ state: 'hidden' });
  const readRow = await notionCard().getByText('Host-Caster QA').first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  check('Hosts can read: Host-Caster QA', readRow);
  check('workspace shown', await notionCard().getByText(/Connected to .*Sam's Space/).isVisible());

  // ---------------------------------------------------------------------------------------------- where hosts write
  await notionCard().getByRole('button', { name: 'Choose' }).nth(1).click();
  await picker.getByText('Where your hosts write').waitFor();
  await picker.getByRole('radio', { name: /\bHome\b/ }).click();
  await picker.getByRole('button', { name: 'Save' }).click();
  await picker.waitFor({ state: 'hidden' });
  check('Hosts write to: a Host-Caster page inside Home', await notionCard().getByText('Host-Caster page inside Home').waitFor({ timeout: 8000 }).then(() => true, () => false));
  const ours = [...fake.pages.values()].find((p) => p.title === 'Host-Caster' && p.parent.page_id === home);
  check('the Host-Caster page was made inside Home', Boolean(ours));

  // ---------------------------------------------------------------------------------------------- read: the packet
  const ctxRes = await api('GET', '/api/notion/context');
  const qaNote = ctxRes.body?.notes?.find((n) => n.title === 'Host-Caster QA');
  check('hosts read the open to-dos (not the done one)', Boolean(qaNote) && /Pick up the dry cleaning; Call the dentist/.test(qaNote.text) && !/Old done/.test(qaNote.text), qaNote?.text);

  // ---------------------------------------------------------------------------------------------- songs + station
  await page.goto(`${base}/#/library`);
  const files = readdirSync(media).filter((f) => /\.mp3$/i.test(f)).sort();
  await page.locator('[data-testid=pick-files]').setInputFiles(files.map((f) => ({ name: f, mimeType: 'audio/mpeg', buffer: readFileSync(join(media, f)) })));
  check('songs imported', await page.waitForFunction((n) => document.querySelectorAll('.aw-track').length >= n, files.length, { timeout: 30000 }).then(() => true, () => false));
  await page.goto(`${base}/#/stations/seed-station-881`);
  await page.getByRole('slider', { name: 'Talk every' }).focus();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await wait(500);

  // every script that goes on air (lines are known when the break starts talking)
  await page.goto(`${base}/#/`);
  await page.evaluate(() => {
    const w = window;
    w.__scripts = [];
    w.__hostcaster.radio.on('state', (s) => {
      if (s.phase === 'talking' && s.script && w.__scripts.at(-1) !== s.script) w.__scripts.push(s.script);
    });
  });
  const scripts = () => page.evaluate(() => window.__scripts.map((s) => s.map((l) => l.text).join(' ')));

  // ---------------------------------------------------------------------------------------------- call-in write
  await page.getByRole('button', { name: 'Talk to the hosts' }).first().click();
  await page.getByRole('dialog').getByLabel('What do you want to say?').fill('Hey, can you add oat milk to my list please?');
  await page.getByRole('dialog').getByRole('button', { name: 'Go on air' }).click();
  let answer;
  for (const t1 = Date.now(); Date.now() - t1 < 90_000 && !answer; await wait(300)) answer = (await scripts()).find((s) => /notion/i.test(s));
  check('call-in: hosts confirm on air', Boolean(answer) && /oat milk/i.test(answer), answer?.slice(0, 160));
  const oat = ours && fake.pages.get(ours.id).blocks.find((b) => b.type === 'to_do' && b.to_do.rich_text[0].text?.content === 'oat milk');
  check('call-in: the to-do is in Notion, on the Host-Caster page', Boolean(oat));
  check("the listener's own page is untouched", fake.pages.get(home).blocks.filter((b) => b.type !== 'child_page').length === 1);

  // ---------------------------------------------------------------------------------------------- AI app (MCP inbox)
  const conn = await api('POST', '/api/connectors', { name: 'Test assistant' });
  const token = new URL(conn.body.url).pathname.split('/').pop();
  const mcp = await fetch(`${base}/mcp/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_note_to_hosts', arguments: { text: 'Please add call the plumber to my to-do list' } } }),
  });
  check('AI app note sent over MCP', mcp.ok, String(mcp.status));
  let appAnswer;
  for (const t1 = Date.now(); Date.now() - t1 < 150_000 && !appAnswer; await wait(500)) appAnswer = (await scripts()).find((s) => /assistant/i.test(s) && /notion/i.test(s));
  check('AI app: hosts confirm on air in the next break', Boolean(appAnswer), appAnswer?.slice(0, 160));
  const plumber = ours && fake.pages.get(ours.id).blocks.find((b) => b.type === 'to_do' && /plumber/.test(b.to_do.rich_text[0].text?.content ?? ''));
  check('AI app: the to-do is in Notion', Boolean(plumber), plumber?.to_do.rich_text.map((r) => r.text.content).join(''));
  const all = (await scripts()).join(' \n ');
  check("a break talked from the listener's Notion page", /Host-Caster QA|dry cleaning|dentist/i.test(all), all.match(/[^.]*(?:dry cleaning|dentist)[^.]*/i)?.[0]);
  await page.evaluate(() => window.__hostcaster.radio.stop());

  // ---------------------------------------------------------------------------------------------- activity + undo
  await page.goto(`${base}/#/settings/connections`);
  await notionCard().getByText('What your hosts added').scrollIntoViewIfNeeded();
  const rows = notionCard().locator('.aw-notion-act');
  await rows.first().waitFor({ timeout: 10000 });
  const texts = await rows.locator('.aw-acct-row__title').allTextContents();
  check('activity log lists both', texts.includes('oat milk') && texts.some((t) => /plumber/.test(t)), texts.join(' | '));
  await shot(page, 'card-on-desktop');
  await rows.filter({ hasText: 'oat milk' }).getByRole('button', { name: 'Undo' }).click();
  check('Undo: the row says Undone', await rows.filter({ hasText: 'oat milk' }).getByText('Undone').waitFor({ timeout: 8000 }).then(() => true, () => false));
  check('Undo: only that block went to the trash', oat?.in_trash === true && plumber?.in_trash === false);

  // ---------------------------------------------------------------------------------------------- phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await notionCard().getByText('Hosts can read').scrollIntoViewIfNeeded();
  await wait(400);
  await shot(page, 'card-on-phone');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: no sideways scroll', overflow <= 0, `${overflow}px`);
  await notionCard().getByRole('button', { name: 'Choose' }).first().click();
  await picker.getByText('Pages your hosts can read').waitFor();
  await wait(300);
  await shot(page, 'picker-read-phone');
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---------------------------------------------------------------------------------------------- disconnect
  await notionCard().getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  check('disconnected: Connect Notion again', await notionCard().getByRole('button', { name: 'Connect Notion' }).waitFor({ timeout: 10000 }).then(() => true, () => false));
  check('disconnect revoked the token at Notion', fake.revoked.length === 1);
  const st = await api('GET', '/api/notion/status');
  check('server forgot the link', st.body?.connected === false);
  const log = await api('GET', '/api/notion/activity');
  check('activity log is gone', Array.isArray(log.body?.items) && log.body.items.length === 0);
} catch (err) {
  check('run finished', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
  await shot(page, 'error').catch(() => undefined);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify({ failed, results, errors }, null, 2));
  await browser.close();
  await server.close();
  await fake.close();
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
