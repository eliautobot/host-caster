// Stress for Your list + the actions engine on a built app (VITE_HOSTCASTER_DEBUG=1), self-hosted edition, the
// scripted path (no model spend), a stand-in Google with fault injection.
//   node e2e/actions-stress.e2e.mjs <distDir>        env: PORT (8703), FIX_PORT (8704), OUT
// Measures and checks: 300 tracked items + 200 Google Tasks (merge time, no duplicates, a break's list block);
// 50 rapid call-in turns; 20 concurrent confirmations of one proposal (two devices) = one task; token expiry under
// load (20 tokens spent late = refused, nothing written, then done once each); Google 429 / 500 / timeouts injected
// (retry and backoff, no duplicate, an honest failure); an offline device (nothing happens, then once back online);
// the daily cap holds.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig } from '../../server/src/config.js';
import { createServer } from '../../server/src/index.js';
import { startAgentsGoogle } from './fixtures/agents-google.mjs';

const dist = resolve(process.argv[2] ?? '/tmp/hc-ag4-dist2');
const port = Number(process.env.PORT ?? 8703);
const base = `http://localhost:${port}`;
const out = process.env.OUT ?? '/tmp/hc-ag4-stress.json';
const CAP = 40;
const results = [];
const report = { checks: results, timings: {} };
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${String(detail).slice(0, 260)})` : ''}`);
  if (!ok) failed++;
  console.log(results.at(-1));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const time = async (key, fn) => {
  const t0 = Date.now();
  const v = await fn();
  report.timings[key] = Date.now() - t0;
  return v;
};

