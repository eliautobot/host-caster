import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoDurationMs, displayName } from '../src/integrations/google.js';
import { BIG, startFakeProviders } from './fake-providers.js';
import { cookieOf, localUser, makeApp, oauth } from './helpers.js';

const S = (s) => `https://www.googleapis.com/auth/${s}.readonly`;

async function googleUser(t, scopes, { expiresIn } = {}) {
  const fake = await startFakeProviders(t);
  if (expiresIn !== undefined) fake.state.googleExpiresIn = expiresIn;
  const { app } = await makeApp(t, fake.env);
  const { cb } = await oauth(app, 'google', { code: `gina|openid ${scopes.map(S).join(' ')}|1` });
  const cookie = cookieOf(cb);
  const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } });
  return { app, fake, get };
}

test('helpers: ISO durations and sender names', () => {
  assert.equal(isoDurationMs('PT3M25S'), 205000);
  assert.equal(isoDurationMs('PT1H'), 3600000);
  assert.equal(isoDurationMs('P1DT1S'), 86401000);
  assert.equal(isoDurationMs('bogus'), 0);
  assert.equal(displayName('"Jane Doe" <jane@x.com>'), 'Jane Doe');
  assert.equal(displayName('<a@b.c>'), 'a@b.c');
  assert.equal(displayName('a@b.c'), 'a@b.c');
});

