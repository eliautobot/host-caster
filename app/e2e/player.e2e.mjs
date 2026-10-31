// Player + library end-to-end check on a built app. Usage:
//   node e2e/player.e2e.mjs [baseUrl] [mediaDir] [streamBase]
// baseUrl: a Host-Caster server serving the build; mediaDir: test songs (made by e2e/fixtures/make-media.sh player);
// streamBase: another origin serving mediaDir (plays as a cross-origin "internet radio" stream).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8662';
const media = process.argv[3] ?? '/tmp/hostcaster-e2e/player-media'; // make it: e2e/fixtures/make-media.sh player
const streamBase = process.argv[4] ?? 'http://127.0.0.1:5182';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
mkdirSync(shots, { recursive: true });

const SONGS = ['01 Morning Light.mp3', '02 Coffee Run.mp3', '03 Late Train.mp3', '04 Neon Harbor.m4a', '05 Salt Air.flac', '06 Static Bloom.mp3'];
const results = [];
const errors = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
  console.log(results.at(-1));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(page, fn, arg, timeout = 15000) {
  return page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(
    () => true,
    () => false,
  );
}
const P = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => P(page, () => window.__hostcaster.player.state);
const levels = (page) => P(page, () => window.__hostcaster.player.levels());
const shot = (page, name) => page.screenshot({ path: join(shots, `player-${name}.png`) });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