const google = await startAgentsGoogle(Number(process.env.FIX_PORT ?? 8704));
const fx = async (method, path, body) => (await fetch(`${google.base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
const fxState = () => fx('GET', '/fixture/state');
const env = {
  PORT: String(port), PUBLIC_URL: base, DATA_DIR: mkdtempSync(join(tmpdir(), 'hc-ag4-stress-')), APP_DIST: dist, HOST: '127.0.0.1', CHATGPT_PLAN: '0', ALLOW_PRIVATE_FETCH: 'true',
  ...google.env, ACTIONS_PER_DAY: String(CAP), ACTION_PROPOSALS_PER_DAY: '150', ACTIONS_TOKEN_TTL_MS: '1500', ACTIONS_GOOGLE_TIMEOUT_MS: '1500', ACTIONS_BACKOFF_MS: '100',
};
const server = await createServer(loadConfig(env), { logger: false });
await server.listen({ port, host: '127.0.0.1' });
const browser = await chromium.launch();
const errors = [];

async function device(viewport) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/auth/google/start?scopes=calendar,gmail,calendarEvents,tasks`);
  await page.waitForURL((u) => u.toString().startsWith(base) && !u.pathname.startsWith('/auth/'), { timeout: 20000 });
  await page.goto(`${base}/#/welcome`);
  const skip = page.getByRole('button', { name: /Skip setup|Set up later/ }).first();
  if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) await skip.click();
  await page.goto(`${base}/#/`);
  await page.waitForFunction(() => window.__hostcaster?.tracker?.addItem && window.__hostcaster?.actions?.confirmAndRun, null, { timeout: 30000 });
  return { ctx, page };
}
const api = (pg, method, path, body) =>
  pg.evaluate(async ([m, p, b]) => {
    const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', 'x-hostcaster': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, path, body]);

try {
  const { ctx, page } = await device({ width: 1440, height: 900 });
  const { page: page2 } = await device({ width: 390, height: 844 });
  for (let i = 0; i < 8; i++) {
    await page.evaluate(async () => {
      const db = window.__hostcaster.db;
      const s = await db.getSettings();
      await db.saveSettings({ ...s, connections: { ...s.connections, calendar: { google: true, icsUrls: [] }, email: { gmail: true, imap: false }, actions: { calendar: true, tasks: true }, tracker: { enabled: true } } });
    });
    await wait(800);
    if (await page.evaluate(() => window.__hostcaster.db.getSettings().then((s) => Boolean(s.connections.actions?.tasks)))) break;
  }
  await page2.evaluate(async () => {
    const db = window.__hostcaster.db;
    const s = await db.getSettings();
    await db.saveSettings({ ...s, connections: { ...s.connections, actions: { calendar: true, tasks: true } } });
  });

  // ------------------------------------------------------------------- 300 tracked items + 200 Google Tasks
  const listId = google.writes.state.lists[0].id;
  const proto = google.writes.state.tasks.find((t) => t.listId === listId);
  for (let i = 0; i < 200; i++) google.writes.state.tasks.push({ ...structuredClone(proto), id: `stress${String(i).padStart(4, '0')}`, title: `Stress task ${i} ${['call', 'email', 'buy', 'fix', 'book'][i % 5]} ${['Ana', 'Ben', 'Cy', 'Di'][i % 4]}`, due: undefined, notes: undefined });
  await time('add300ItemsMs', () =>
    page.evaluate(async () => {
      const t = window.__hostcaster.tracker;
      // distinct words per item (the dedupe merges things that mean the same)
      const w = (n) => Array.from({ length: 5 }, (_, k) => String.fromCharCode(97 + (Math.floor(n / 26 ** k) % 26))).join('')
      for (let i = 0; i < 300; i++) await t.addItem({ what: `${['Pay', 'Send', 'Renew', 'Pick up', 'Return'][i % 5]} the ${w(i + 11)} ${w(i * 7 + 5003)}`, kind: 'todo', due: i % 3 ? undefined : new Date(Date.now() + (i % 48) * 3600_000).toISOString(), source: { type: 'you', label: 'You said it' } });
    }),
  );
  const sync = await time('sync200TasksMs', () => page.evaluate(() => window.__hostcaster.tracker.syncGoogleTasks(Date.now(), true)));
  const resync = await time('resync200TasksMs', () => page.evaluate(() => window.__hostcaster.tracker.syncGoogleTasks(Date.now(), true)));
  const counts = await page.evaluate(async () => {
    const all = await window.__hostcaster.tracker.allItems();
    return { all: all.length, gtask: all.filter((i) => i.gtask).length, dupTasks: all.filter((i) => i.gtask).length - new Set(all.filter((i) => i.gtask).map((i) => i.gtask.taskId)).size };
  });
  check('300 items + 200 Google Tasks merged, no duplicates, a second sync adds nothing', counts.gtask >= 205 && counts.dupTasks === 0 && resync?.added === 0 && counts.all >= 500, JSON.stringify({ counts, sync, resync }));
  const brief = await time('listBriefMs', () => page.evaluate(() => window.__hostcaster.tracker.listBrief({ now: Date.now(), morning: true })));
  check('a break list block with 500+ items: bounded (<= 3 lines)', (brief?.lines?.length ?? 0) <= 3, JSON.stringify(brief?.lines ?? []).slice(0, 200));

  // ------------------------------------------------------------------- 50 rapid call-in turns
  const turns = await time('fiftyCallInTurnsMs', () =>
    page.evaluate(async () => {
      const a = window.__hostcaster.actions;
      const out = [];
      const names = 'Ana Ben Cleo Dmitri Eve Farid Gwen Hiro Ivy Jonas Kemal Lena Milo Nadia Oscar Petra Quinn Rosa Sven Tara Umar Vera Wade Xena Yusuf Zara Abel Bianca Caleb Daria Emil Flora Gus Hana Igor Jade Kofi Lior Maya Nils Olga Pablo Rhea Saul Tomas Una Vik Wren Yara Zeke'.split(' ')
      for (let b = 0; b < 5; b++) out.push(...(await Promise.all(Array.from({ length: 10 }, (_, i) => a.takeActionTurn({ said: `remind me to ${['call', 'email', 'text', 'visit', 'thank'][i % 5]} ${names[b * 10 + i]} tomorrow`, origin: 'call-in' }).then((t) => t?.kind, (e) => `error ${e}`)))));
      return out;
    }),
  );
  const kinds = turns.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
  check('50 rapid call-in turns: every one handled (added to Your list, Google Task asked)', (kinds.asked ?? 0) + (kinds.added ?? 0) === 50, JSON.stringify(kinds));
  const proposed = (await api(page, 'GET', '/api/actions?limit=100&status=proposed')).body?.actions ?? [];
  check('50 proposals waiting, nothing written yet', proposed.length === 50 && (await fxState()).inserts.tasks === 0, `${proposed.length} proposed`);

  // ------------------------------------------------------------------- 20 concurrent confirmations (two devices)
  const one = proposed[0];
  const before = (await fxState()).inserts.tasks;
  const confirms = await time('twentyConfirmsMs', () =>
    Promise.all([page, page2].map((pg) => pg.evaluate((a) => Promise.all(Array.from({ length: 10 }, () => window.__hostcaster.actions.confirmAndRun(a, 'tap').then((r) => r?.status, (e) => `error ${e.message}`))), one))),
  );
  const flat = confirms.flat();
  check('20 concurrent confirmations -> one task', (await fxState()).inserts.tasks === before + 1 && flat.every((s) => s === 'done'), JSON.stringify(flat.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {})));

  // ------------------------------------------------------------------- token expiry under load
  const batch = proposed.slice(1, 21);
  const tokens = await Promise.all(batch.map((a) => api(page, 'POST', `/api/actions/${a.id}/confirm`, { payloadHash: a.payloadHash, via: 'tap' })));
  await wait(2000);
  const late = await Promise.all(batch.map((a, i) => api(page, 'POST', `/api/actions/${a.id}/execute`, { token: tokens[i].body?.token, payload: a.payload })));
  check('20 tokens spent after they expired -> all refused, nothing written', late.every((r) => r.status === 401) && (await fxState()).inserts.tasks === before + 1, JSON.stringify(late.map((r) => r.body?.error?.code)).slice(0, 120));
  const again = await time('twentyRetriesAfterExpiryMs', () => page.evaluate((list) => Promise.all(list.map((a) => window.__hostcaster.actions.confirmAndRun(a, 'tap').then((r) => r?.status))), batch));
  check('then confirmed again -> done once each', again.every((s) => s === 'done') && (await fxState()).inserts.tasks === before + 21, JSON.stringify(again.slice(0, 3)));

  // ------------------------------------------------------------------- Google faults
  const next = () => proposed.splice(21, 1)[0];
  const run = (a) => page.evaluate((x) => window.__hostcaster.actions.confirmAndRun(x, 'tap').then((r) => ({ status: r?.status, error: r?.error }), (e) => ({ status: 'error', error: e.message })), a);
  let ins = (await fxState()).inserts.tasks;
  await fx('POST', '/fixture/faults', { match: 'POST /gapi/tasks/v1/lists/.*/tasks$', status: 429, count: 2 });
  let r = await time('after429x2Ms', () => run(next()));
  check('429 twice -> backoff, done once', r.status === 'done' && (await fxState()).inserts.tasks === ins + 1, JSON.stringify(r));
  ins = (await fxState()).inserts.tasks;
  await fx('POST', '/fixture/faults', { match: 'POST /gapi/tasks/v1/lists/.*/tasks$', delayMs: 2500, count: 1 });
  r = await time('afterTimeoutMs', () => run(next()));
  await wait(1500);
  const titles = (await fxState()).items.tasks.filter((t) => !t.deleted).map((t) => t.title);
  const dup = titles.length - new Set(titles).size;
  check('a timeout (Google did it late) -> reconciled, no duplicate', r.status === 'done' && dup === 0, `${JSON.stringify(r)} dup ${dup} inserts +${(await fxState()).inserts.tasks - ins}`);
  ins = (await fxState()).inserts.tasks;
  await fx('POST', '/fixture/faults', { match: 'POST /gapi/tasks/v1/lists/.*/tasks$', status: 500, count: 6 });
  r = await run(next());
  check('500 every time -> failed with an honest message, nothing written', r.status === 'failed' && (await fxState()).inserts.tasks === ins && /did not|nothing/i.test(r.error?.message ?? ''), JSON.stringify(r));
  await fx('DELETE', '/fixture/faults');

  // ------------------------------------------------------------------- offline device
  const off = next();
  ins = (await fxState()).inserts.tasks;
  await ctx.setOffline(true);
  r = await run(off);
  check('offline device: nothing happens', r.status === undefined || r.status === 'error', JSON.stringify(r));
  await ctx.setOffline(false);
  r = await run(off);
  check('back online: done once', r.status === 'done' && (await fxState()).inserts.tasks === ins + 1, JSON.stringify(r));

  // ------------------------------------------------------------------- the daily cap
  let refusedAt = -1;
  let doneCount = (await api(page, 'GET', '/api/actions/status')).body?.used ?? 0;
  for (let i = 0; i < 25 && refusedAt < 0; i++) {
    const a = next();
    if (!a) break;
    r = await run(a);
    if (r.status === 'done') doneCount++;
    else refusedAt = doneCount;
  }
  const st = (await api(page, 'GET', '/api/actions/status')).body;
  check(`daily cap holds (${CAP})`, refusedAt === CAP && st?.used === CAP, `refused after ${refusedAt}, used ${st?.used}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`timings ${JSON.stringify(report.timings)}`);
} catch (err) {
  check('run finished', false, err?.stack ?? String(err));
} finally {
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`${failed ? 'FAILED' : 'ALL PASS'}: ${results.length - failed}/${results.length}`);
  await browser.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await google.close?.().catch(() => undefined);
  process.exit(failed ? 1 : 0);
}
