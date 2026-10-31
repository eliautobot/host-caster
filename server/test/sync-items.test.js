import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOMBSTONE_TTL } from '../src/routes/syncItems.js';
import { localUser, makeApp } from './helpers.js';

const track = (ref, extra = {}) => ({
  kind: 'track',
  id: `youtube:${ref}`,
  updatedAt: 1000,
  data: { source: 'youtube', ref, title: `Song ${ref}`, artist: 'Band', album: '', durationMs: 1000, addedAt: 1 },
  ...extra,
});

test('sync items: signed out 401, empty pull, push and incremental pull, own echo skipped', async (t) => {
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  assert.equal((await app.inject({ method: 'GET', url: '/api/sync/items' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/sync/items', headers: { 'x-hostcaster': '1' }, payload: { items: [] } })).statusCode, 401);

  const empty = (await call('GET', '/api/sync/items')).json();
  assert.deepEqual(empty, { items: [], cursor: 0, more: false });

  const push = (await call('POST', '/api/sync/items', { items: [track('a'), track('b')] })).json();
  assert.equal(push.before, 0);
  assert.equal(push.cursor, 2);
  assert.equal(push.accepted, 2);
  assert.deepEqual(push.stale, []);

  const all = (await call('GET', '/api/sync/items?since=0')).json();
  assert.deepEqual(all.items.map((i) => i.id), ['youtube:a', 'youtube:b']);
  assert.equal(all.items[0].data.title, 'Song a');
  assert.equal(all.cursor, 2);
  assert.deepEqual((await call('GET', '/api/sync/items?since=2')).json(), { items: [], cursor: 2, more: false });

  // the same record again changes nothing (no new seq for other devices to pull)
  const again = (await call('POST', '/api/sync/items', { items: [track('a')] })).json();
  assert.equal(again.cursor, 2);
  assert.equal(again.accepted, 1);
});

test('sync items: newer edit wins for tracks, stale answers carry the server version, ties keep the first', async (t) => {
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  await call('POST', '/api/sync/items', { items: [track('a', { updatedAt: 2000 })] });
  const older = (await call('POST', '/api/sync/items', { items: [track('a', { updatedAt: 1500, data: { ...track('a').data, title: 'Old' } })] })).json();
  assert.equal(older.accepted, 0);
  assert.equal(older.stale.length, 1);
  assert.equal(older.stale[0].data.title, 'Song a');
  assert.equal(older.stale[0].updatedAt, 2000);
  const tie = (await call('POST', '/api/sync/items', { items: [track('a', { updatedAt: 2000, data: { ...track('a').data, title: 'Tie' } })] })).json();
  assert.equal(tie.stale.length, 1, 'same time, other content: the server keeps its version');
  const newer = (await call('POST', '/api/sync/items', { items: [track('a', { updatedAt: 2500, data: { ...track('a').data, liked: true } })] })).json();
  assert.equal(newer.accepted, 1);
  const got = (await call('GET', '/api/sync/items?since=1')).json().items;
  assert.equal(got.length, 1);
  assert.equal(got[0].data.liked, true);

  // a clock far ahead is held to now + 5 min, so it cannot win every later edit
  const future = Date.now() + 10 * 365 * 86400e3;
  await call('POST', '/api/sync/items', { items: [track('f', { updatedAt: future })] });
  const stored = app.db.prepare("SELECT updated_at FROM sync_items WHERE id = 'youtube:f'").get().updated_at;
  assert.ok(stored < Date.now() + 6 * 60_000);
});

test('sync items: playlist lists are compare-and-set on base', async (t) => {
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  const members = (keys, updatedAt, base) => ({ kind: 'members', id: 'pl1', updatedAt, base, data: { keys } });
  assert.equal((await call('POST', '/api/sync/items', { items: [members(['youtube:a'], 100, 0)] })).json().accepted, 1);
  // a device that did not see version 100 edited from nothing: refused, gets the server list back
  const lost = (await call('POST', '/api/sync/items', { items: [members(['youtube:b'], 200, 0)] })).json();
  assert.equal(lost.accepted, 0);
  assert.deepEqual(lost.stale[0].data.keys, ['youtube:a']);
  // merged on the device, pushed against what it saw
  const ok = (await call('POST', '/api/sync/items', { items: [members(['youtube:a', 'youtube:b'], 201, 100)] })).json();
  assert.equal(ok.accepted, 1);
  const got = (await call('GET', '/api/sync/items')).json().items.find((i) => i.kind === 'members');
  assert.deepEqual(got.data.keys, ['youtube:a', 'youtube:b']);
  assert.equal(got.updatedAt, 201);
});

test('sync items: deletions travel as tombstones and free a place under the limit', async (t) => {
  const { app } = await makeApp(t, { SYNC_MAX_ITEMS: '100' });
  const { call } = await localUser(app);
  const many = Array.from({ length: 120 }, (_, i) => track(`v${i}`));
  const res = (await call('POST', '/api/sync/items', { items: many })).json();
  assert.equal(res.accepted, 100);
  assert.equal(res.full, 20);
  assert.deepEqual(res.refused[0], { kind: 'track', id: 'youtube:v100' });
  assert.equal(res.max, 100);
  const del = (await call('POST', '/api/sync/items', { items: [{ kind: 'track', id: 'youtube:v0', updatedAt: 5000, deleted: true }] })).json();
  assert.equal(del.accepted, 1);
  const pulled = (await call('GET', `/api/sync/items?since=${res.cursor}`)).json().items;
  assert.deepEqual(pulled, [{ kind: 'track', id: 'youtube:v0', updatedAt: 5000, deleted: true }]);
  // an older edit cannot bring it back; a newer one can (and takes the free place)
  assert.equal((await call('POST', '/api/sync/items', { items: [track('v0', { updatedAt: 4000 })] })).json().stale.length, 1);
  assert.equal((await call('POST', '/api/sync/items', { items: [track('v100', { updatedAt: 6000 })] })).json().accepted, 1);
  assert.equal((await call('POST', '/api/sync/items', { items: [track('v101', { updatedAt: 6000 })] })).json().full, 1);
});

test('sync items: paged pulls in seq order', async (t) => {
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  for (let b = 0; b < 3; b++) {
    const batch = Array.from({ length: 400 }, (_, i) => track(`p${b * 400 + i}`));
    assert.equal((await call('POST', '/api/sync/items', { items: batch })).json().accepted, 400);
  }
  const seen = [];
  let since = 0;
  let pages = 0;
  for (;;) {
    const page = (await call('GET', `/api/sync/items?since=${since}&limit=500`)).json();
    seen.push(...page.items.map((i) => i.id));
    since = page.cursor;
    pages++;
    if (!page.more) break;
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200);
  assert.equal(seen[0], 'youtube:p0');
  assert.equal(seen.at(-1), 'youtube:p1199');
});

test('sync items: an old app that only PUTs the doc never touches synced songs', async (t) => {
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  await call('POST', '/api/sync/items', { items: [track('a'), { kind: 'members', id: 'pl1', updatedAt: 10, data: { keys: ['youtube:a'] } }] });
  // old doc shape: playlists without trackIds, no tracks at all
  const oldDoc = { hosts: [], stations: [], brains: [], voices: [], playlists: [{ id: 'pl1', name: 'Liked videos (YouTube)', source: 'youtube', updatedAt: 99 }] };
  assert.equal((await call('PUT', '/api/sync', { rev: 0, doc: oldDoc })).statusCode, 200);
  assert.equal((await call('PUT', '/api/sync', { rev: 1, doc: { ...oldDoc, playlists: [] } })).statusCode, 200);
  const items = (await call('GET', '/api/sync/items')).json().items;
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ['track:youtube:a', 'members:pl1']);
});

test('sync items: validation, size limits, per-user isolation, deleted with the account', async (t) => {
  const { app } = await makeApp(t);
  const a = await localUser(app, 'a@example.com');
  const b = await localUser(app, 'b@example.com');
  const bad = async (items, status = 400) => assert.equal((await a.call('POST', '/api/sync/items', { items })).statusCode, status);
  await bad([{ ...track('x'), kind: 'blob' }]);
  await bad([{ ...track('x'), id: '' }]);
  await bad([{ ...track('x'), updatedAt: 'soon' }]);
  await bad([{ kind: 'track', id: 'x', updatedAt: 1 }]);
  await bad(Array.from({ length: 501 }, (_, i) => track(`n${i}`)));
  await bad([{ ...track('x'), data: { ...track('x').data, title: 'x'.repeat(20000) } }], 413);
  assert.equal((await a.call('POST', '/api/sync/items', { nope: 1 })).statusCode, 400);

  await a.call('POST', '/api/sync/items', { items: [track('mine')] });
  assert.deepEqual((await b.call('GET', '/api/sync/items')).json().items, []);
  assert.equal((await a.call('DELETE', '/api/me')).statusCode, 204);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sync_items').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sync_item_meta').get().n, 0);
});

test('sync items: old tombstones are dropped once a day; a cursor from before them starts over', async (t) => {
  const { app } = await makeApp(t);
  const { call, user } = await localUser(app);
  const old = Date.now() - TOMBSTONE_TTL - 86400e3;
  await call('POST', '/api/sync/items', { items: [track('keep')] });
  await call('POST', '/api/sync/items', { items: [{ kind: 'track', id: 'youtube:gone', updatedAt: old, deleted: true }] });
  // a device synced up to here
  const cursor = (await call('GET', '/api/sync/items')).json().cursor;
  assert.equal(cursor, 2);
  const early = 1; // a device that only saw the first record
  app.db.prepare('UPDATE sync_item_meta SET pruned_at = 0 WHERE user_id = ?').run(user.id);
  await call('POST', '/api/sync/items', { items: [track('new')] });
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM sync_items WHERE id = 'youtube:gone'").get().n, 0);
  const restart = (await call('GET', `/api/sync/items?since=${early}`)).json();
  assert.equal(restart.reset, true);
  assert.deepEqual(restart.items.map((i) => i.id), ['youtube:keep', 'youtube:new']);
  const fine = (await call('GET', `/api/sync/items?since=${cursor}`)).json();
  assert.equal(fine.reset, undefined);
  assert.deepEqual(fine.items.map((i) => i.id), ['youtube:new']);
  // a cursor this server never handed out (restored backup, other server) starts over too
  assert.equal((await call('GET', '/api/sync/items?since=999')).json().reset, true);
});

test('sync items: migration 6 on a live database (accounts and docs from before) changes no doc', async (t) => {
  const { migrate } = await import('../src/db.js');
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  const doc = { hosts: [], stations: [{ id: 'st1', name: 'My YouTube', updatedAt: 5 }], brains: [], voices: [], playlists: [{ id: 'pl1', name: 'Liked videos (YouTube)', source: 'youtube', updatedAt: 5 }] };
  await call('PUT', '/api/sync', { rev: 0, doc });
  // the database as the live server has it today: migrations 1-5, no song tables
  app.db.exec('DROP TABLE sync_items; DROP TABLE sync_item_meta; DELETE FROM migrations WHERE id = 6');
  const before = (await call('GET', '/api/sync')).json();
  assert.deepEqual(migrate(app.db), [6]);
  assert.deepEqual(migrate(app.db), [], 'applied once');
  assert.deepEqual((await call('GET', '/api/sync')).json(), before, 'the doc and its rev are untouched');
  assert.deepEqual((await call('GET', '/api/sync/items')).json(), { items: [], cursor: 0, more: false });
  // the first new app to sync uploads its songs
  assert.equal((await call('POST', '/api/sync/items', { items: [track('a'), { kind: 'members', id: 'pl1', updatedAt: 9, base: 0, data: { keys: ['youtube:a'] } }] })).json().accepted, 2);
});
