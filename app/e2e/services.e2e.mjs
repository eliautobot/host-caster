// Music services end-to-end check on a built app (owner: services builder). Usage:
//   node e2e/services.e2e.mjs [baseUrl] [subsonicUrl] [subsonicUser] [subsonicPass]
// baseUrl: a Host-Caster server serving the build. subsonicUrl: a real Navidrome (or other Subsonic) server with the
// test songs (see .work/services.md). Internet radio uses the real radio-browser.info directory and a real stream.
// Spotify and YouTube have no test accounts: their HTTP APIs are mocked with recorded shapes (marked MOCK below);
// YouTube playback uses the real IFrame player.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8666';
const ssUrl = process.argv[3] ?? 'http://127.0.0.1:4533';
const ssUser = process.argv[4] ?? 'admin';
const ssPass = process.argv[5] ?? process.env.SUBSONIC_PASS ?? '';
const shots = process.env.SHOTS ?? '/tmp/hostcaster-shots';
const only = process.env.ONLY?.split(',');
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
const until = (page, fn, arg, timeout = 15000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 150 }).then(
    () => true,
    () => false,
  );
const pstate = (page) => page.evaluate(() => window.__hostcaster?.player?.state);
const shot = (page, name) => page.screenshot({ path: join(shots, `services-${name}.png`) });
const want = (k) => !only || only.includes(k);
/** Nothing sticks out past the right edge (the app's <main> hides overflow, so scrollWidth alone misses it). */
const fitsWidth = (page) =>
  page.evaluate(() => {
    const W = window.innerWidth;
    const scrolls = (e) => ['auto', 'scroll'].includes(getComputedStyle(e).overflowX);
    for (const el of document.querySelectorAll('main *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right <= W + 1) continue;
      let a = el.parentElement;
      let clipped = false;
      while (a && a.tagName !== 'MAIN') {
        if (scrolls(a) || (getComputedStyle(a).overflowX === 'hidden' && a.getBoundingClientRect().right <= W + 1)) clipped = true;
        a = a.parentElement;
      }
      if (!clipped) return `${el.tagName}.${el.className} right=${Math.round(r.right)}`;
    }
    return true;
  });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function newPage(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'dark', ...opts });
  const page = await ctx.newPage();
  const tag = viewport.width < 600 ? 'phone' : 'desktop';
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource|youtube|ERR_|net::|status of 4\d\d/i.test(t)) errors.push(`${tag}: ${t}`);
  });
  return { ctx, page };
}

// ---------------------------------------------------------------------------------------------- desktop
const { ctx, page } = await newPage({ width: 1440, height: 900 });
await page.goto(`${base}/#/settings/music-services`);
await page.getByRole('heading', { name: 'Your music server' }).waitFor();
await wait(500);
check('settings lists Music services', await page.getByRole('link', { name: /Music services/ }).first().isVisible());
for (const t of ['Your music server', 'Internet radio', 'YouTube Music', 'Spotify', 'Other music apps']) {
  check(`card: ${t}`, await page.getByRole('heading', { name: t, exact: true }).isVisible());
}
await shot(page, 'settings-desktop');

