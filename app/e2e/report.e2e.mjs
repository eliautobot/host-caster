// "Report this break" end to end (store rules for AI content: report without leaving the app). On-air history and the
// Now Playing On Air strip open the report sheet; signed out it asks to sign in; signed in the report reaches the
// server's reports table. Desktop 1440x900 and phone 390x844.
// Usage: node e2e/report.e2e.mjs [distDir] [port]   (self-hosted server with a local account, temp DATA_DIR)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? '/tmp/hc-rep-dist');
const port = Number(process.argv[3] ?? 8697);
const base = `http://127.0.0.1:${port}`;
const shots = process.env.SHOTS ?? '/tmp/hc-rep-shots';
mkdirSync(shots, { recursive: true });

let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (loc, timeout = 8000) => loc.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
const shot = (page, name) => page.screenshot({ path: join(shots, `report-${name}.png`) });

// ------------------------------------------------------------------------------------------------ server
const dataDir = mkdtempSync(join(tmpdir(), 'hc-rep-e2e-'));
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: resolve(here, '../../server'),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, DATA_DIR: dataDir, APP_DIST: dist, ALLOW_LOCAL_ACCOUNTS: 'true', LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 100; i++) {
  if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
  await wait(100);
}
const reportsOnServer = () => {
  const db = new DatabaseSync(join(dataDir, 'hostcaster.db'), { readOnly: true });
  try {
    return db.prepare('SELECT user_id, kind, json FROM reports ORDER BY created_at').all().map((r) => ({ ...r, json: JSON.parse(r.json) }));
  } finally {
    db.close();
  }
};

const LINES = [
  [
    { hostId: 'seed-host-maya', text: 'Good morning! Grey skies today, so keep that umbrella close.' },
    { hostId: 'seed-host-jules', text: 'And here is a song that sounds like sunshine anyway.' },
  ],
  [{ hostId: 'seed-host-jules', text: 'That was a classic. Maya, you were singing along, I heard you.' }],
];

/** Two breaks in this browser's on-air history (raw IndexedDB; the page is reloaded after). */
const seedBreaks = (page) =>
  page.evaluate(async (lines) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('hostcaster');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction('breaks', 'readwrite');
    const t = Date.now();
    lines.forEach((l, i) =>
      tx.objectStore('breaks').put({ id: `e2e-break-${i}`, stationId: 'seed-station-881', at: t - (i + 1) * 60_000, lines: l, topics: ['weather'], createdAt: t, updatedAt: t }),
    );
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, LINES);

const account = (page, path, email) =>
  page.evaluate(
    async ([p, e]) => {
      const res = await fetch(p, { method: 'POST', headers: { 'x-hostcaster': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: 'correct horse battery', name: 'Sam' }) });
      return res.status;
    },
    [path, email],
  );

const browser = await chromium.launch();
const listen = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|status of 40[139]/.test(m.text()) && errors.push(`${tag}: ${m.text()}`));
};

async function run(tag, viewport, email, signUp) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark' });
  const page = await ctx.newPage();
  listen(page, tag);
  await page.goto(`${base}/#/on-air`);
  await page.getByRole('heading', { name: 'On-air history' }).waitFor();
  await seedBreaks(page);
  await page.reload();
  await page.locator('.aw-break').first().waitFor();
  const flags = page.getByRole('button', { name: 'Report this break' });
  check(`${tag}: every break in On-air history has "Report this break"`, (await flags.count()) === 2, `${await flags.count()} buttons`);

  // signed out: the sheet says to sign in, nothing is sent
  await flags.first().click();
  const sheet = page.getByRole('dialog', { name: 'Report this break' });
  check(`${tag}: signed out, the sheet says to sign in`, await visible(sheet.getByText('Sign in to report a break')));
  check(`${tag}: signed out, the sheet offers Sign in`, await visible(sheet.getByRole('button', { name: 'Sign in' })));
  await wait(300);
  await shot(page, `${tag}-signed-out`);
  await sheet.getByRole('button', { name: 'Not now' }).click();
  await sheet.waitFor({ state: 'hidden' });

  // signed in (local account), the report goes to the server
  check(`${tag}: account`, (await account(page, signUp ? '/api/auth/local/signup' : '/api/auth/local/login', email)) === (signUp ? 201 : 200));
  await page.reload();
  await page.locator('.aw-break').first().waitFor();
  await wait(800);
  const before = reportsOnServer().length;
  await page.getByRole('button', { name: 'Report this break' }).first().click();
  check(`${tag}: the sheet shows the break's lines`, await visible(sheet.getByText(LINES[0][0].text)));
  check(`${tag}: host names in the sheet`, await visible(sheet.getByText('Maya', { exact: true })));
  await sheet.getByLabel('Add a note (optional)').fill('Not nice about my town.');
  await wait(300);
  await shot(page, `${tag}-history-sheet`);
  const fits = await page.evaluate(() => {
    const d = document.querySelector('[role=dialog]')?.getBoundingClientRect();
    return Boolean(d && d.left >= 0 && d.right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1);
  });
  check(`${tag}: the sheet fits the screen`, fits);
  await sheet.getByRole('button', { name: 'Send report' }).click();
  check(`${tag}: thank-you toast`, await visible(page.getByText('Thanks. We will look at it.')));
  const rows = reportsOnServer();
  const last = rows.at(-1);
  check(`${tag}: stored on the server`, rows.length === before + 1 && last?.kind === 'break', `${rows.length} rows`);
  check(
    `${tag}: report has the lines, names, station and note`,
    last?.json.lines?.[0]?.hostName === 'Maya' && last.json.lines[0].text === LINES[0][0].text && last.json.note === 'Not nice about my town.' && Boolean(last.json.stationName),
    JSON.stringify(last?.json).slice(0, 140),
  );

  // Now Playing: the On Air strip reports the last break (radio state set as after a break)
  await page.goto(`${base}/#/now-playing`);
  await page.evaluate((lines) => {
    const t = Date.now();
    window.__hostcaster.radio.set({ stationId: 'seed-station-881', onAir: true, phase: 'music', nextBreakIn: 2, lastBreak: { id: 'e2e-last', stationId: 'seed-station-881', at: t - 30_000, lines, topics: [], createdAt: t, updatedAt: t } });
  }, LINES[1]);
  const strip = page.getByRole('region', { name: 'On air' });
  check(`${tag}: On Air strip has "Report this break"`, await visible(strip.getByRole('button', { name: 'Report this break' })));
  check(`${tag}: and still "Talk to the hosts"`, await visible(strip.getByRole('button', { name: 'Talk to the hosts' })));
  await wait(400);
  await shot(page, `${tag}-now-playing-strip`);
  await strip.getByRole('button', { name: 'Report this break' }).click();
  check(`${tag}: strip sheet shows the last break`, await visible(sheet.getByText(LINES[1][0].text)));
  await sheet.getByRole('button', { name: 'Send report' }).click();
  check(`${tag}: strip report sent`, await visible(page.getByText('Thanks. We will look at it.')));
  check(`${tag}: strip report stored`, reportsOnServer().at(-1)?.json.lines?.[0]?.text === LINES[1][0].text);
  await ctx.close();
}

try {
  await run('desktop', { width: 1440, height: 900 }, 'sam@example.com', true);
  await run('phone', { width: 390, height: 844 }, 'sam@example.com', false);
} catch (err) {
  failed++;
  console.log(`FAIL threw: ${err.message.split('\n')[0]}`);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