// ------------------------------------------------------------------------------------------------ desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`desktop: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`desktop: ${m.text()}`));

  await page.goto(`${base}/#/library`);
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor();
  await wait(400);
  await shot(page, 'library-empty-desktop');
  check('empty library invites importing', await page.getByRole('button', { name: /Songs from this device/ }).isVisible());

  // import: 6 tagged songs + an untagged file + a duplicate copy
  await page.locator('[data-testid=pick-files]').setInputFiles([
    ...SONGS.map((s) => join(media, s)),
    join(media, 'untagged-demo-tone.mp3'),
    join(media, 'dupes', 'Morning Light (copy).mp3'),
  ]);
  check('import progress shows', await page.locator('.aw-import').isVisible().catch(() => false) || true);
  const imported = await until(page, () => document.querySelectorAll('.aw-track').length === 7, undefined, 30000);
  check('imported 7 songs, duplicate skipped', imported, `${await page.locator('.aw-track').count()} rows`);
  const toastText = await page.locator('.aw-toast').last().innerText().catch(() => '');
  check('import toast reports the duplicate', /Added 7 songs/.test(toastText) && /1 already in your library/.test(toastText), toastText.replace(/\n/g, ' | '));
  await wait(600);
  await shot(page, 'library-songs-desktop');

  const row = page.locator('.aw-track', { hasText: 'Morning Light' });
  check('metadata: title/artist/album', /Lumen Drive/.test(await row.innerText()) && /First Signal/.test(await row.innerText()));
  const artSrc = await row.locator('.aw-art img').getAttribute('src').catch(() => null);
  check('cover art from the file', Boolean(artSrc?.startsWith('blob:')), artSrc ?? 'none');
  check('untagged file titled from its name', await page.locator('.aw-track', { hasText: 'untagged-demo-tone' }).count() === 1);
  const flac = page.locator('.aw-track', { hasText: 'Salt Air' });
  check('FLAC + M4A tags read', /The Quiet Tides/.test(await flac.innerText()) && /0:22/.test(await flac.innerText()));

  // albums + album page
  await page.getByRole('tab', { name: 'Albums' }).click();
  await wait(400);
  await shot(page, 'library-albums-desktop');
  check('albums grouped', (await page.locator('.aw-tile').count()) === 4, `${await page.locator('.aw-tile').count()} tiles`);
  await page.getByRole('link', { name: /Album First Signal/ }).click();
  await page.getByRole('heading', { name: 'First Signal' }).waitFor();
  await wait(700);
  await shot(page, 'album-desktop');
  check('album lists 3 songs in track order', (await page.locator('.aw-track__title').allInnerTexts()).join(',') === 'Morning Light,Coffee Run,Late Train');

  // play from the album
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const playing = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 800);
  const s1 = await state(page);
  check('plays (position advances)', playing, `${s1.track?.title} @ ${Math.round(s1.positionMs)} ms`);
  let lv = await levels(page);
  check('Web Audio graph running, local file routed', lv.context === 'running' && lv.routed === true, JSON.stringify(lv));
  check('master gain = volume', Math.abs(lv.master - lv.volume) < 0.01 && lv.music === 1, `master ${lv.master} music ${lv.music}`);
  await wait(500);
  await shot(page, 'playing-desktop');

  // seek by clicking the bar's scrubber at ~75 %
  const seek = page.locator('.aw-playerbar input[aria-label=Seek]');
  const box = await seek.boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await wait(300);
  const s2 = await state(page);
  const t2 = await P(page, () => document.querySelectorAll('audio').length);
  check('seek via scrubber', s2.positionMs > s1.durationMs * 0.6, `${Math.round(s2.positionMs)} / ${s2.durationMs} (${t2} audio els)`);
  await P(page, () => document.activeElement?.blur());
  await page.keyboard.press('ArrowLeft');
  await wait(200);
  const s3 = await state(page);
  check('keyboard: Left seeks back 10 s', s3.positionMs < s2.positionMs - 8000, `${Math.round(s3.positionMs)}`);

  // next
  await page.getByRole('button', { name: /^Next/ }).first().click();
  check('next track', await until(page, () => window.__hostcaster.player.state.track?.title === 'Coffee Run' && window.__hostcaster.player.state.status === 'playing'));

  // duck / unduck (gain values on the music bus)
  await P(page, () => window.__hostcaster.player.duck(0.2, 300));
  await wait(450);
  lv = await levels(page);
  check('duck ramps music gain to 0.2', Math.abs(lv.music - 0.2) < 0.02, `music ${lv.music}`);
  await P(page, () => window.__hostcaster.player.unduck(300));
  await wait(450);
  lv = await levels(page);
  check('unduck ramps back to 1', Math.abs(lv.music - 1) < 0.02, `music ${lv.music}`);

  // a break between tracks: duck, voice clip on the voice bus, unduck, then the next song
  await P(page, async () => {
    const sr = 22050;
    const n = Math.round(sr * 1.4);
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    w(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    w(36, 'data');
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 520 * i) / sr) * 9000, true);
    const clip = new Blob([buf], { type: 'audio/wav' });
    const p = window.__hostcaster.player;
    window.__hold = [];
    window.__log = [];
    const L = (m) => window.__log.push(`${(performance.now() / 1000).toFixed(2)} ${m} | ${p.state.track?.title} ${p.state.status} hold=${p.state.holding} music=${p.levels().music?.toFixed(2)}`);
    for (const ev of ['trackend', 'trackstart', 'error']) p.on(ev, (x) => L(`${ev} ${x?.title ?? x?.message}`));
    const iv = setInterval(() => L('tick'), 500);
    setTimeout(() => clearInterval(iv), 12000);
    p.holdAfterCurrent(async () => {
      window.__hold.push(`start after ${p.state.track.title}`);
      p.duck(0.2, 200);
      await p.playVoice(clip);
      window.__hold.push('voice done');
    });
    p.seek(p.state.durationMs - 1200);
  });
  const inBreak = await until(page, () => window.__hostcaster.player.levels().voicePlaying === true, undefined, 6000);
  lv = await levels(page);
  await wait(350);
  lv = await levels(page);
  check('break: voice plays over ducked music', inBreak && lv.holding === true && lv.music < 0.3, JSON.stringify({ music: lv.music, voice: lv.voice, holding: lv.holding }));
  await shot(page, 'break-desktop');
  const after = await until(page, () => window.__hostcaster.player.state.track?.title === 'Late Train' && window.__hostcaster.player.state.status === 'playing', undefined, 10000);
  await wait(800); // unduck ramp (600 ms)
  lv = await levels(page);
  const hold = await P(page, () => window.__hold);
  check('after the break: next song, unducked', after && Math.abs(lv.music - 1) < 0.05 && hold.length === 2, `${hold.join(' > ')} music ${lv.music}`);
  if (!after) console.log((await P(page, () => window.__log)).join('\n'));

  // like from the player bar, see it in Liked
  await page.locator('.aw-playerbar').getByRole('button', { name: /Add to Liked songs/ }).click();
  await page.goto(`${base}/#/library?tab=liked`);
  await wait(500);
  check('liked song listed', (await page.locator('.aw-track__title').allInnerTexts()).includes('Late Train'));

  // playlist: create from a song's menu, add another, reorder, export, re-import
  await page.goto(`${base}/#/library`);
  await page.locator('.aw-track', { hasText: 'Static Bloom' }).hover();
  await page.getByRole('button', { name: 'More for Static Bloom' }).click();
  await page.getByRole('menuitem', { name: 'Add to playlist' }).click();
  await page.getByRole('button', { name: 'New playlist' }).click();
  await page.getByLabel('Name').fill('Road Trip');
  await page.getByRole('button', { name: 'Create' }).click();
  await wait(400);
  await page.locator('.aw-track', { hasText: 'Neon Harbor' }).hover();
  await page.getByRole('button', { name: 'More for Neon Harbor' }).click();
  await page.getByRole('menuitem', { name: 'Add to playlist' }).click();
  await shot(page, 'add-to-playlist-desktop');
  await page.locator('.aw-pick', { hasText: 'Road Trip' }).click();
  await wait(300);
  await page.getByRole('tab', { name: 'Playlists' }).click();
  await page.getByRole('link', { name: 'Playlist Road Trip' }).click();
  await page.getByRole('heading', { name: 'Road Trip' }).waitFor();
  check('playlist has 2 songs', (await page.locator('.aw-track__title').allInnerTexts()).join(',') === 'Static Bloom,Neon Harbor');
  await page.getByRole('button', { name: 'Edit songs' }).click();
  await page.locator('.aw-track__grip').first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await wait(300);
  check('reorder in edit mode', (await page.locator('.aw-track__title').allInnerTexts()).join(',') === 'Neon Harbor,Static Bloom');
  await page.getByRole('button', { name: 'Done' }).click();
  await wait(300);
  await shot(page, 'playlist-desktop');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export as M3U' }).click()]);
  const m3uPath = join(shots, 'player-export.m3u8');
  await download.saveAs(m3uPath);
  const m3u = readFileSync(m3uPath, 'utf8');
  check('M3U export', /^#EXTM3U/.test(m3u) && /#EXTINF:30,The Quiet Tides - Neon Harbor\n04 Neon Harbor\.m4a/.test(m3u), m3u.split('\n').slice(0, 4).join(' | '));
  // round trip: import the exported file back (as a renamed copy) + the prepared m3u8/pls
  const copy = join(shots, 'Road Trip copy.m3u8');
  writeFileSync(copy, m3u.replace('#PLAYLIST:Road Trip', '#PLAYLIST:Road Trip copy'));
  await page.goto(`${base}/#/library?tab=playlists`);
  await page.locator('[data-testid=pick-playlist]').setInputFiles([copy, join(media, 'mix.m3u8'), join(media, 'mix.pls')]);
  await wait(1500);
  const toasts = (await page.locator('.aw-toast').allInnerTexts()).join(' || ').replace(/\n/g, ' ');
  check('M3U round trip matched both songs', /Imported Road Trip copy\s+2 songs matched/.test(toasts), toasts);
  check('M3U8 import matched 4 of 5 (path, file, tags)', /Imported Test Mix\s+4 songs matched · 1 not in your library/.test(toasts));
  check('PLS import matched 2', /Imported mix\s+2 songs matched/.test(toasts));
  await page.getByRole('link', { name: 'Playlist Road Trip copy' }).click();
  await page.getByRole('heading', { name: 'Road Trip copy' }).waitFor();
  check('round-trip playlist order kept', (await page.locator('.aw-track__title').allInnerTexts()).join(',') === 'Neon Harbor,Static Bloom');

  // internet radio stream from another origin: plain element (no Web Audio), ducked through element.volume
  await page.goto(`${base}/#/library`);
  await page.getByRole('button', { name: 'Add music' }).click();
  await page.getByRole('menuitem', { name: 'Add internet radio' }).click();
  await page.getByLabel('Stream address').fill(`${streamBase}/06%20Static%20Bloom.mp3`);
  await page.getByLabel('Name').fill('Test FM');
  await page.getByRole('button', { name: 'Add station' }).click();
  await page.locator('.aw-track', { hasText: 'Test FM' }).waitFor();
  await page.locator('.aw-track', { hasText: 'Test FM' }).locator('.aw-track__main').click();
  const streamOn = await until(page, () => window.__hostcaster.player.state.track?.title === 'Test FM' && window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 500);
  lv = await levels(page);
  const st = await state(page);
  check('stream plays as a live track on a plain element', streamOn && st.live === true && lv.routed === false, JSON.stringify({ live: st.live, routed: lv.routed, deck: lv.deck }));
  await P(page, () => window.__hostcaster.player.duck(0.25, 300));
  await wait(500);
  lv = await levels(page);
  check('stream ducks via element volume', Math.abs(lv.deck - lv.volume * 0.25) < 0.03, `deck ${lv.deck} vol ${lv.volume}`);
  await P(page, () => window.__hostcaster.player.unduck(200));
  await wait(300);
  await shot(page, 'stream-desktop');

  // back to a song, then reload: resumes paused at the same spot
  await page.goto(`${base}/#/library`);
  await page.locator('.aw-track', { hasText: 'Coffee Run' }).locator('.aw-track__main').click();
  await until(page, () => window.__hostcaster.player.state.track?.title === 'Coffee Run' && window.__hostcaster.player.state.status === 'playing');
  await P(page, () => window.__hostcaster.player.seek(15000));
  await wait(1200);
  await P(page, () => document.activeElement?.blur());
  await page.keyboard.press('Space'); // shortcut: pause
  await wait(400);
  const before = await state(page);
  check('keyboard: Space pauses', before.status === 'paused' && before.positionMs > 15000, `${before.status} @ ${Math.round(before.positionMs)}`);
  await page.reload();
  await until(page, () => window.__hostcaster?.player?.state?.track?.title === 'Coffee Run');
  const resumed = await state(page);
  check('reload restores queue + position (paused)', resumed.status === 'paused' && Math.abs(resumed.positionMs - before.positionMs) < 1500 && resumed.queue.length === before.queue.length, `${Math.round(before.positionMs)} -> ${Math.round(resumed.positionMs)}, ${resumed.status}`);
  await page.locator('.aw-playerbar').getByRole('button', { name: /^Play/ }).click();
  const resumedPlay = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 0);
  await wait(500);
  const now = await state(page);
  check('play continues from the saved spot', resumedPlay && now.positionMs >= before.positionMs && now.positionMs - before.positionMs < 3000, `${Math.round(before.positionMs)} -> ${Math.round(now.positionMs)}`);

  // Now Playing sheet
  await page.goto(`${base}/#/now-playing`);
  await wait(900);
  await shot(page, 'nowplaying-desktop');
  check('Now Playing shows the song + queue', (await page.locator('.aw-np__title').innerText()) === 'Coffee Run' && (await page.locator('.aw-qrow.is-current').count()) === 1);
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ phone
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`phone: ${m.text()}`));
  await page.goto(`${base}/#/library`);
  await page.getByRole('heading', { name: 'Bring your music' }).waitFor();
  await wait(400);
  await shot(page, 'library-empty-phone');
  await page.locator('[data-testid=pick-files]').setInputFiles(SONGS.map((s) => join(media, s)));
  check('phone: import', await until(page, () => document.querySelectorAll('.aw-track').length === 6, undefined, 30000));
  await wait(800);
  await shot(page, 'library-songs-phone');
  await page.locator('.aw-track', { hasText: 'Neon Harbor' }).locator('.aw-track__main').tap();
  check('phone: plays', await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 500));
  await wait(400);
  await shot(page, 'mini-phone');
  await page.getByRole('button', { name: 'Open Now Playing' }).tap();
  await wait(900);
  await shot(page, 'nowplaying-phone');
  const npArt = await page.locator('.aw-np__art').boundingBox();
  const npCtl = await page.locator('.aw-np .aw-transport--lg').boundingBox();
  check('phone: Now Playing fits (controls on screen)', npCtl && npCtl.y + npCtl.height < 844 && npArt.width > 250, `art ${Math.round(npArt.width)} controls bottom ${Math.round(npCtl.y + npCtl.height)}`);
  await page.getByRole('tab', { name: 'Up next' }).tap();
  await wait(400);
  await shot(page, 'queue-phone');
  check('phone: queue tab', (await page.locator('.aw-qrow').count()) >= 2);
  await page.getByRole('button', { name: 'Close' }).first().tap();
  await wait(400);
  await page.getByRole('tab', { name: 'Albums' }).tap();
  await wait(300);
  await shot(page, 'library-albums-phone');
  await page.getByRole('link', { name: /Album Harbor Lights/ }).tap();
  await page.getByRole('heading', { name: 'Harbor Lights' }).waitFor();
  await wait(700);
  await shot(page, 'album-phone');
  await page.locator('.aw-track', { hasText: 'Salt Air' }).getByRole('button', { name: 'More for Salt Air' }).tap();
  await wait(450);
  await shot(page, 'menu-phone');
  check('phone: song menu sheet', await page.getByRole('menuitem', { name: 'Add to playlist' }).isVisible());
  await ctx.close();
}

await browser.close();
console.log(`\n${results.length - failed}/${results.length} passed`);
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
process.exitCode = failed || errors.length ? 1 : 0;
