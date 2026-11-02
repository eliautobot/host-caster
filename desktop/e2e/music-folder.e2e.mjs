// "Add a music folder" in the desktop app (Electron): the system Music folder (of a temporary HOME, filled with test
// songs) is suggested and added without a picker, its songs come in with their tags (ringtones and an 8 s beep left
// out), play from where they are and seek (app://host-caster/_device/, byte ranges), a new file and a deleted one are
// picked up on the next start, and Remove from library takes them out (the files stay). No server is needed.
//   desktop/scripts/build-app.sh; HC_E2E=desktop/e2e/music-folder.e2e.mjs MEDIA=<dir with hc-test-1..5.mp3,
//   short-beep.mp3> [HC_ELECTRON=<electron binary>] desktop/e2e/run-xvfb.sh
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '..');
const { _electron } = createRequire(resolve(desktopDir, '../app/package.json'))('playwright');
const EXE = process.env.HC_ELECTRON ?? join(desktopDir, 'node_modules/electron/dist/electron');
const MEDIA = process.env.MEDIA ?? '/tmp/hc-dm-media';
const shots = process.env.SHOTS ?? '/tmp/hc-desktop-music-shots';
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} desktop: ${name}${detail ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const home = mkdtempSync(join(tmpdir(), 'hc-music-home-'));
const music = join(home, 'Music');
const put = (from, to) => {
  mkdirSync(dirname(join(music, to)), { recursive: true });
  cpSync(join(MEDIA, from), join(music, to));
};
put('hc-test-1.mp3', 'Albums/Device Test/01 Harbor Test.mp3');
put('hc-test-2.mp3', 'Albums/Device Test/02 Lantern Test.mp3');
put('hc-test-3.mp3', 'Albums/Device Test/03 Meadow Test.mp3');
put('hc-test-4.mp3', 'Singles/Night Test.mp3');
put('short-beep.mp3', 'Singles/Short Beep.mp3');
put('hc-test-4.mp3', 'Ringtones/Ring.mp3');
mkdirSync(join(home, '.config'), { recursive: true });
writeFileSync(join(home, '.config/user-dirs.dirs'), `XDG_MUSIC_DIR="$HOME/Music"\n`);

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  HOSTCASTER_USER_DATA: join(home, 'user-data'),
  HOSTCASTER_SERVER: 'http://127.0.0.1:9',
  HOSTCASTER_NO_PROTOCOL: '1',
  HOSTCASTER_UPDATE_URL: 'http://127.0.0.1:9/latest.json',
};
const launch = async () => {
  const app = await _electron.launch({ executablePath: EXE, args: [join(desktopDir, '.build/stage')], env, timeout: 60000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize?.({ width: 1440, height: 900 });
  return { app, page };
};
const rows = (page) => page.locator('.aw-track').count();
const until = (page, fn, arg, timeout = 20000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 200 }).then(
    () => true,
    () => false,
  );

try {
  let { app, page } = await launch();
  await page.goto('app://host-caster/#/library');
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor({ timeout: 30000 });
  const opt = page.getByRole('button', { name: /Your music folder/ });
  check('the empty library offers "Your music folder"', await opt.isVisible());
  await opt.click();
  await page.getByRole('heading', { name: 'Music folders' }).waitFor();
  await page.getByText(music).waitFor({ timeout: 10000 }).catch(() => undefined);
  check('the system Music folder is suggested', await page.getByText(music).isVisible(), music);
  await page.screenshot({ path: join(shots, 'desktop-music-intro.png') });
  await page.getByRole('button', { name: 'Use my Music folder' }).click();
  const found = await until(page, () => /Found \d+ songs? in \d+ folders?/.test(document.body.innerText));
  const summary = await page.locator('.aw-devmusic__summary').innerText().catch(() => '');
  check('found the songs per folder, ringtones left out', found && /Found 5 songs in 2 folders/.test(summary), summary);
  await page.screenshot({ path: join(shots, 'desktop-music-found.png') });
  await page.getByRole('button', { name: /^Add \d+ songs?$/ }).click();
  const added = await until(page, () => document.querySelectorAll('.aw-track').length === 4 && !document.querySelector('.aw-devmusic'), null, 30000);
  check('4 songs added with their tags (the 8 s beep left out)', added && /HC Device Band/.test(await page.locator('main').innerText()), `${await rows(page)} rows`);

  await page.getByRole('button', { name: /Play Meadow Test by HC Device Band/ }).dblclick();
  const plays = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 300, null, 15000);
  check('a song from the folder plays', plays);
  await page.evaluate(() => window.__hostcaster.player.seek(40_000));
  await wait(1500);
  const pos = await page.evaluate(() => {
    const el = window.__hostcaster.player.active?.element;
    return { s: Math.round(window.__hostcaster.player.state.positionMs), el: Math.round((el?.currentTime ?? 0) * 1000), src: el?.src ?? '' };
  });
  check('it seeks (ranged app:// stream)', Math.abs(pos.el - 41_500) < 2500 && pos.src.startsWith('app://host-caster/_device/'), JSON.stringify(pos).slice(0, 120));
  await page.evaluate(() => window.__hostcaster.player.pause());

  // the next start: a new song, a deleted one
  put('hc-test-5.mp3', 'Singles/Late Addition.mp3');
  rmSync(join(music, 'Albums/Device Test/02 Lantern Test.mp3'));
  await app.close();
  ({ app, page } = await launch());
  await page.goto('app://host-caster/#/library');
  const synced = await until(page, () => /Late Addition/.test(document.body.innerText) && !/Lantern Test/.test(document.body.innerText), null, 30000);
  check('next start: the new song is added and the deleted one removed', synced, `${await rows(page)} rows`);

  await page.getByRole('button', { name: 'Add music' }).click();
  await page.getByRole('menuitem', { name: 'Add a music folder' }).click();
  await until(page, () => /Found \d+ songs?/.test(document.body.innerText));
  await page.getByRole('button', { name: 'Remove from library' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  const gone = await until(page, () => document.querySelectorAll('.aw-track').length === 0, null, 15000);
  check('Remove from library takes them out, the files stay', gone && existsSync(join(music, 'Singles/Night Test.mp3')));
  await app.close();
} catch (err) {
  check('run', false, err instanceof Error ? err.message : String(err));
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
