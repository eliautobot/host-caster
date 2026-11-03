// Account switching on one device (the 11-02 bug: signing in as B after A merged A's leftovers into B). Sync engine and
// sign-out against an in-memory fake server with one doc per account (fetch stubbed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_KEY, dataOwner } from '../db/account';
import { SEED_IDS, db, getProfile, getSettings, initDb, listHosts, listStations, putBlob, saveBrain, saveHost, saveProfile, saveStation, saveTracks } from '../db';
import { kvGet, kvSet } from '../db/kv';
import type { Host, SyncDoc, Track } from '../types';
import { auth } from './auth';
import { api } from './client';
import { canonical, isUntouchedSeed } from './merge';
import { sync, type SyncNotice } from './sync';

interface Account {
  rev: number;
  doc: SyncDoc | null;
  puts: SyncDoc[];
}

let current = '';
const accounts = new Map<string, Account>();
let refuseJoins = 0;

function installServer(): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const acct = accounts.get(current);
    if (path === '/api/auth/logout') return json(200, { ok: true });
    if (!acct) return json(401, { error: { code: 'unauthorized', message: 'no session' } });
    if (path === '/api/sync' && method === 'GET') return json(200, { rev: acct.rev, doc: acct.doc && structuredClone(acct.doc) });
    if (path === '/api/sync' && method === 'PUT') {
      if (body.rev !== acct.rev) return json(409, { error: { code: 'conflict', message: 'stale' }, rev: acct.rev });
      if (body.join && refuseJoins > 0) {
        refuseJoins--;
        return json(409, { error: { code: 'join_overwrites', message: 'would replace most of the account' }, rev: acct.rev });
      }
      acct.rev++;
      acct.doc = body.doc;
      acct.puts.push(body.doc);
      return json(200, { rev: acct.rev });
    }
    if (/^\/api\/secrets\//.test(path) && method === 'PUT') return json(200, { ok: true });
    return json(404, { error: { code: 'not_found', message: path } });
  });
}

const signInAs = async (id: string) => {
  current = id;
  if (!accounts.has(id)) accounts.set(id, { rev: 0, doc: null, puts: [] });
  api.available = true;
  api.configure({ baseUrl: '', session: { user: { id, name: id, providers: ['google'] }, kind: 'web' } });
  await sync.start();
};

/** A session that ended by itself (expired): the app stops syncing and keeps what was synced. */
const sessionEnded = async () => {
  await sync.stop(true);
  api.configure({ session: undefined });
  current = '';
};

const day = 86400e3;
const T = Date.now();

/** Account B, made on another device: its own hosts (AI brain, voices), profile, station; it deleted the starter one. */
function richDocB(): SyncDoc {
  const hosts = [SEED_IDS.maya, SEED_IDS.jules, SEED_IDS.rex].map(
    (id, i) =>
      ({
        id,
        name: ['Maya', 'Jules', 'Rex'][i],
        createdAt: T - 30 * day,
        updatedAt: T - 2 * day,
        brainId: 'brain-b',
        voice: { voiceProviderId: 'voice-b', voiceId: `b-${i}`, speed: 1, pitch: 1 },
        personality: 'B made this host',
        catchphrases: [],
        topics: [],
        avoid: [],
      }) as unknown as Host,
  );
  return {
    hosts,
    stations: [{ id: 'st-b', name: 'B Radio', createdAt: T - 9 * day, updatedAt: T - 9 * day, hostIds: [SEED_IDS.maya], sources: [] } as never],
    brains: [{ id: 'brain-b', name: 'B brain', kind: 'openai', model: 'gpt', transport: 'server', secretRef: 'brain:brain-b', createdAt: T - 9 * day, updatedAt: T - 9 * day } as never],
    voices: [{ id: 'voice-b', name: 'B voices', kind: 'openai', transport: 'server', createdAt: T - 9 * day, updatedAt: T - 9 * day } as never],
    playlists: [],
    memories: [{ id: 'mem-b', text: 'B works nights', kind: 'about', source: 'you', learnedAt: T - day, createdAt: T - day, updatedAt: T - day } as never],
    tracker: [],
    profile: { id: 'me', name: 'Bea', callMe: 'Bea', about: 'Night nurse', units: 'metric', interests: ['jazz'], avoidTopics: [], lifeEvents: [], notes: [], reminders: [], location: { name: 'Lisbon', lat: 38.7, lon: -9.1 }, createdAt: T - 30 * day, updatedAt: T - 3 * day },
    settings: { theme: 'light', activeStationId: 'st-b', onboarded: true, connections: { weather: { enabled: true } }, createdAt: T - 30 * day, updatedAt: T - 3 * day },
    deleted: { [`stations:${SEED_IDS.station}`]: T - 5 * day },
  };
}

