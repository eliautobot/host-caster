// "Add a music folder" in Chrome (the web app's device music): pick a folder, see what was found per folder, add the
// songs where they are (tags + covers, no copy), no doubles, play and seek one, then "Keep my music up to date": a new
// file is added and a deleted one removed on the next start. The folder picker is answered with a real directory
// handle from the browser's private file system (the native picker cannot be driven), filled with test songs.
//   node e2e/device-music.e2e.mjs <baseUrl>   (a debug build served by e2e/fixtures/serve-dist.mjs, with
//   <dist>/dm-media/: hc-test-1..5.mp3 and short-beep.mp3 from the device-music log)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:8742';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-devmusic-shots';
mkdirSync(shots, { recursive: true });
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (page, fn, arg, timeout = 15000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 150 }).then(
    () => true,
    () => false,
  );

// the picker answers with OPFS/Music (filled below)
const PICKER = () => {
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Music', { create: true });
};
/** writes /dm-media/<from> to OPFS Music/<to> (folders made as needed); to = null deletes */
const put = (page, files) =>
  page.evaluate(async (list) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Music', { create: true });
    for (const [from, to] of list) {
      const parts = to.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      if (!from) {
        await dir.removeEntry(parts.at(-1));
        continue;
      }
      const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(await (await fetch(`/dm-media/${from}`)).blob());
      await w.close();
    }
  }, files);
const rows = (page) => page.locator('.aw-track').count();

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await ctx.addInitScript(PICKER);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/#/library`);
await page.getByRole('heading', { name: 'Bring your music' }).waitFor();