test('calendar: every visible calendar, cancelled/declined dropped, sorted', async (t) => {
  const { get } = await googleUser(t, ['calendar']);
  const res = await get('/api/google/calendar?hours=48');
  assert.equal(res.statusCode, 200, res.body);
  const { events, calendars } = res.json();
  assert.equal(calendars, 2);
  assert.deepEqual(events.map((e) => e.title), ['Dentist', 'Birthday']);
  const [dentist, bday] = events;
  assert.equal(dentist.allDay, false);
  assert.equal(dentist.location, 'Main St');
  assert.equal(dentist.source, 'google');
  assert.equal(dentist.calendar, 'Me');
  assert.equal(bday.allDay, true);
  assert.match(bday.startDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('gmail: unread, important first then newest, promotions last', async (t) => {
  const { get } = await googleUser(t, ['gmail']);
  const res = await get('/api/google/gmail?max=5');
  assert.equal(res.statusCode, 200, res.body);
  const { messages, unread } = res.json();
  assert.equal(unread, 3);
  assert.deepEqual(messages.map((m) => m.id), ['m2', 'm3', 'm1']);
  assert.deepEqual(Object.keys(messages[0]).sort(), ['at', 'from', 'id', 'important', 'snippet', 'subject']);
  assert.equal(messages[0].from, 'Sender m2');
  assert.equal(messages[0].important, true);
  assert.equal(messages[0].snippet, 'Snippet & m2');
});

test('youtube: playlists incl. liked, items with durations and embeddable, search', async (t) => {
  const { get } = await googleUser(t, ['youtube']);
  const pl = (await get('/api/google/youtube/playlists')).json().playlists;
  assert.deepEqual(pl.map((p) => [p.id, p.count]), [['LL', 42], ['PL1', 2]]);
  assert.equal(pl[1].thumbnail, 'https://i.test/1.jpg');
  const items = (await get('/api/google/youtube/playlist/LL')).json().items;
  assert.deepEqual(items, [
    { videoId: 'vidA', title: 'Song A', channel: 'Artist A', thumbnail: 'https://i.test/a.jpg', durationMs: 205000 },
    // embedding off: listed, flagged so the app leaves it out of stations
    { videoId: 'vidB', title: 'Song B', channel: 'Label B', durationMs: 205000, embeddable: false },
  ]);
  const found = (await get('/api/google/youtube/search?q=hello')).json().items;
  assert.equal(found[0].title, 'Found & played');
  assert.equal(found[0].durationMs, 205000);
  assert.equal((await get('/api/google/youtube/search')).statusCode, 400);
  assert.equal((await get('/api/google/youtube/playlist/..%2Fx')).statusCode, 400);
});

test('youtube: a long playlist in pages, with what was left out and why', async (t) => {
  const { get, fake } = await googleUser(t, ['youtube']);
  const first = (await get('/api/google/youtube/playlist/PLBIG?paged=1&limit=100')).json();
  assert.equal(first.total, 280);
  assert.equal(first.next, 'p100');
  const all = [...first.items];
  const left = { ...first.left };
  let blocked = first.blocked;
  let next = first.next;
  let calls = 1;
  while (next) {
    const page = (await get(`/api/google/youtube/playlist/PLBIG?paged=1&limit=100&pageToken=${next}`)).json();
    all.push(...page.items);
    for (const k of Object.keys(left)) left[k] += page.left[k];
    blocked += page.blocked;
    next = page.next;
    calls++;
  }
  assert.equal(calls, 3);
  assert.equal(all.length, 264, 'every video is there, none cut at a page edge');
  assert.equal(new Set(all.map((v) => v.videoId)).size, 264);
  assert.deepEqual(left, { private: 7, deleted: 6, unavailable: 3 });
  assert.equal(blocked, 2);
  assert.equal(all.filter((v) => v.embeddable === false).length, 2);
  assert.equal(all[0].title, 'Artist 0 - Big Song 0');
  // quota: one playlistItems call and one videos call per 50
  const yt = fake.log.filter((l) => l.path.startsWith('/gapi/youtube/v3/'));
  assert.equal(yt.filter((l) => l.path.endsWith('/playlistItems')).length, 6);
  assert.equal(yt.filter((l) => l.path.endsWith('/videos')).length, 6);
  // older apps (no paged flag) still get the first `limit` videos and the same item shape
  const old = (await get('/api/google/youtube/playlist/PLBIG?limit=200')).json();
  assert.equal(old.items.length, BIG.slice(0, 200).filter((v) => v.kind === 'ok' || v.kind === 'blocked').length);
  assert.equal(old.next, undefined);
  assert.equal((await get('/api/google/youtube/playlist/PLBIG?paged=1&pageToken=bad%20token')).statusCode, 400);
});

test('no Google identity -> *_not_connected; status reports scopes', async (t) => {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, { ...fake.env, ALLOW_LOCAL_ACCOUNTS: 'true' });
  const { call } = await localUser(app);
  assert.equal((await call('GET', '/api/google/youtube/playlists')).json().error.code, 'youtube_not_connected');
  assert.equal((await call('GET', '/api/google/calendar')).json().error.code, 'google_not_connected');
  assert.deepEqual((await call('GET', '/api/google/status')).json(), { connected: false, scopes: [] });
  const { get } = await googleUser(t, ['calendar']);
  const yt = await get('/api/google/youtube/playlists');
  assert.equal(yt.statusCode, 403);
  assert.equal(yt.json().error.code, 'scope_missing');
  const status = (await get('/api/google/status')).json();
  assert.deepEqual(status, { connected: true, email: 'gina@gmail.test', scopes: ['calendar', 'https://www.googleapis.com/auth/calendar.readonly'] });
});

test('expired access tokens are refreshed with the stored refresh token', async (t) => {
  const { get, fake } = await googleUser(t, ['calendar'], { expiresIn: 0 });
  const res = await get('/api/google/calendar');
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(fake.state.refreshed >= 1);
});

// ---- IMAP (fake imapflow client) ----------------------------------------------------------------------------------

function fakeImap(calls, { failAuth = false } = {}) {
  return (opts) => {
    calls.push(opts);
    return {
      on() {},
      async connect() {
        if (failAuth) {
          const e = new Error('Authentication failed');
          e.authenticationFailed = true;
          throw e;
        }
      },
      async getMailboxLock() {
        return { release() {} };
      },
      async search() {
        return [11, 12, 13];
      },
      async *fetch() {
        yield { uid: 12, envelope: { from: [{ name: 'Boss', address: 'boss@w.test' }], subject: 'Report' }, flags: new Set(['\\Flagged']), internalDate: new Date(1000) };
        yield { uid: 13, envelope: { from: [{ address: 'news@w.test' }], subject: 'News' }, flags: new Set(), internalDate: new Date(2000) };
      },
      async logout() {},
    };
  };
}

test('IMAP: test, save sealed creds (pinned to the validated address), summary, delete', async (t) => {
  const calls = [];
  const resolver = async (h) => (h === 'imap.mail.test' ? ['93.184.216.34'] : ['10.0.0.1']);
  const { app } = await makeApp(t, {}, { imapFactory: fakeImap(calls), resolver });
  const { call } = await localUser(app);
  const creds = { host: 'imap.mail.test', port: 993, secure: true, user: 'me', password: 'app-pass' };
  assert.equal((await call('POST', '/api/imap/test', creds)).json().unread, 3);
  assert.equal(calls[0].host, '93.184.216.34');
  assert.equal(calls[0].servername, 'imap.mail.test');
  const saved = (await call('PUT', '/api/imap', creds)).json();
  assert.equal(saved.password, undefined);
  assert.equal((await call('GET', '/api/imap')).json().user, 'me');
  assert.doesNotMatch(app.db.prepare("SELECT value_enc FROM secrets WHERE ref = 'imap'").get().value_enc, /app-pass/);
  assert.equal((await call('GET', '/api/secrets/imap')).statusCode, 404, 'the password is never revealed');
  const sum = (await call('GET', '/api/imap/summary?max=5')).json();
  assert.equal(sum.unread, 3);
  assert.deepEqual(sum.messages.map((m) => [m.from, m.subject, m.important]), [['Boss', 'Report', true], ['news@w.test', 'News', false]]);
  const priv = await call('POST', '/api/imap/test', { ...creds, host: 'intranet.test' });
  assert.equal(priv.json().error.code, 'blocked_address');
  assert.equal((await call('DELETE', '/api/imap')).statusCode, 204);
  assert.equal((await call('GET', '/api/imap/summary')).json().error.code, 'imap_not_configured');
});

test('IMAP: wrong password is a clear error', async (t) => {
  const { app } = await makeApp(t, {}, { imapFactory: fakeImap([], { failAuth: true }), resolver: async () => ['93.184.216.34'] });
  const { call } = await localUser(app);
  const res = await call('POST', '/api/imap/test', { host: 'imap.mail.test', user: 'me', password: 'x' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'imap_auth_failed');
});
