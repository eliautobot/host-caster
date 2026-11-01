// Day first, end to end on a built app: News in Connections (region defaults, own list), "What your hosts can see"
// with a real calendar link, reminders, weather and the default news feeds, and the Talk mix in the station editor,
// at 1440x900 and 390x844. Usage:
//   node e2e/dayfirst.e2e.mjs [baseUrl] [icsPort]
// The server needs ALLOW_PRIVATE_FETCH=true (it reads the test calendar this script serves on 127.0.0.1:<icsPort>).
// env: SHOTS (screenshot dir).
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8671';
const icsPort = Number(process.argv[3] ?? 8672);
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
mkdirSync(shots, { recursive: true });

let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name, fullPage = false) => page.screenshot({ path: join(shots, `dayfirst-${name}.png`), fullPage });

// a calendar with events today and tomorrow, served where the server can read it
const now = Date.now();
const ics = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const tomorrow8 = new Date(now + 86_400_000);
tomorrow8.setHours(8, 5, 0, 0);
const event = (uid, title, start, mins) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${ics(start)}`, `DTEND:${ics(start + mins * 60_000)}`, `SUMMARY:${title}`, 'END:VEVENT'];
const calendar = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Host-Caster e2e//EN',
  ...event('dentist', 'Dentist appointment', now + 50 * 60_000, 45),
  ...event('lunch', 'Lunch with Priya', now + 3 * 3600_000, 60),
  ...event('flight', 'Flight to Denver', tomorrow8.getTime(), 150),
  'END:VCALENDAR',
].join('\r\n');
const icsServer = createServer((req, res) => {
  res.writeHead(req.url === '/cal.ics' ? 200 : 404, { 'content-type': 'text/calendar' });
  res.end(req.url === '/cal.ics' ? calendar : '');
});
await new Promise((r) => icsServer.listen(icsPort, '127.0.0.1', r));
const icsUrl = `http://127.0.0.1:${icsPort}/cal.ics`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'America/Chicago', locale: 'en-US' });
await ctx.addInitScript(() => {
  const open = () =>
    new Promise((res, rej) => {
      const r = indexedDB.open('hostcaster');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => (db.close(), res(req?.result));
      t.onerror = () => rej(t.error);
    });
  };
  window.__idb = {
    get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
    put: (store, v) => tx(store, 'readwrite', (s) => s.put(v)),
  };
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|401/.test(m.text())) errors.push(m.text());
});

// ------------------------------------------------------------------------------------------------ setup
await page.goto(`${base}/#/welcome`);
await page.getByRole('button', { name: 'Skip setup' }).click();
await page.waitForURL(/#\/$/);
const signup = await page.evaluate(async () => {
  const r = await fetch('/api/auth/local/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-HostCaster': '1' },
    body: JSON.stringify({ email: `dayfirst-${Date.now()}@example.com`, password: 'a good long password', name: 'Sam Rivera' }),
  });
  return r.status;
});
check('local account (the server fetches feeds and calendars for signed-in users)', signup === 201, `status ${signup}`);
await page.evaluate(
  async ({ icsUrl, now }) => {
    const db = window.__idb;
    const p = await db.get('profile', 'me');
    const t = new Date(now + 86_400_000);
    const md = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    await db.put('profile', {
      ...p,
      name: 'Sam Rivera',
      callMe: 'Sam',
      location: { name: 'Chicago', lat: 41.88, lon: -87.63 },
      units: 'imperial',
      reminders: [{ id: 'r1', text: 'Call the pharmacy about the refill', at: now + 40 * 60_000 }],
      notes: [{ id: 'n1', text: 'Drink more water today' }],
      lifeEvents: [{ id: 'l1', title: "Mom's birthday", date: `1961-${md}`, yearly: true }],
      updatedAt: now,
    });
    const s = await db.get('settings', 'app');
    await db.put('settings', { ...s, onboarded: true, connections: { ...s.connections, calendar: { google: false, icsUrls: [icsUrl] } }, updatedAt: now });
  },
  { icsUrl, now },
);
await page.reload();
await wait(800);

