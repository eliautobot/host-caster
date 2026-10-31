// Songs, playlist lists and unplayable marks across two devices of one account, against an in-memory server with the
// same rules as server/src/routes/syncItems.js. A "device" is a snapshot of the whole IndexedDB, swapped in and out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDb } from '../db';
import { markUnplayable, resetUnplayableCache, unplayableIds } from '../player/unplayable';
import type { Playlist, SyncDoc, Track } from '../types';
import { api } from './client';
import type { SyncItem } from './itemMerge';
import { sync } from './sync';
import { resetItemSyncSession } from './syncItems';

interface Row {
  kind: string;
  id: string;
  json: string | null;
  at: number;
  seq: number;
}

interface FakeServer {
  rev: number;
  doc: SyncDoc | null;
  rows: Map<string, Row>;
  seq: number;
  gets: number;
  posts: number;
  noItems: boolean;
}

function installServer(): FakeServer {
  const s: FakeServer = { rev: 0, doc: null, rows: new Map(), seq: 0, gets: 0, posts: 0, noItems: false };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, 'http://x');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/sync' && method === 'GET') return json(200, { rev: s.rev, doc: s.doc });
    if (u.pathname === '/api/sync' && method === 'PUT') {
      if (body.rev !== s.rev) return json(409, { error: { code: 'conflict', message: 'stale' }, rev: s.rev });
      s.rev++;
      s.doc = body.doc;
      return json(200, { rev: s.rev });
    }
    if (u.pathname === '/api/sync/items' && s.noItems) return json(404, { error: { code: 'not_found', message: 'no' } });
    const toItem = (r: Row) => ({ kind: r.kind, id: r.id, updatedAt: r.at, ...(r.json === null ? { deleted: true } : { data: JSON.parse(r.json) }) });
    if (u.pathname === '/api/sync/items' && method === 'GET') {
      s.gets++;
      const since = Number(u.searchParams.get('since') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 1000);
      const rows = [...s.rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      const page = rows.slice(0, limit);
      const more = rows.length > limit;
      return json(200, { items: page.map(toItem), cursor: more ? page.at(-1)!.seq : Math.max(since, s.seq), more });
    }
    if (u.pathname === '/api/sync/items' && method === 'POST') {
      s.posts++;
      const before = s.seq;
      const stale: unknown[] = [];
      for (const it of body.items as SyncItem[]) {
        const k = `${it.kind}\u0000${it.id}`;
        const cur = s.rows.get(k);
        const j = it.deleted ? null : JSON.stringify(it.data);
        if (cur && cur.json === j && (cur.at === it.updatedAt || j === null)) continue;
        const wins = !cur || (it.base !== undefined ? cur.at === it.base : it.updatedAt > cur.at);
        if (!wins) {
          stale.push(toItem(cur!));
          continue;
        }
        s.rows.set(k, { kind: it.kind, id: it.id, json: j, at: it.updatedAt, seq: ++s.seq });
      }
      return json(200, { before, cursor: s.seq, accepted: body.items.length - stale.length, stale });
    }
    if (/^\/api\/secrets\//.test(u.pathname)) return json(200, {});
    return json(404, { error: { code: 'not_found', message: u.pathname } });
  });
  return s;
}

const signIn = () => {
  api.available = true;
  api.configure({ baseUrl: '', session: { user: { id: 'u1', name: 'Sam', providers: ['google'] }, kind: 'web' } });
};

type Snapshot = Record<string, unknown[]>;
async function snapshot(): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const t of db.tables) out[t.name] = await t.toArray();
  return out;
}
async function restore(snap: Snapshot): Promise<void> {
  await sync.stop(true);
  for (const t of db.tables) {
    await t.clear();
    await t.bulkPut(snap[t.name] ?? []);
  }
  resetUnplayableCache();
}
async function freshDevice(): Promise<void> {
  await sync.stop(true);
  db.close();
  await db.delete();
  await initDb();
  resetUnplayableCache();
}

let n = 0;
const yt = (ref: string, extra: Partial<Track> = {}): Track => {
  const now = Date.now() + n++;
  return { id: `t-${ref}-${n}`, title: `Song ${ref}`, artist: 'Band', album: '', durationMs: 200000, source: 'youtube', ref, playCount: 0, addedAt: now, createdAt: now, updatedAt: now, ...extra };
};

async function playlist(id: string, trackIds: string[]): Promise<Playlist> {
  const now = Date.now();
  const p: Playlist = { id, name: id, trackIds, source: 'youtube', createdAt: now, updatedAt: now };
  await db.playlists.put(p);
  return p;
}

const tracksByRef = async () => new Map((await db.tracks.toArray()).map((t) => [t.ref, t]));