// ---- Subsonic ----------------------------------------------------------------------------------------------------
if (want('subsonic')) {
  const card = page.locator('#svc-subsonic');
  await card.getByLabel('Server address').fill(ssUrl.replace(/^http:\/\//, ''));
  await card.getByLabel('Username').fill(ssUser);
  await card.getByLabel('Password').fill('wrong-password');
  await card.getByRole('button', { name: 'Connect' }).click();
  check('subsonic: wrong password is explained', await card.getByText('Wrong username or password.').waitFor({ timeout: 8000 }).then(() => true, () => false));
  await card.getByLabel('Password').fill(ssPass);
  await card.getByRole('button', { name: 'Connect' }).click();
  const connected = await card.getByText('Connected', { exact: true }).waitFor({ timeout: 8000 }).then(() => true, () => false);
  const status = await card.locator('.aw-svc-card__status').innerText();
  check('subsonic: connects with token auth', connected, status);
  const stored = await page.evaluate(async () => {
    const req = indexedDB.open('hostcaster');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const tx = db.transaction('kv');
    const got = await new Promise((r) => {
      const g = tx.objectStore('kv').get('subsonic:auth');
      g.onsuccess = () => r(g.result);
    });
    return JSON.stringify(got ?? null);
  });
  check('subsonic: password not stored', !stored.includes(ssPass) && stored.includes('"token"'));
  await shot(page, 'subsonic-connected-desktop');

  await card.getByRole('button', { name: 'Browse your server' }).click();
  await page.getByRole('list', { name: 'Playlists' }).waitFor();
  await wait(600);
  check('subsonic: playlists listed', await page.getByRole('button', { name: /^Evening Mix/ }).isVisible());
  await shot(page, 'subsonic-playlists-desktop');

  await page.getByRole('tab', { name: 'Albums' }).click();
  await page.getByRole('button', { name: /^Night Drive/ }).waitFor();
  check('subsonic: albums listed', await page.getByRole('button', { name: /^Low Tide/ }).isVisible());
  await wait(400);
  await shot(page, 'subsonic-albums-desktop');
  await page.getByRole('tab', { name: 'Artists' }).click();
  check('subsonic: artists listed', await page.getByRole('button', { name: /^Signal Orange/ }).waitFor({ timeout: 6000 }).then(() => true, () => false));

  await page.getByLabel('Search your server').fill('Harbour');
  check('subsonic: search', await page.getByRole('button', { name: /^Harbour Lights/ }).waitFor({ timeout: 6000 }).then(() => true, () => false));
  await page.getByLabel('Search your server').fill('');

  await page.getByRole('tab', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: /^Evening Mix/ }).click();
  await page.getByRole('heading', { name: 'Evening Mix' }).waitFor();
  await wait(500);
  await shot(page, 'subsonic-playlist-desktop');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const playing = await until(page, () => window.__hostcaster?.player?.state.status === 'playing', undefined, 15000);
  await wait(2500);
  const s = await pstate(page);
  check('subsonic: plays from the server', playing && s?.track?.source === 'subsonic' && s.positionMs > 1000, `${s?.track?.title} @ ${s?.positionMs} ms`);
  const lib = await page.evaluate(async () => {
    const req = indexedDB.open('hostcaster');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all = (store) =>
      new Promise((r) => {
        const g = db.transaction(store).objectStore(store).getAll();
        g.onsuccess = () => r(g.result);
      });
    const tracks = await all('tracks');
    const lists = await all('playlists');
    return { subsonic: tracks.filter((t) => t.source === 'subsonic').length, withArt: tracks.filter((t) => t.source === 'subsonic' && t.artworkId).length, playlist: lists.find((p) => p.source === 'subsonic')?.name };
  });
  check('subsonic: imported as tracks + playlist with covers', lib.subsonic === 3 && lib.playlist === 'Evening Mix' && lib.withArt === 3, JSON.stringify(lib));
  await shot(page, 'subsonic-playing-desktop');
  await page.evaluate(() => window.__hostcaster.player.pause());

  // a station from the server playlist goes on air: songs stream from Navidrome, a host breaks in, music carries on
  await page.getByRole('button', { name: 'Make a station' }).click();
  check('subsonic: makes a station', await page.getByText('Station ready').first().waitFor({ timeout: 8000 }).then(() => true, () => false));
  const stationId = await page.evaluate(async () => {
    const req = indexedDB.open('hostcaster');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all = await new Promise((r) => {
      const g = db.transaction('stations').objectStore('stations').getAll();
      g.onsuccess = () => r(g.result);
    });
    return all.find((s) => s.sources.some((x) => x.kind === 'playlist'))?.id;
  });
  if (stationId) {
    await page.evaluate((id) => window.__hostcaster.radio.start(id), stationId);
    const onAir = await until(page, () => window.__hostcaster.radio.state.onAir && window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === 'subsonic', undefined, 15000);
    await page.evaluate(() => void window.__hostcaster.radio.talkNow('Say hello to the listener'));
    const talked = await until(page, () => window.__hostcaster.radio.state.phase === 'talking', undefined, 60000);
    const lines = await page.evaluate(() => (window.__hostcaster.radio.state.script ?? []).map((l) => l.text).join(' | '));
    await shot(page, 'subsonic-onair-desktop');
    const back = await until(page, () => window.__hostcaster.radio.state.phase === 'music' && window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === 'subsonic', undefined, 90000);
    check('subsonic: station on air with a host break, music resumes', onAir && talked && back, `${lines.slice(0, 140)}${lines.length > 140 ? '…' : ''}`);
    await page.evaluate(() => window.__hostcaster.radio.stop());
  } else check('subsonic: station found', false);
}

// ---- Internet radio ----------------------------------------------------------------------------------------------
if (want('radio')) {
  await page.goto(`${base}/#/services/radio`);
  await page.getByRole('heading', { name: 'Popular right now' }).waitFor();
  const popular = await page.getByRole('list', { name: 'Stations' }).getByRole('listitem').first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  check('radio: popular stations load', popular);
  await wait(800);
  await shot(page, 'radio-popular-desktop');
  await page.getByRole('group', { name: 'Genres' }).getByRole('button', { name: 'jazz', exact: true }).click().catch(() => undefined);
  await page.getByLabel('Search stations').fill('Classic Vinyl HD');
  const row = page.getByRole('list', { name: 'Stations' }).getByRole('button', { name: /^Classic Vinyl HD/ }).first();
  const found = await row.waitFor({ timeout: 15000 }).then(() => true, () => false);
  check('radio: search by name + genre', found);
  await wait(500);
  await shot(page, 'radio-search-desktop');
  if (found) {
    await row.click();
    const ok = await until(page, () => window.__hostcaster?.player?.state.status === 'playing', undefined, 20000);
    await wait(1500);
    const a = await pstate(page);
    await wait(3000);
    const s = await pstate(page);
    const advanced = (s?.positionMs ?? 0) - (a?.positionMs ?? 0);
    check('radio: a live stream plays', ok && s?.status === 'playing' && s?.track?.source === 'stream' && advanced > 2000, `${s?.track?.title}, +${Math.round(advanced)} ms in 3 s, live=${s?.live}`);
    await shot(page, 'radio-playing-desktop');
    await page.getByRole('button', { name: 'Save to library' }).first().click();
    check('radio: saved', await page.getByRole('button', { name: 'Remove from saved' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false));
    await page.getByRole('button', { name: /More for Classic Vinyl HD/ }).first().click();
    await page.getByRole('menuitem', { name: 'Make a Host-Caster station' }).click();
    check('radio: makes a station', await page.getByText('Station ready').waitFor({ timeout: 6000 }).then(() => true, () => false));
    await page.evaluate(() => window.__hostcaster.player.pause());
    // the live stream as a Host-Caster station: a host breaks in over it, the stream keeps going
    const rid = await page.evaluate(async () => {
      const req = indexedDB.open('hostcaster');
      const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
      const all = await new Promise((r) => {
        const g = db.transaction('stations').objectStore('stations').getAll();
        g.onsuccess = () => r(g.result);
      });
      return all.find((s) => s.sources.some((x) => x.kind === 'stream'))?.id;
    });
    if (rid) {
      await page.evaluate((id) => window.__hostcaster.radio.start(id), rid);
      const live = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === 'stream', undefined, 20000);
      await page.evaluate(() => void window.__hostcaster.radio.talkNow('Say hello'));
      const talked = await until(page, () => window.__hostcaster.radio.state.phase === 'talking', undefined, 60000);
      const back = await until(page, () => window.__hostcaster.radio.state.phase === 'music' && window.__hostcaster.player.state.status === 'playing', undefined, 90000);
      check('radio: stream station on air with a host break', live && talked && back);
      await page.evaluate(() => window.__hostcaster.radio.stop());
    }
  }
  await page.getByLabel('Search stations').fill('');
  await page.getByRole('group', { name: 'Genres' }).getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('heading', { name: 'Saved' }).waitFor({ timeout: 10000 }).catch(() => undefined);
  check('radio: saved section', await page.getByRole('list', { name: 'Saved stations' }).getByRole('button', { name: /^Classic Vinyl HD/ }).isVisible());
  // saved stations come from the local snapshot: they still list with the directory unreachable
  await ctx.route('**/*.api.radio-browser.info/**', (r) => r.abort());
  await page.reload();
  await page.getByRole('heading', { name: 'Saved' }).waitFor({ timeout: 10000 }).catch(() => undefined);
  check('radio: saved stations list offline', await page.getByRole('list', { name: 'Saved stations' }).getByRole('button', { name: /^Classic Vinyl HD/ }).isVisible());
  await wait(300);
  await shot(page, 'radio-offline-desktop');
  await ctx.unrouteAll({ behavior: 'ignoreErrors' });
}

// ---- YouTube (server API mocked, real IFrame player) ------------------------------------------------------------
if (want('youtube')) {
  await page.goto(`${base}/#/settings/music-services`);
  const yt = page.locator('#svc-youtube');
  await yt.locator('.aw-svc-card__status').waitFor();
  await wait(800);
  const ytStatus = await yt.locator('.aw-svc-card__status').innerText();
  check('youtube: explains a server without Google sign-in', /not set up|Sign in/.test(ytStatus), ytStatus);

  // MOCK the server's YouTube routes (no Google account in tests)
  const vid = process.env.YT_VIDEO ?? 'jNQXAC9IVRw';
  await ctx.route('**/api/config', async (r) => {
    const res = await r.fetch();
    const j = await res.json();
    await r.fulfill({ json: { ...j, signIn: { ...j.signIn, google: true } } });
  });
  await ctx.route('**/api/google/status', (r) => r.fulfill({ json: { connected: true, email: 'listener@example.com', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] } }));
  await ctx.route('**/api/google/youtube/playlists', (r) =>
    r.fulfill({ json: { playlists: [{ id: 'LL', title: 'Liked videos', count: 1, liked: true }, { id: 'PLtest', title: 'Road trip', count: 1 }] } }),
  );
  await ctx.route('**/api/google/youtube/playlist/**', (r) =>
    r.fulfill({ json: { items: [{ videoId: vid, title: 'jawed - Me at the zoo', channel: 'jawed', thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, durationMs: 19000 }] } }),
  );
  await page.goto(`${base}/#/services/youtube`);
  await page.reload();
  const listed = await page.getByRole('button', { name: /^Road trip/ }).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check('youtube: playlists incl. Liked videos (MOCK server)', listed && (await page.getByRole('button', { name: /^Liked videos/ }).isVisible()));
  await shot(page, 'youtube-playlists-desktop');
  await page.getByRole('button', { name: /^Liked videos/ }).click();
  await page.getByRole('heading', { name: 'Liked videos' }).waitFor();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const ytPlaying = await until(page, () => window.__hostcaster?.player?.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 1500, undefined, 30000);
  const s = await pstate(page);
  check('youtube: real IFrame player plays the video', ytPlaying && s?.track?.source === 'youtube', `${s?.track?.title} @ ${s?.positionMs} ms / ${s?.durationMs}`);
  await page.goto(`${base}/#/now-playing`);
  await wait(1500);
  await shot(page, 'youtube-nowplaying-desktop');
  const overlay = await page.evaluate(() => {
    const h = document.querySelector('.aw-yt-host');
    const slot = document.querySelector('[data-testid=youtube-slot], .aw-np__art--video');
    if (!h) return 'no host';
    const r = h.getBoundingClientRect();
    const sr = slot?.getBoundingClientRect();
    const over = Boolean(sr && Math.abs(sr.left - r.left) < 2 && Math.abs(sr.width - r.width) < 2 && r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1);
    return JSON.stringify({ slot: Boolean(slot), opacity: getComputedStyle(h).opacity, over, w: Math.round(r.width), h: Math.round(r.height) });
  });
  check('youtube: video shows in Now Playing', /"slot":true,"opacity":"1","over":true/.test(overlay), overlay);
  await page.goto(`${base}/#/library`);
  await wait(600);
  const parked = await page.evaluate(() => getComputedStyle(document.querySelector('.aw-yt-host')).opacity);
  check('youtube: video hides when Now Playing closes', parked === '0', `opacity ${parked}`);
  await page.evaluate(() => window.__hostcaster.player.pause());

  // a YouTube station on air: the host talks over the IFrame player, which ducks (setVolume) and comes back
  await page.goto(`${base}/#/services/youtube`);
  await page.getByRole('button', { name: /^Liked videos/ }).click();
  await page.getByRole('button', { name: 'Make a station' }).click();
  await page.getByText('Station ready').first().waitFor({ timeout: 8000 }).catch(() => undefined);
  const ytStation = await page.evaluate(async () => {
    const req = indexedDB.open('hostcaster');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all = await new Promise((r) => {
      const g = db.transaction('stations').objectStore('stations').getAll();
      g.onsuccess = () => r(g.result);
    });
    return all.find((s) => s.sources.some((x) => x.kind === 'youtube-playlist'))?.id;
  });
  if (ytStation) {
    await page.evaluate((id) => window.__hostcaster.radio.start(id), ytStation);
    const onAir = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === 'youtube', undefined, 20000);
    const before = await page.evaluate(() => window.__hostcaster.services.youtube.playerVolume());
    await page.evaluate(() => void window.__hostcaster.radio.talkNow('Say hello'));
    const talked = await until(page, () => window.__hostcaster.radio.state.phase === 'talking', undefined, 60000);
    await wait(1200);
    const during = await page.evaluate(() => window.__hostcaster.services.youtube.playerVolume());
    const back = await until(page, () => window.__hostcaster.radio.state.phase === 'music', undefined, 90000);
    await wait(1500);
    const after = await page.evaluate(() => window.__hostcaster.services.youtube.playerVolume());
    check(
      'youtube: station on air, video ducks under the host and comes back',
      onAir && talked && back && before > 60 && during < 40 && after > 60,
      `volume ${before} -> ${during} -> ${after}`,
    );
    await page.evaluate(() => window.__hostcaster.radio.stop());
  } else check('youtube: station found', false);
  await ctx.unrouteAll({ behavior: 'ignoreErrors' });
}