// one song imported the old way first: the folder has the same song, it must not come in twice
await page.locator('[data-testid=pick-files]').setInputFiles([]);
await page.evaluate(async () => {
  const dt = new DataTransfer();
  const blob = await (await fetch('/dm-media/hc-test-1.mp3')).blob();
  dt.items.add(new File([blob], 'Harbor Test (my copy).mp3', { type: 'audio/mpeg' }));
  const el = document.querySelector('[data-testid=pick-files]');
  el.files = dt.files;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
check('one song imported as a file', await until(page, () => document.querySelectorAll('.aw-track').length === 1, null, 20000));
await put(page, [
  ['hc-test-1.mp3', 'Albums/Device Test/01 Harbor Test.mp3'],
  ['hc-test-2.mp3', 'Albums/Device Test/02 Lantern Test.mp3'],
  ['hc-test-3.mp3', 'Albums/Device Test/03 Meadow Test.mp3'],
  ['hc-test-4.mp3', 'Singles/Night Test.mp3'],
  ['short-beep.mp3', 'Singles/Short Beep.mp3'],
  ['hc-test-4.mp3', 'Ringtones/My Ringtone.mp3'],
]);

// the menu entry
await page.getByRole('button', { name: 'Add music' }).click();
const item = page.getByRole('menuitem', { name: 'Add a music folder' });
check('Add music menu offers "Add a music folder"', await item.isVisible());
await item.click();
await page.getByRole('heading', { name: 'Music folders' }).waitFor();
await wait(400);
await page.screenshot({ path: join(shots, 'devmusic-intro-desktop.png') });
check('intro says nothing is copied', await page.getByText('Nothing is copied or uploaded.').isVisible());
await page.getByRole('button', { name: 'Choose a folder' }).click();
const found = await until(page, () => /Found \d+ songs? in \d+ folders?/.test(document.body.innerText), null, 20000);
const summary = await page.locator('.aw-devmusic__summary').innerText().catch(() => '');
// Ringtones is left out by its folder; the 8 s beep only once its length is read (it is counted, then skipped)
check('found the songs per folder, ringtones left out', found && /Found 5 songs in 2 folders/.test(summary), summary);
check('a switch per folder', (await page.locator('.aw-devmusic__folder').count()) === 2);
check('"Keep my music up to date" is on', await page.getByRole('switch', { name: /Keep my music up to date/ }).isChecked().catch(() => false));
await page.screenshot({ path: join(shots, 'devmusic-found-desktop.png') });
const addBtn = page.getByRole('button', { name: /^Add \d+ songs?$/ });
const addLabel = await addBtn.innerText();
check('offers to add what is new', /Add 5 songs/.test(addLabel), addLabel);
await addBtn.click();
const added = await until(page, () => document.querySelectorAll('.aw-track').length >= 4 && !document.querySelector('.aw-devmusic'), null, 30000);
await wait(800);
const toast = await page.locator('.aw-toast').last().innerText().catch(() => '');
check('songs added (the copy, the beep: not again)', added && (await rows(page)) === 4, `${await rows(page)} rows; ${toast.replace(/\n/g, ' | ')}`);
const lib = await page.evaluate(async () => {
  const req = indexedDB.open('hostcaster');
  const db = await new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const all = await new Promise((res) => {
    const r = db.transaction('tracks').objectStore('tracks').getAll();
    r.onsuccess = () => res(r.result);
  });
  return all.map((t) => ({ title: t.title, artist: t.artist, album: t.album, source: t.source, ref: t.ref, art: Boolean(t.artworkId), ms: t.durationMs, path: t.file?.path }));
}).catch((e) => [{ error: String(e) }]);
const dev = lib.filter((t) => t.source === 'device');
check('device songs keep their tags, covers and length', dev.length === 3 && dev.every((t) => t.artist === 'HC Device Band' && t.album === 'Device Test Album' && t.art && t.ms > 40000), JSON.stringify(dev[0] ?? lib[0]).slice(0, 160));
check('stored as references (no audio copied)', dev.every((t) => t.ref.startsWith('web:') && t.path?.startsWith('Music/')));
await page.screenshot({ path: join(shots, 'devmusic-library-desktop.png') });

// play one from the folder and seek in it
await page.getByRole('button', { name: /Play Meadow Test by HC Device Band/ }).dblclick();
const plays = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === 'device' && window.__hostcaster.player.state.positionMs > 300, null, 15000);
check('a device song plays', plays);
await page.evaluate(() => window.__hostcaster.player.seek(40_000));
await wait(1200);
const pos = await page.evaluate(() => ({ s: window.__hostcaster.player.state.positionMs, el: window.__hostcaster.player.active?.element?.currentTime * 1000, src: window.__hostcaster.player.active?.element?.src?.slice(0, 5) }));
check('seeking in it moves the audio', Math.abs(pos.s - 41_000) < 2500 && Math.abs(pos.el - 41_000) < 2500 && pos.src === 'blob:', JSON.stringify(pos));
await page.evaluate(() => window.__hostcaster.player.pause());

// keep up to date: a new song, a deleted one, then the app opens again
await put(page, [
  ['hc-test-5.mp3', 'Singles/Late Addition.mp3'],
  [null, 'Albums/Device Test/02 Lantern Test.mp3'],
]);
await page.reload();
const synced = await until(
  page,
  () => {
    const t = document.body.innerText;
    return /Late Addition/.test(t) && !/Lantern Test/.test(t);
  },
  null,
  25000,
);
check('next start: the new song is added and the deleted one removed', synced, `${await rows(page)} rows`);
check('nothing else touched (the imported copy stays)', /Harbor Test/.test(await page.locator('main').innerText()));

// the sheet again, at phone size
await page.setViewportSize({ width: 390, height: 844 });
await page.getByRole('button', { name: 'Add music' }).click();
await page.getByRole('menuitem', { name: 'Add a music folder' }).click();
await until(page, () => /Found \d+ songs?/.test(document.body.innerText), null, 15000);
await wait(500);
await page.screenshot({ path: join(shots, 'devmusic-phone.png') });
const sheet = await page.locator('.aw-sheet, [role=dialog]').first().boundingBox();
check('phone: the sheet fits the screen', sheet && sheet.width <= 390 && sheet.y >= 0, JSON.stringify(sheet));
check('says these songs do not sync', await page.getByText(/do not sync to your other devices/).isVisible());
check('nothing left to add: skipped files are not offered again', await page.getByRole('button', { name: 'Done' }).isVisible(), await page.locator('.aw-sheet footer, .aw-sheet__footer').innerText().catch(() => ''));

await browser.close();
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