describe('item sync: songs, playlist lists, unplayable marks', () => {
  let server: FakeServer;
  beforeEach(async () => {
    await freshDevice();
    resetItemSyncSession();
    server = installServer();
    signIn();
  });
  afterEach(async () => {
    await sync.stop();
    vi.unstubAllGlobals();
  });

  it('device B gets device A songs, the playlist in order, a file counted as elsewhere, and the marks', async () => {
    // device A: three videos, one uploaded file, a playlist with all four, one video marked unplayable
    const [a, b, c] = [yt('vidAAAAAAAA', { liked: true }), yt('vidBBBBBBBB'), yt('vidCCCCCCCC')];
    const file: Track = { ...yt('blob-1'), id: 'file-1', source: 'local', title: 'My demo' };
    await db.tracks.bulkPut([a, b, c, file]);
    await playlist('pl-1', [a.id, file.id, b.id, c.id]);
    await markUnplayable([c], 'The owner of this video does not allow playback outside YouTube.', 101);
    await sync.syncNow();
    expect(sync.state.status).toBe('idle');
    const kinds = [...server.rows.values()].map((r) => `${r.kind}:${r.id}`).sort();
    expect(kinds).toEqual(['members:pl-1', 'track:youtube:vidAAAAAAAA', 'track:youtube:vidBBBBBBBB', 'track:youtube:vidCCCCCCCC', 'unplayable:youtube:vidCCCCCCCC']);
    expect(JSON.parse(server.rows.get('members\u0000pl-1')!.json!).keys).toEqual(['youtube:vidAAAAAAAA', '#file-1', 'youtube:vidBBBBBBBB', 'youtube:vidCCCCCCCC']);
    expect(server.doc!.playlists.find((p) => p.id === 'pl-1')).toBeTruthy();
    const deviceA = await snapshot();

    // nothing changed: the next round sends nothing
    const posts = server.posts;
    await sync.syncNow();
    expect(server.posts).toBe(posts);

    // device B: a new browser that already had one of the videos (its own id for it) signs in
    await freshDevice();
    await db.tracks.put(yt('vidCCCCCCCC', { id: 'b-own-c', playCount: 3 }));
    await sync.syncNow();
    const refs = await tracksByRef();
    expect([...refs.keys()].sort()).toEqual(['vidAAAAAAAA', 'vidBBBBBBBB', 'vidCCCCCCCC']);
    expect(refs.get('vidAAAAAAAA')!.liked).toBe(true);
    // a new song takes A's id (free here); the one B had keeps B's id and play count
    expect(refs.get('vidAAAAAAAA')!.id).toBe(a.id);
    expect(refs.get('vidCCCCCCCC')).toMatchObject({ id: 'b-own-c', playCount: 3 });
    expect(refs.get('vidAAAAAAAA')!.artworkId).toBe('https://i.ytimg.com/vi/vidAAAAAAAA/mqdefault.jpg');
    const pl = (await db.playlists.get('pl-1'))!;
    expect(pl.trackIds).toEqual([refs.get('vidAAAAAAAA')!.id, 'file-1', refs.get('vidBBBBBBBB')!.id, refs.get('vidCCCCCCCC')!.id]);
    expect(await db.tracks.get('file-1')).toBeUndefined();
    expect((await unplayableIds()).has(refs.get('vidCCCCCCCC')!.id)).toBe(true);
    // B pushed nothing back that A already had
    expect([...server.rows.values()].filter((r) => r.seq > 5)).toEqual([]);

    // B deletes a song and finds another one unplayable; A gets both
    const { deleteTracks } = await import('../library/tracks');
    await deleteTracks([refs.get('vidBBBBBBBB')!.id]);
    await markUnplayable([refs.get('vidAAAAAAAA')!], 'This YouTube video was removed or is private.', 100);
    await sync.syncNow();
    const deviceB = await snapshot();

    await restore(deviceA);
    await sync.syncNow();
    const onA = await tracksByRef();
    expect(onA.has('vidBBBBBBBB')).toBe(false);
    expect((await db.playlists.get('pl-1'))!.trackIds).toEqual([a.id, 'file-1', c.id]);
    expect((await unplayableIds()).has(a.id)).toBe(true);
    expect(await db.tracks.get('file-1')).toBeTruthy();

    // the file never became playable on B
    await restore(deviceB);
    expect(await db.tracks.get('file-1')).toBeUndefined();
  });

  it('both devices edit the same playlist: the edits merge', async () => {
    const [a, b, c] = [yt('vidAAAAAAAA'), yt('vidBBBBBBBB'), yt('vidCCCCCCCC')];
    await db.tracks.bulkPut([a, b, c]);
    await playlist('pl-1', [a.id, b.id]);
    await sync.syncNow();
    const deviceA = await snapshot();

    await freshDevice();
    await sync.syncNow();
    // B removes the first song
    const pl = (await db.playlists.get('pl-1'))!;
    await db.playlists.put({ ...pl, trackIds: pl.trackIds.slice(1), updatedAt: Date.now() });
    await sync.syncNow();

    // A, offline meanwhile, adds a song, then syncs
    await restore(deviceA);
    const plA = (await db.playlists.get('pl-1'))!;
    await db.playlists.put({ ...plA, trackIds: [...plA.trackIds, c.id], updatedAt: Date.now() });
    await sync.syncNow();
    expect((await db.playlists.get('pl-1'))!.trackIds).toEqual([b.id, c.id]);
    expect(JSON.parse(server.rows.get('members\u0000pl-1')!.json!).keys).toEqual(['youtube:vidBBBBBBBB', 'youtube:vidCCCCCCCC']);
  });

  it('a big library goes in pages and batches, and only changes go up later', async () => {
    const many = Array.from({ length: 2300 }, (_, i) => yt(`v${String(i).padStart(10, '0')}`));
    await db.tracks.bulkPut(many);
    await playlist('liked', many.map((t) => t.id));
    await sync.syncNow();
    expect(server.posts).toBe(5); // 2301 records in batches of 500
    expect(server.rows.size).toBe(2301);

    await freshDevice();
    const gets = server.gets;
    await sync.syncNow();
    expect(server.gets - gets).toBe(3); // 1000 + 1000 + 301
    expect(await db.tracks.count()).toBe(2300);
    expect((await db.playlists.get('liked'))!.trackIds.length).toBe(2300);
    const posts = server.posts;
    // one like here: one record up
    const one = (await db.tracks.toArray())[7]!;
    // (the fixture spaces updatedAt 1 ms per song into the future: edit later than all of them)
    await db.tracks.put({ ...one, liked: true, updatedAt: Date.now() + 60_000 });
    await sync.syncNow();
    expect(server.posts - posts).toBe(1);
    expect(JSON.parse([...server.rows.values()].sort((x, y) => y.seq - x.seq)[0]!.json!).liked).toBe(true);
  });

  it('an old app that PUTs the doc without songs changes nothing for them', async () => {
    const a = yt('vidAAAAAAAA');
    await db.tracks.put(a);
    await playlist('pl-1', [a.id]);
    await sync.syncNow();
    // an older app (no item sync) pushes its doc: playlist names only, an empty playlist list
    server.doc = { ...server.doc!, playlists: server.doc!.playlists.map(({ ...p }) => ({ ...p, name: 'Renamed on old phone', updatedAt: Date.now() + 5000 })) };
    server.rev++;
    await sync.syncNow();
    const pl = (await db.playlists.get('pl-1'))!;
    expect(pl.name).toBe('Renamed on old phone');
    expect(pl.trackIds).toEqual([a.id]);
    expect(server.rows.get('track\u0000youtube:vidAAAAAAAA')!.json).not.toBeNull();

    // and a new device still gets the song
    await freshDevice();
    await sync.syncNow();
    expect((await db.playlists.get('pl-1'))!.trackIds.length).toBe(1);
    expect((await tracksByRef()).has('vidAAAAAAAA')).toBe(true);
  });

  it('a radio stream station works on the other device (its source points at the stream track id)', async () => {
    const now = Date.now();
    const stream: Track = { ...yt('x'), id: 'stream-1', source: 'stream', ref: 'https://radio.example/live.mp3', title: 'Jazz FM', durationMs: 0 };
    await db.tracks.put(stream);
    const st = (await db.stations.toArray())[0]!;
    await db.stations.put({ ...st, id: 'st-jazz', name: 'Jazz FM', sources: [{ kind: 'stream', ref: 'stream-1' }], createdAt: now, updatedAt: now });
    await sync.syncNow();
    await freshDevice();
    await sync.syncNow();
    const { stationQueue } = await import('../radio/queue');
    const q = await stationQueue((await db.stations.get('st-jazz'))!);
    expect(q.live).toBe(true);
    expect(q.tracks[0]?.ref).toBe('https://radio.example/live.mp3');
  });

  it('a server without item sync: the doc still syncs, no error', async () => {
    server.noItems = true;
    await db.tracks.put(yt('vidAAAAAAAA'));
    await sync.syncNow();
    expect(sync.state.status).toBe('idle');
    expect(server.rev).toBe(1);
  });

  it('a list that arrives before its playlist waits for it', async () => {
    const a = yt('vidAAAAAAAA');
    await db.tracks.put(a);
    await playlist('pl-1', [a.id]);
    await sync.syncNow();
    // device B pulls the items first while the doc still lacks the playlist (an older doc round)
    const doc = server.doc!;
    server.doc = { ...doc, playlists: [] };
    await freshDevice();
    await sync.syncNow();
    expect(await db.playlists.get('pl-1')).toBeUndefined();
    server.doc = doc;
    server.rev++;
    await sync.syncNow();
    const refs = await tracksByRef();
    expect((await db.playlists.get('pl-1'))!.trackIds).toEqual([refs.get('vidAAAAAAAA')!.id]);
  });
});