// ------------------------------------------------------------------------------------------------ Connections: news
await page.goto(`${base}/#/settings/connections`);
const link = page.getByRole('button', { name: /What your hosts can see/ });
check('Connections links to "What your hosts can see"', await link.waitFor({ timeout: 10000 }).then(() => true, () => false));
const newsCard = page.locator('#news');
await newsCard.waitFor();
const newsStatus = async () => (await newsCard.locator('.aw-acct-card__status').textContent()) ?? '';
check('News is on by default with the region guessed from the time zone (Chicago = United States)', /3 feeds, top stories for United States/.test(await newsStatus()), await newsStatus());
check('the default US feeds are listed by name', (await newsCard.getByText('NPR News', { exact: true }).count()) === 1 && (await newsCard.getByText('PBS NewsHour', { exact: true }).count()) === 1);
await newsCard.scrollIntoViewIfNeeded();
await shot(page, 'desktop-connections-news');
await newsCard.getByRole('combobox', { name: 'Headlines from' }).selectOption('uk');
await wait(400);
check('picking United Kingdom swaps in its top stories', /top stories for United Kingdom/.test(await newsStatus()) && (await newsCard.getByText('BBC News', { exact: true }).count()) === 1, await newsStatus());
await newsCard.getByRole('combobox', { name: 'Headlines from' }).selectOption('us');
await wait(400);
await newsCard.locator('.aw-acct-row', { hasText: 'CBS News' }).getByRole('button', { name: 'Remove' }).click();
await wait(400);
check('removing a default makes it your own list', /2 feeds, your own list/.test(await newsStatus()), await newsStatus());
await newsCard.getByRole('button', { name: /Use the top stories for United States/ }).click();
await wait(400);
check('back to the region defaults in one tap', /3 feeds, top stories for United States/.test(await newsStatus()), await newsStatus());