// ---- Spotify (Spotify endpoints mocked with documented shapes) --------------------------------------------------
if (want('spotify')) {
  await page.goto(`${base}/#/settings/music-services`);
  const sp = page.locator('#svc-spotify');
  await sp.getByLabel('Client ID').fill('not-an-id');
  await sp.getByLabel('Client ID').blur();
  check('spotify: client id validated', await sp.getByText(/32 letters and numbers/).waitFor({ timeout: 4000 }).then(() => true, () => false));
  const redirect = await sp.locator('.aw-svc-copy code').innerText();
  check('spotify: shows the redirect URI to register', redirect === `${base}/spotify/callback`, redirect);
  await shot(page, 'spotify-setup-desktop');

  let authUrl;
  await ctx.route('https://accounts.spotify.com/authorize**', (r) => {
    authUrl = new URL(r.request().url());
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>MOCK Spotify login</p>' });
  });
  await sp.getByLabel('Client ID').fill('0123456789abcdef0123456789abcdef');
  await sp.getByLabel('Client ID').blur();
  await sp.getByRole('button', { name: 'Connect Spotify' }).click();
  await page.waitForURL(/accounts\.spotify\.com/, { timeout: 8000 }).catch(() => undefined);
  const q = authUrl?.searchParams;
  check(
    'spotify: PKCE authorize request',
    q?.get('client_id') === '0123456789abcdef0123456789abcdef' && q.get('code_challenge_method') === 'S256' && q.get('redirect_uri') === `${base}/spotify/callback` && (q.get('code_challenge') ?? '').length === 43,
    authUrl ? `${authUrl.origin}${authUrl.pathname}` : 'no request',
  );
  // MOCK token + Web API
  let tokenForm;
  await ctx.route('https://accounts.spotify.com/api/token', (r) => {
    tokenForm = new URLSearchParams(r.request().postData() ?? '');
    return r.fulfill({ json: { access_token: 'mock-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'mock-refresh', scope: 'streaming' }, headers: { 'access-control-allow-origin': '*' } });
  });
  // MOCK Spotify Web API + one Spotify Connect device that "plays" in simulated time (6 s tracks, then Spotify's
  // autoplay moves on to a song we did not ask for, which the adapter must read as the end of ours)
  const mkTrack = (id, name) => ({ id, uri: `spotify:track:${id}`, name, type: 'track', is_playable: true, duration_ms: 6000, artists: [{ name: 'Mock Artist' }], album: { name: 'Mock Album', images: [] } });
  const songs = [mkTrack('aaaaaaaaaaaaaaaaaaaaaa', 'First Light'), mkTrack('bbbbbbbbbbbbbbbbbbbbbb', 'Second Wind')];
  const dev = { item: undefined, playing: false, base: 0, at: 0, volumes: [], plays: [], pauses: 0 };
  const progress = () => (dev.playing ? dev.base + (Date.now() - dev.at) : dev.base);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS' };
  await ctx.route('https://api.spotify.com/v1/**', (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const m = req.method();
    const ok204 = () => r.fulfill({ status: 204, headers: cors, body: '' });
    if (m === 'OPTIONS') return ok204();
    const p = u.pathname;
    if (p === '/v1/me') return r.fulfill({ json: { id: 'listener', display_name: 'Test Listener', product: 'premium' }, headers: cors });
    if (p === '/v1/me/player/devices')
      return r.fulfill({ json: { devices: [{ id: 'dev1', name: 'Kitchen speaker', type: 'Speaker', is_active: true, volume_percent: 100, supports_volume: true }] }, headers: cors });
    if (p === '/v1/me/playlists')
      return r.fulfill({ json: { items: [{ id: 'pl1', name: 'Night Drive', images: [], owner: { display_name: 'Test Listener' }, items: { total: 2 } }], next: null }, headers: cors });
    if (p === '/v1/playlists/pl1/items') return r.fulfill({ json: { items: songs.map((t) => ({ item: t })), next: null, total: 2 }, headers: cors });
    if (p === '/v1/playlists/pl1') return r.fulfill({ json: { id: 'pl1', name: 'Night Drive', images: [], items: { total: 2 } }, headers: cors });
    if (p === '/v1/me/tracks') return r.fulfill({ json: { items: [], next: null, total: 0 }, headers: cors });
    if (p === '/v1/me/player/play' && m === 'PUT') {
      const body = req.postData() ? JSON.parse(req.postData()) : {};
      if (body.uris?.[0]) {
        dev.item = songs.find((t) => t.uri === body.uris[0]) ?? mkTrack('zzzzzzzzzzzzzzzzzzzzzz', 'Unknown');
        dev.base = body.position_ms ?? 0;
        dev.plays.push(dev.item.name);
      }
      dev.playing = true;
      dev.at = Date.now();
      return ok204();
    }
    if (p === '/v1/me/player/pause' && m === 'PUT') {
      dev.base = progress();
      dev.playing = false;
      dev.pauses++;
      return ok204();
    }
    if (p === '/v1/me/player/volume' && m === 'PUT') {
      dev.volumes.push(Number(u.searchParams.get('volume_percent')));
      return ok204();
    }
    if (p === '/v1/me/player/seek' || p === '/v1/me/player/repeat') return ok204();
    if (p === '/v1/me/player' && m === 'GET') {
      if (!dev.item) return ok204();
      // the song ran out: Spotify autoplay carries on with something else
      if (dev.playing && progress() >= dev.item.duration_ms) {
        dev.item = mkTrack('cccccccccccccccccccccc', 'Autoplay Song');
        dev.base = 0;
        dev.at = Date.now();
      }
      return r.fulfill({ json: { device: { id: 'dev1', name: 'Kitchen speaker', is_active: true, volume_percent: 100, supports_volume: true }, is_playing: dev.playing, progress_ms: Math.min(progress(), dev.item.duration_ms), item: dev.item, repeat_state: 'off', shuffle_state: false }, headers: cors });
    }
    return r.fulfill({ status: 404, json: { error: { status: 404, message: 'mock' } }, headers: cors });
  });
  await page.goto(`${base}/spotify/callback?code=mock-code&state=${encodeURIComponent(q?.get('state') ?? '')}`);
  const conn = await page.locator('#svc-spotify').getByText(/Connected as Test Listener/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check('spotify: web redirect -> code exchange (verifier, no secret) -> connected', conn && tokenForm?.get('code_verifier')?.length === 64 && !tokenForm.has('client_secret'), page.url());
  await wait(400);
  await shot(page, 'spotify-connected-desktop');
  await page.locator('#svc-spotify').getByLabel('Play Spotify on').selectOption('connect').catch(() => undefined);
  await page.locator('#svc-spotify').getByLabel('Device').waitFor({ timeout: 5000 }).catch(() => undefined);
  await wait(500);
  await page.locator('#svc-spotify').screenshot({ path: join(shots, 'services-spotify-card-connected-desktop.png') });
  check('spotify: Connect device list (MOCK)', /Kitchen speaker/.test(await page.locator('#svc-spotify').innerText().catch(() => '')) || (await page.locator('#svc-spotify select').last().innerText().catch(() => '')).includes('Kitchen speaker'));
  await page.locator('#svc-spotify').getByRole('button', { name: 'Browse Spotify' }).click();
  check('spotify: browse lists Liked Songs + playlists (MOCK)', await page.getByRole('button', { name: /^Night Drive/ }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await shot(page, 'spotify-browse-desktop');

  // playback through Spotify Connect (mode chosen above): plays on the device, notices the end, goes on
  await page.getByRole('button', { name: /^Night Drive/ }).click();
  await page.getByRole('heading', { name: 'Night Drive' }).waitFor({ timeout: 8000 }).catch(() => undefined);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const spPlaying = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === 'spotify', undefined, 15000);
  const second = await until(page, () => window.__hostcaster.player.state.track?.title === 'Second Wind' && window.__hostcaster.player.state.status === 'playing', undefined, 30000);
  check('spotify: Connect plays on the device, detects the end, plays the next (MOCK device)', spPlaying && second, `device played ${dev.plays.join(' -> ')}`);
  await shot(page, 'spotify-playing-desktop');
  await page.evaluate(() => window.__hostcaster.player.pause());
  await page.getByRole('button', { name: 'Make a station' }).click();
  await page.getByText('Station ready').first().waitFor({ timeout: 8000 }).catch(() => undefined);
  const spStation = await page.evaluate(async () => {
    const req = indexedDB.open('hostcaster');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all = await new Promise((r) => {
      const g = db.transaction('stations').objectStore('stations').getAll();
      g.onsuccess = () => r(g.result);
    });
    return all.find((s) => s.name === 'Night Drive' && s.sources.some((x) => x.kind === 'spotify-playlist' || x.kind === 'playlist'))?.id;
  });
  if (spStation) {
    dev.volumes.length = 0;
    await page.evaluate((id) => window.__hostcaster.radio.start(id), spStation);
    const on = await until(page, () => window.__hostcaster.player.state.status === 'playing' && window.__hostcaster.player.state.track?.source === 'spotify', undefined, 15000);
    await page.evaluate(() => void window.__hostcaster.radio.talkNow('Say hello'));
    const talked = await until(page, () => window.__hostcaster.radio.state.phase === 'talking', undefined, 60000);
    const back = await until(page, () => window.__hostcaster.radio.state.phase === 'music', undefined, 90000);
    // the unduck can straddle a song change (6 s songs here): the adapter re-sends it when the next song runs
    for (let i = 0; i < 40 && !(dev.volumes.at(-1) >= 80); i++) await wait(500);
    const v = dev.volumes;
    check('spotify: station on air, Connect device ducks under the host and comes back (MOCK device)', on && talked && back && Math.min(...v) < 40 && v.at(-1) >= 80, `volume steps ${v.join(', ')}`);
    await page.evaluate(() => window.__hostcaster.radio.stop());
  } else check('spotify: station found', false);
  await ctx.unrouteAll({ behavior: 'ignoreErrors' });
}
await ctx.close();

// ---------------------------------------------------------------------------------------------- phone
{
  const { ctx: pctx, page: p } = await newPage({ width: 390, height: 844 }, { deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await p.goto(`${base}/#/settings/music-services`);
  await p.getByRole('heading', { name: 'Your music server' }).waitFor();
  await wait(600);
  await p.screenshot({ path: join(shots, 'services-settings-phone.png') });
  await p.screenshot({ path: join(shots, 'services-settings-phone-full.png'), fullPage: true });
  const fitSettings = await fitsWidth(p);
  check('phone: Music services fits the screen', fitSettings === true, String(fitSettings));
  await p.goto(`${base}/#/services/radio`);
  await p.getByRole('list', { name: 'Stations' }).getByRole('listitem').first().waitFor({ timeout: 15000 }).catch(() => undefined);
  await wait(800);
  await p.screenshot({ path: join(shots, 'services-radio-phone.png') });
  const fitRadio = await fitsWidth(p);
  check('phone: radio list fits', fitRadio === true, String(fitRadio));

  if (want('subsonic')) {
    await p.goto(`${base}/#/settings/music-services`);
    const card = p.locator('#svc-subsonic');
    await card.getByLabel('Server address').fill(ssUrl);
    await card.getByLabel('Username').fill(ssUser);
    await card.getByLabel('Password').fill(ssPass);
    await card.getByRole('button', { name: 'Connect' }).click();
    await card.getByText('Connected', { exact: true }).waitFor({ timeout: 8000 }).catch(() => undefined);
    await card.getByRole('button', { name: 'Browse your server' }).click();
    await p.getByRole('tab', { name: 'Albums' }).click();
    await p.getByRole('button', { name: /^Night Drive/ }).waitFor({ timeout: 8000 }).catch(() => undefined);
    await wait(600);
    await p.screenshot({ path: join(shots, 'services-subsonic-albums-phone.png') });
    { const f = await fitsWidth(p); check('phone: subsonic albums fit', f === true, String(f)); }
    await p.getByRole('button', { name: /^Night Drive/ }).click();
    await p.getByRole('heading', { name: 'Night Drive' }).waitFor({ timeout: 8000 }).catch(() => undefined);
    await wait(600);
    await p.screenshot({ path: join(shots, 'services-subsonic-album-phone.png') });
    { const f = await fitsWidth(p); check('phone: subsonic album fits', f === true, String(f)); }
  }

  if (want('youtube')) {
    const vid = process.env.YT_VIDEO ?? 'jNQXAC9IVRw';
    await pctx.route('**/api/config', async (r) => {
      const res = await r.fetch();
      const j = await res.json();
      await r.fulfill({ json: { ...j, signIn: { ...j.signIn, google: true } } });
    });
    await pctx.route('**/api/google/status', (r) => r.fulfill({ json: { connected: true, email: 'listener@example.com', scopes: ['https://www.googleapis.com/auth/youtube.readonly'] } }));
    await pctx.route('**/api/google/youtube/playlists', (r) => r.fulfill({ json: { playlists: [{ id: 'PLtest', title: 'Road trip', count: 1 }] } }));
    await pctx.route('**/api/google/youtube/playlist/**', (r) =>
      r.fulfill({ json: { items: [{ videoId: vid, title: 'jawed - Me at the zoo', channel: 'jawed', thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, durationMs: 19000 }] } }),
    );
    await pctx.route('**/api/google/youtube/search**', (r) =>
      r.fulfill({ json: { items: [{ videoId: vid, title: 'jawed - Me at the zoo', channel: 'jawed', thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, durationMs: 19000 }] } }),
    );
    await p.goto(`${base}/#/services/youtube`);
    await p.reload();
    await p.getByRole('button', { name: /^Road trip/ }).waitFor({ timeout: 10000 }).catch(() => undefined);
    await wait(500);
    await p.screenshot({ path: join(shots, 'services-youtube-phone.png') });
    { const f = await fitsWidth(p); check('phone: youtube browse fits', f === true, String(f)); }
    await p.getByLabel('Search YouTube').fill('me at the zoo');
    await p.getByLabel('Search YouTube').press('Enter');
    const hit = await p.getByRole('region', { name: 'Search results' }).getByRole('button', { name: /Me at the zoo/ }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    await wait(400);
    await p.screenshot({ path: join(shots, 'services-youtube-search-phone.png') });
    check('phone: youtube search (MOCK server)', hit);
    await p.getByLabel('Search YouTube').fill('');
    await p.getByRole('button', { name: /^Road trip/ }).click();
    await p.getByRole('button', { name: 'Play', exact: true }).click();
    const ok = await until(p, () => window.__hostcaster?.player?.state.status === 'playing' && window.__hostcaster.player.state.positionMs > 1000, undefined, 30000);
    await p.getByRole('button', { name: 'Open Now Playing' }).click().catch(() => p.goto(`${base}/#/now-playing`));
    await wait(1500);
    await p.screenshot({ path: join(shots, 'services-youtube-nowplaying-phone.png') });
    const over = await p.evaluate(() => {
      const h = document.querySelector('.aw-yt-host');
      const slot = document.querySelector('[data-testid=youtube-slot], .aw-np__art--video');
      if (!h || !slot) return false;
      const r = h.getBoundingClientRect();
      const sr = slot.getBoundingClientRect();
      return getComputedStyle(h).opacity === '1' && Math.abs(sr.left - r.left) < 2 && Math.abs(sr.width - r.width) < 2 && r.width > 200;
    });
    check('phone: YouTube video over Now Playing art', ok && over);
    await p.evaluate(() => window.__hostcaster.player.pause());
    await pctx.unrouteAll({ behavior: 'ignoreErrors' });
  }

  if (want('spotify')) {
    await p.goto(`${base}/#/settings/music-services`);
    await p.locator('#svc-spotify').scrollIntoViewIfNeeded();
    await wait(400);
    await p.locator('#svc-spotify').screenshot({ path: join(shots, 'services-spotify-setup-phone.png') });
    { const f = await fitsWidth(p); check('phone: spotify setup fits', f === true, String(f)); }
  }
  await pctx.close();
}

await browser.close();
console.log('\n' + results.join('\n'));
if (errors.length) console.log('\nconsole/page errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
