// Screenshots of the built app. Usage: node scripts/screenshots.mjs [baseUrl] [outDir] [prefix]
// Start a server first (cd server && PORT=8661 HOST=127.0.0.1 npm start).
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8661';
const out = process.argv[3] ?? '/tmp/hostcaster-shots';
const prefix = process.argv[4] ?? 'scaffold';
const theme = process.env.THEME ?? 'dark';
const routes = (process.env.ROUTES ?? 'home:/,library:/library,hosts:/hosts,settings:/settings')
  .split(',')
  .map((r) => r.split(':'));

const devices = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];
for (const d of devices) {
  const ctx = await browser.newContext({ ...d, colorScheme: theme === 'light' ? 'light' : 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${d.name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${d.name}: ${m.text()}`));
  await page.goto(`${base}/#/`);
  if (theme !== 'dark') {
    // theme lives in IndexedDB settings; switch it the way a user would
    await page.goto(`${base}/#/settings/appearance`);
    await page.getByRole('tab', { name: theme === 'light' ? 'Light' : 'System' }).click();
    await page.waitForTimeout(300);
  }
  for (const [name, path] of routes) {
    await page.goto(`${base}/#${path}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(450);
    const file = `${out}/${prefix}-${name}-${d.name}${theme === 'dark' ? '' : `-${theme}`}.png`;
    await page.screenshot({ path: file });
    console.log(file);
  }
  await ctx.close();
}
await browser.close();
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
}