// ------------------------------------------------------------------------------------------------ What your hosts can see
await link.click();
await page.waitForURL(/#\/settings\/hosts-see/);
const next = page.locator('.aw-hostsee__next');
check('the page shows what the next break would bring up', await next.waitFor({ timeout: 30000 }).then(() => true, () => false));
const card = (title) => page.locator('.aw-acct-card').filter({ has: page.locator('.aw-acct-card__title', { hasText: new RegExp(`^${title}$`) }) });
const cal = card('Calendar');
check('Calendar: connected through the link, events in the preview', /Connected/.test((await cal.textContent()) ?? '') && (await cal.getByText(/Dentist appointment in/).count()) === 1, (await cal.locator('.aw-hostsee__facts').textContent())?.slice(0, 120));
const news = card('News');
const heads = await news.locator('.aw-hostsee__item').count();
check('News: headlines from the default feeds (through the server)', heads >= 3, `${heads} shown, ${(await news.locator('.aw-hostsee__facts').textContent())?.slice(0, 80)}`);
check('Weather: what the hosts would say', /degrees/.test((await card('Weather').textContent()) ?? ''));
check('Reminders: the one due soon', (await card('Reminders').getByText('Call the pharmacy about the refill').count()) === 1);
check('Life events and notes: birthday and note', /Mom's birthday/.test((await card('Life events and notes').textContent()) ?? '') && /Drink more water/.test((await card('Life events and notes').textContent()) ?? ''));
check('Email: not connected, said plainly', /Not connected/.test((await card('Email').textContent()) ?? ''));
check('every source says which stations use it', (await page.locator('.aw-hostsee__facts', { hasText: /On for/ }).count()) >= 6);
const nextItems = await next.locator('li').allTextContents();
check('the next break brings up something from the day', nextItems.length > 0 && nextItems.some((t) => /Dentist|pharmacy|Headline|birthday|Lunch|Flight|note/i.test(t)), nextItems.join(' | ').slice(0, 160));
await shot(page, 'desktop-hosts-see');
// the page scrolls inside the app shell: the source cards further down, one shot each
for (const t of ['News', 'Email', 'Reminders']) {
  await card(t).scrollIntoViewIfNeeded();
  await shot(page, `desktop-hosts-see-${t.toLowerCase()}`);
}
await page.getByRole('button', { name: 'Check now' }).click();
await wait(1500);
check('Check now fetches again and keeps the page', (await page.locator('.aw-hostsee__item').count()) > 3);

// ------------------------------------------------------------------------------------------------ station editor: talk mix
await page.goto(`${base}/#/stations/seed-station-881`);
const mix = page.getByRole('slider', { name: 'Talk mix' });
await mix.waitFor();
check('Talk mix sits next to the talk length, default leaning to your day', (await page.locator('.aw-talkmix').textContent())?.includes('More my day') === true);
await mix.focus();
await page.keyboard.press('ArrowLeft');
await wait(200);
check('moving it says what it means', /Songs and your day about evenly/.test((await page.locator('.aw-talkmix').textContent()) ?? ''));
check('a station with no feeds of its own uses your news', (await page.getByText('Your news from Settings', { exact: true }).count()) === 1);
await page.locator('.aw-talkmix').scrollIntoViewIfNeeded();
await shot(page, 'desktop-station-talk');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByText('Station saved').waitFor({ timeout: 8000 }).catch(() => undefined);
const saved = await page.evaluate(async () => (await window.__idb.get('stations', 'seed-station-881'))?.talkMix);
check('the talk mix is saved on the station', saved === 2, `talkMix ${saved}`);
check('new stations have email on (it airs once a mailbox is connected)', await page.evaluate(async () => (await window.__idb.get('stations', 'seed-station-881'))?.segments.email === true));

// ------------------------------------------------------------------------------------------------ email on with a mailbox
// a station from before (email off); the IMAP server answers from the browser here (the server's own tests cover IMAP)
await page.evaluate(async () => {
  const st = await window.__idb.get('stations', 'seed-station-881');
  await window.__idb.put('stations', { ...st, segments: { ...st.segments, email: false }, updatedAt: Date.now() });
});
let imapSaved = false;
await page.route('**/api/imap', (route) => {
  const box = { host: 'imap.mail.test', port: 993, secure: true, user: 'sam' };
  if (route.request().method() === 'PUT') {
    imapSaved = true;
    return route.fulfill({ json: { configured: true, unread: 3, ...box } });
  }
  return route.fulfill({ json: imapSaved ? { configured: true, ...box } : { configured: false } });
});
await page.goto(`${base}/#/settings/connections`);
await page.reload();
const imap = page.locator('.aw-acct-card', { hasText: 'Other email (IMAP)' });
await imap.getByLabel('IMAP server').fill('imap.mail.test');
await imap.getByLabel('User name').fill('sam');
await imap.getByLabel('Password').fill('an-app-password');
await imap.getByRole('button', { name: 'Save', exact: true }).click();
const told = await page.getByText('Your hosts can mention new mail now').waitFor({ timeout: 8000 }).then(() => true, () => false);
const emailOn = await page.evaluate(async () => (await window.__idb.get('stations', 'seed-station-881'))?.segments.email);
check('connecting a mailbox switches email on for every station and says so', told && emailOn === true, `toast ${told}, email ${emailOn}`);
await shot(page, 'desktop-email-on');
await page.unroute('**/api/imap');

// ------------------------------------------------------------------------------------------------ phone
await page.setViewportSize({ width: 390, height: 844 });
const fits = async (name) => {
  const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
  check(`${name} fits a 390 px phone`, w <= 391, `${w}px`);
};
await page.goto(`${base}/#/settings/hosts-see`);
await page.locator('.aw-hostsee__next').waitFor({ timeout: 30000 });
await wait(400);
await fits('What your hosts can see');
await shot(page, 'phone-hosts-see');
await card('News').scrollIntoViewIfNeeded();
await shot(page, 'phone-hosts-see-news');
await page.goto(`${base}/#/settings/connections?show=news`);
await page.locator('#news').waitFor();
await wait(900);
await fits('Connections');
await shot(page, 'phone-connections-news');
await page.goto(`${base}/#/stations/seed-station-881`);
await page.locator('.aw-talkmix').waitFor();
await page.locator('.aw-talkmix').scrollIntoViewIfNeeded();
await wait(300);
await fits('Station editor');
await shot(page, 'phone-station-talk');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));
await browser.close();
icsServer.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