const track = (id: string, source: Track['source'], ref: string, extra: Partial<Track> = {}): Track =>
  ({ id, title: id, artist: 'X', album: '', durationMs: 1000, source, ref, playCount: 0, addedAt: T, ...extra }) as Track;

/** What account A does on this device: edits every host, fills in the profile, adds a station, a brain with a key, songs. */
async function useAsA(): Promise<void> {
  for (const h of await listHosts()) await saveHost({ ...h, brainId: null, tagline: `A's ${h.name}` });
  await saveProfile({ name: 'Ann', callMe: 'Ann', about: 'A likes mornings', interests: ['rock'] });
  await saveStation({ name: 'A Morning', hostIds: [SEED_IDS.maya], sources: [], frequency: '90.1', color: '#000' } as never);
  await saveBrain({ name: 'A key', kind: 'openai', model: 'm', transport: 'device', apiKey: 'sk-a-device' } as never);
  await db.tracker.put({ id: 'trk-a', what: 'Phone check', kind: 'todo', status: 'open', key: 'k', source: { type: 'you', label: 'You' }, createdAt: T, updatedAt: T } as never);
  await db.journal.put({ id: 'j-a', at: T, day: '2026-11-02', kind: 'said', text: 'A said hi' } as never);
  const file = await putBlob(new Blob(['audio']), 'blob-file');
  const art = await putBlob(new Blob(['art']), 'art-yt');
  await saveTracks([track('t-yt', 'youtube', 'vid-a', { artworkId: art.id }), track('t-file', 'local', file.id), track('t-dev', 'device', 'android:9')]);
  await kvSet('spotify:tokens', { access: 'a-token' });
  await kvSet('chat:thread', [{ text: 'hello from A' }]);
  await kvSet('devicemusic:settings', { enabled: true });
  await kvSet('player:prefs', { volume: 0.4 });
}

const canon = (doc: SyncDoc | null) => JSON.stringify(doc && canonical(doc));

async function expectCleanFirstRun(): Promise<void> {
  const hosts = await listHosts();
  expect(hosts.map((h) => h.id)).toEqual([SEED_IDS.maya, SEED_IDS.jules, SEED_IDS.rex]);
  expect(hosts.every(isUntouchedSeed)).toBe(true);
  expect((await listStations()).map((s) => s.id)).toEqual([SEED_IDS.station]);
  expect(await db.brains.count()).toBe(0);
  expect(await db.tracker.count()).toBe(0);
  expect(await db.journal.count()).toBe(0);
  expect(await db.memories.count()).toBe(0);
  expect((await getProfile()).name).toBe('');
  expect((await getSettings()).onboarded).toBe(false);
}

