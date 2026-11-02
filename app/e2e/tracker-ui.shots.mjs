// Screenshots of Your list, the confirmation card, Done for you, the Google switches and the call-in sheet with a
// waiting question, at 390x844 and 1440x900, dark and light, on a debug build (VITE_HOSTCASTER_DEBUG=1).
//   node e2e/tracker-ui.shots.mjs <distDir> [shotsDir]
// The server is real (stand-in Google sign-in); the actions API and Google Tasks are answered in the page
// (page.route) so the shots do not depend on the server builder's state. Items are seeded into IndexedDB.
// env: PORT (8703), FIX_PORT (8704)
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig } from '../../server/src/config.js';
import { createServer } from '../../server/src/index.js';
import { startAgentsGoogle } from './fixtures/agents-google.mjs';

const dist = resolve(process.argv[2] ?? '/tmp/hc-ag4-ui-dist');
const shots = resolve(process.argv[3] ?? '/tmp/hc-ag4-shots');
const port = Number(process.env.PORT ?? 8703);
const base = `http://localhost:${port}`;
mkdirSync(shots, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const google = await startAgentsGoogle(Number(process.env.FIX_PORT ?? 8704));
const dataDir = mkdtempSync(join(tmpdir(), 'hc-ag4-ui-'));
const config = loadConfig({ PORT: String(port), PUBLIC_URL: base, DATA_DIR: dataDir, APP_DIST: dist, HOST: '127.0.0.1', CHATGPT_PLAN: '0', ...google.env });
const server = await createServer(config, { logger: false });
await server.listen({ port, host: '127.0.0.1' });

const now = Date.now();
const day = (n) => {
  const d = new Date(now + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const item = (id, over) => ({ id, createdAt: now - 3_600_000, updatedAt: now - 3_600_000, status: 'open', key: `seed:${id}`, ...over });
const ITEMS = [
  item('i-careful', {
    what: 'Pay the overdue invoice from Northwind Billing',
    kind: 'bill',
    due: day(0),
    who: 'Northwind Billing',
    source: { type: 'email', id: 'm1', link: 'https://mail.google.com/mail/u/0/#inbox/m1', label: 'Email from Northwind Billing', from: 'Northwind Billing', address: 'billing@northwind-pay.example' },
    flags: { careful: true, newSender: true, why: 'It asks you to pay through a link from someone you never wrote to.' },
  }),
  item('i-quotes', {
    what: 'Send the three vendor quotes to Dana',
    kind: 'todo',
    due: day(-1),
    who: 'Dana Reyes',
    source: { type: 'gtask', id: 't1', link: 'https://tasks.google.com/task/t1', label: 'Google Tasks, My Tasks' },
    gtask: { listId: 'L1', taskId: 't1' },
    suggestDone: { why: 'Dana wrote "thanks for the quotes" this morning', at: now - 600_000 },
  }),
  item('i-invite', {
    what: 'Answer the invitation: Q4 budget review',
    kind: 'invite',
    due: new Date(now + 26 * 3_600_000).toISOString(),
    who: 'Dana Reyes',
    source: { type: 'event', id: 'cal:q4', link: 'https://calendar.google.com/calendar/event?eid=abc', label: 'Invitation from Dana Reyes' },
  }),
  item('i-waiting', { what: 'Signed lease back from the landlord', kind: 'waiting', due: day(4), who: 'Sam', source: { type: 'email', id: 'm2', link: 'https://mail.google.com/mail/u/0/#inbox/m2', label: 'Email from Sam Ortiz' } }),
  item('i-dentist', { what: 'Call the dentist to move the cleaning', kind: 'todo', remindAt: now + 3 * 3_600_000, source: { type: 'you', label: 'You said it on a call-in' } }),
  item('i-milk', { what: 'Buy oat milk', kind: 'todo', source: { type: 'you', label: 'You added it' } }),
  item('i-done', { what: 'Renew the parking permit', kind: 'deadline', due: day(-2), status: 'done', doneAt: now - 2 * 3_600_000, doneBy: 'you', source: { type: 'you', label: 'You added it' } }),
];

const pending = {
  id: 'act-pending',
  type: 'invite.respond',
  level: 3,
  origin: 'call-in',
  status: 'proposed',
  summary: 'Answer "Q4 budget review" (tomorrow, 2 PM to 3 PM) with: yes, you are going.',
  others: 'Dana Reyes, the organizer, will see your answer.',
  payload: { calendarId: 'primary', eventId: 'q4', response: 'accepted' },
  payloadHash: 'h1',
  createdAt: now,
  expiresAt: now + 9 * 60_000 + 42_000,
  undoable: false,
};
const history = [
  { ...pending, id: 'a1', type: 'calendar.add', level: 2, status: 'done', summary: 'Add "Dentist" to your Google Calendar, Friday from 3 PM to 4 PM.', others: undefined, payload: { title: 'Dentist', allDay: false, start: '2026-11-06T15:00:00-05:00', end: '2026-11-06T16:00:00-05:00', timeZone: 'America/New_York' }, createdAt: now - 40 * 60_000, executedAt: now - 39 * 60_000, result: { link: 'https://calendar.google.com/calendar/event?eid=x' }, undoable: true },
  { ...pending, id: 'a2', type: 'task.add', level: 2, status: 'failed', summary: 'Add "Book flights for Thanksgiving" to Google Tasks.', others: undefined, payload: { title: 'Book flights for Thanksgiving' }, createdAt: now - 3 * 3_600_000, error: { code: 'google_unavailable', message: 'Google Tasks did not answer, so nothing was added.' }, undoable: false },
  { ...pending, id: 'a3', type: 'task.complete', level: 2, status: 'undone', summary: 'Mark "Pick up the dry cleaning" complete in Google Tasks.', others: undefined, payload: { listId: 'L1', taskId: 't9', title: 'Pick up the dry cleaning' }, createdAt: now - 26 * 3_600_000, executedAt: now - 26 * 3_600_000, undoneAt: now - 25 * 3_600_000, undoable: true },
  { ...pending, id: 'a4', status: 'cancelled', createdAt: now - 50 * 3_600_000 },
  { ...pending, id: 'a5', type: 'calendar.add', level: 2, status: 'expired', summary: 'Add "Call Mom" to your Google Calendar, Sunday from 6 PM to 6:30 PM.', others: undefined, createdAt: now - 72 * 3_600_000 },
];

async function routes(page) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\/actions\/status$/, (r) => json(r, { calendarWrite: true, tasks: true, caps: { perDay: 50, proposalsPerDay: 200 }, used: 1 }));
  await page.route(/\/api\/actions(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    return json(r, { actions: u.searchParams.get('status') === 'proposed' ? [pending] : [pending, ...history].map((a) => (a.id === pending.id ? { ...a } : a)).slice(1) });
  });
  await page.route(/\/api\/actions\/[^/]+\/(confirm|execute|cancel|undo)$/, async (r) => {
    const step = r.request().url().split('/').pop();
    if (step === 'confirm') return json(r, { action: { ...pending, status: 'confirmed', confirmedAt: Date.now(), confirmedVia: 'tap' }, token: 'tok' });
    if (step === 'execute') {
      await wait(800);
      return json(r, { action: { ...pending, status: 'done', executedAt: Date.now(), undoable: true, result: { link: 'https://calendar.google.com/calendar/event?eid=q4' } } });
    }
    if (step === 'cancel') return json(r, { action: { ...pending, status: 'cancelled' } });
    return json(r, { action: { ...pending, status: 'undone', undoneAt: Date.now() } });
  });
  await page.route(/\/api\/google\/tasks$/, (r) => json(r, { lists: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Work' }, { id: 'L3', title: 'Groceries' }], tasks: [] }));
}

async function openApp(page) {
  await page.goto(`${base}/auth/google/start?scopes=calendar,gmail,calendarEvents,tasks`);
  await page.waitForURL((u) => u.toString().startsWith(base) && !u.pathname.startsWith('/auth/'), { timeout: 20000 });
  await page.goto(`${base}/#/welcome`);
  const skip = page.getByRole('button', { name: /Skip setup|Set up later/ }).first();
  if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) await skip.click();
  await page.goto(`${base}/#/`);
  await page.waitForFunction(() => window.__hostcaster?.db?.db, null, { timeout: 30000 });
}

async function seed(page, theme) {
  await page.evaluate(
    async ([items, theme]) => {
      const h = window.__hostcaster.db;
      await h.db.tracker.bulkPut(items);
      const s = await h.getSettings();
      await h.saveSettings({ theme, connections: { ...s.connections, actions: { calendar: true, tasks: true, taskLists: ['L1'] }, calendar: { icsUrls: [], google: true }, email: { imap: false, gmail: true } } });
    },
    [ITEMS, theme],
  );
}

const browser = await chromium.launch();
const errors = [];
try {
  for (const theme of ['dark', 'light']) {
    for (const [w, h, tag] of [
      [390, 844, 'phone'],
      [1440, 900, 'desktop'],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: tag === 'phone' ? 2 : 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await routes(page);
      await openApp(page);
      await seed(page, theme);
      const shot = async (name, el) => {
        await wait(700);
        const path = join(shots, `${name}-${tag}-${theme}.png`);
        if (el) await page.locator(el).first().screenshot({ path });
        else await page.screenshot({ path });
        log('shot', path);
      };

      await page.goto(`${base}/#/list`);
      await page.locator('[data-item]').first().waitFor({ timeout: 15000 });
      await page.locator('[data-action]').first().waitFor({ timeout: 10000 }).catch(() => log('no pending card on the list'));
      await shot('list');
      await shot('card', '.aw-action');
      await shot('careful', '[data-item="i-careful"]');
      await page.locator('[data-item="i-milk"] button[aria-label="Snooze"]').click();
      await shot('snooze', '[data-item="i-milk"]');

      await page.goto(`${base}/#/list?view=done`);
      await page.locator('.aw-acthist__row').first().waitFor({ timeout: 10000 }).catch(() => log('no history rows'));
      await shot('history');

      await page.goto(`${base}/#/settings/connections`);
      const sw = page.locator('[data-switch="calendar"]');
      await sw.waitFor({ timeout: 15000 }).catch(() => log('no Google switches'));
      await sw.scrollIntoViewIfNeeded().catch(() => undefined);
      await shot('connections', '.aw-gactions');

      await page.goto(`${base}/#/`);
      const talk = page.getByRole('button', { name: /Talk to the hosts|Call in/ }).first();
      await talk.click();
      await page.locator('.aw-callin .aw-action').first().waitFor({ timeout: 10000 }).catch(() => log('no card in the call-in sheet'));
      await shot('callin');
      await page.locator('.aw-callin .aw-action button', { hasText: 'Yes' }).first().click();
      await page.locator('.aw-callin .aw-action__result--ok').first().waitFor({ timeout: 10000 }).catch(() => log('no done result in the sheet'));
      await shot('callin-done', '.aw-callin');
      await ctx.close();
    }
  }
} finally {
  log('page errors:', errors.length, errors.slice(0, 3).join(' | ').slice(0, 400));
  await browser.close();
  await server.close();
  await google.close();
}