describe('signing in and out with more than one account on a device', () => {
  const notices: SyncNotice[] = [];
  let off: () => void;
  beforeEach(async () => {
    await sync.stop();
    current = '';
    accounts.clear();
    refuseJoins = 0;
    notices.length = 0;
    off = sync.on('notice', (n) => notices.push(n));
    api.configure({ session: undefined });
    db.close();
    await db.delete();
    await initDb();
    installServer();
  });
  afterEach(async () => {
    off();
    await sync.stop();
    vi.unstubAllGlobals();
  });

  it('A signs out: the device is clean; B signs in: B unchanged, nothing of A; A signs back in: A intact', async () => {
    accounts.set('b', { rev: 7, doc: richDocB(), puts: [] });
    await signInAs('a');
    await useAsA();
    await sync.syncNow();
    expect(await dataOwner()).toBe('a');
    const docA = accounts.get('a')!.doc;
    expect(docA?.hosts.find((h) => h.id === SEED_IDS.maya)?.tagline).toBe("A's Maya");

    expect(await sync.flush()).toBe(true);
    expect(await auth.signOut()).toBe(true);
    await expectCleanFirstRun();
    // device data stays: song files and music folders with their files, player and device music settings
    expect((await db.tracks.toArray()).map((t) => t.id).sort()).toEqual(['t-dev', 't-file']);
    expect((await db.blobs.toArray()).map((b) => b.id)).toEqual(['blob-file']);
    expect(await kvGet('devicemusic:settings')).toBeDefined();
    expect(await kvGet('player:prefs')).toBeDefined();
    for (const key of ['spotify:tokens', 'chat:thread', 'api:session', 'sync:base', OWNER_KEY]) expect(await kvGet(key)).toBeUndefined();

    const before = canon(accounts.get('b')!.doc);
    await signInAs('b');
    expect(canon(accounts.get('b')!.doc)).toBe(before);
    expect(accounts.get('b')!.puts).toEqual([]);
    expect((await listHosts()).map((h) => (h as Host & { personality: string }).personality)).toEqual(['B made this host', 'B made this host', 'B made this host']);
    expect((await listStations()).map((s) => s.id)).toEqual(['st-b']);
    expect((await getProfile()).name).toBe('Bea');
    expect(await db.tracker.count()).toBe(0);
    expect(await db.brains.toArray().then((b) => b.map((x) => x.id))).toEqual(['brain-b']);
    expect(await dataOwner()).toBe('b');
    expect(sync.state.status).toBe('idle');

    await auth.signOut();
    await signInAs('a');
    expect(canon(accounts.get('a')!.doc)).toBe(canon(docA));
    expect((await getProfile()).name).toBe('Ann');
    expect((await listStations()).map((s) => s.name).sort()).toEqual(['A Morning', 'Host-Caster 88.1']);
    expect(notices).toEqual([]);
  });

  it("a session that ended by itself keeps A's data as A's; B signing in next removes it first, B stays unchanged", async () => {
    accounts.set('b', { rev: 3, doc: richDocB(), puts: [] });
    await signInAs('a');
    await useAsA();
    await sync.syncNow();
    await sessionEnded();
    expect(await dataOwner()).toBe('a');
    expect((await getProfile()).name).toBe('Ann');

    const before = canon(accounts.get('b')!.doc);
    await signInAs('b');
    expect(notices).toEqual(['other-account']);
    expect(canon(accounts.get('b')!.doc)).toBe(before);
    expect((await getProfile()).name).toBe('Bea');
    expect(await db.tracker.count()).toBe(0);
    expect(await db.tracks.where('source').equals('youtube').count()).toBe(0);
    expect(await kvGet('spotify:tokens')).toBeUndefined();
  });

  it('A signing back in after a session that ended keeps syncing from where it was (no question, no clearing)', async () => {
    await signInAs('a');
    await useAsA();
    await sync.syncNow();
    await sessionEnded();
    await saveProfile({ about: 'edited while signed out' });
    await signInAs('a');
    expect(accounts.get('a')!.doc?.profile?.about).toBe('edited while signed out');
    expect(notices).toEqual([]);
  });

  it('local-first with own work into an account with data: asked, nothing sent meanwhile; Add them adds', async () => {
    accounts.set('b', { rev: 2, doc: richDocB(), puts: [] });
    await saveStation({ name: 'Kim FM', hostIds: [], sources: [], frequency: '99.9', color: '#111' } as never);
    await saveTracks([track('t-yt', 'youtube', 'vid-kim')]);
    await signInAs('b');
    expect(sync.state.status).toBe('choice');
    expect(sync.state.join).toMatchObject({ stations: ['Kim FM'], songs: 1, hosts: [] });
    expect(accounts.get('b')!.puts).toEqual([]);
    expect((await listStations()).map((s) => s.name)).toContain('Kim FM');
    // a sign-out now keeps this data: it never joined the account
    expect(await sync.flush()).toBe(true);

    await sync.chooseJoin('add');
    const doc = accounts.get('b')!.doc!;
    expect(doc.stations.map((s) => s.name).sort()).toEqual(['B Radio', 'Kim FM']);
    const strip = (d: SyncDoc) => JSON.parse(canon({ ...d, stations: [], deleted: {} }));
    expect(strip(doc)).toEqual(strip(richDocB()));
    expect(doc.deleted).toEqual(richDocB().deleted);
    expect(await dataOwner()).toBe('b');
    expect(sync.state.status).toBe('idle');
  });

  it('local-first with own work: Keep only my account leaves exactly the account, songs from services included', async () => {
    accounts.set('b', { rev: 2, doc: richDocB(), puts: [] });
    await saveStation({ name: 'Kim FM', hostIds: [], sources: [], frequency: '99.9', color: '#111' } as never);
    await saveTracks([track('t-yt', 'youtube', 'vid-kim'), track('t-file', 'local', 'blob-x')]);
    await signInAs('b');
    expect(sync.state.status).toBe('choice');
    const before = canon(accounts.get('b')!.doc);
    await sync.chooseJoin('account');
    expect(canon(accounts.get('b')!.doc)).toBe(before);
    expect((await listStations()).map((s) => s.name)).toEqual(['B Radio']);
    expect((await db.tracks.toArray()).map((t) => t.id)).toEqual(['t-file']);
    expect(sync.state.status).toBe('idle');
  });

  it('seed-only device into a rich account: no question, the account wins everywhere', async () => {
    accounts.set('b', { rev: 4, doc: richDocB(), puts: [] });
    const before = canon(accounts.get('b')!.doc);
    await signInAs('b');
    expect(sync.state.status).toBe('idle');
    expect(canon(accounts.get('b')!.doc)).toBe(before);
    expect((await listStations()).map((s) => s.id)).toEqual(['st-b']);
    expect((await getSettings()).theme).toBe('light');
  });

  it('local-first, then a new account: everything on the device goes in', async () => {
    await saveStation({ name: 'Kim FM', hostIds: [], sources: [], frequency: '99.9', color: '#111' } as never);
    await saveProfile({ name: 'Kim' });
    await signInAs('new');
    expect(sync.state.status).toBe('idle');
    const doc = accounts.get('new')!.doc!;
    expect(doc.stations.map((s) => s.name).sort()).toEqual(['Host-Caster 88.1', 'Kim FM']);
    expect(doc.profile?.name).toBe('Kim');
  });

  it("the server refusing a join that would replace most of the account: the account's records stay, new ones join", async () => {
    accounts.set('b', { rev: 2, doc: richDocB(), puts: [] });
    await saveStation({ name: 'Kim FM', hostIds: [], sources: [], frequency: '99.9', color: '#111' } as never);
    await signInAs('b');
    refuseJoins = 1;
    await sync.chooseJoin('add');
    expect(notices).toEqual(['kept-account']);
    const doc = accounts.get('b')!.doc!;
    expect(doc.stations.map((s) => s.name).sort()).toEqual(['B Radio', 'Kim FM']);
    expect(doc.hosts.every((h) => (h as Host & { personality: string }).personality === 'B made this host')).toBe(true);
  });
});
