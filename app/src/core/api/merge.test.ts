import { describe, expect, it } from 'vitest';
import type { Host, SyncDoc } from '../types';
import { STARTER_HOSTS, STARTER_STATION } from '../db/defaults';
import {
  accountIsEmpty,
  docHash,
  emptyDoc,
  isDestructiveJoin,
  isUntouchedSeed,
  joinOverwrites,
  localTombstones,
  mergeDocs,
  planJoin,
  stampsOf,
  type SyncBase,
} from './merge';

const host = (id: string, updatedAt: number, name = id, createdAt = 1): Host =>
  ({ id, name, createdAt, updatedAt }) as unknown as Host;

const doc = (hosts: Host[], extra: Partial<SyncDoc> = {}): SyncDoc => ({ ...emptyDoc(), hosts, ...extra });

const baseOf = (d: SyncDoc, rev = 1): SyncBase => ({ userId: 'u', rev, stamps: stampsOf(d), deleted: d.deleted ?? {} });

const names = (d: SyncDoc) => d.hosts.map((h) => `${h.id}:${h.name}`).sort();

describe('mergeDocs', () => {
  it('newer edit wins per record; both sides keep their new records', () => {
    const base = baseOf(doc([host('a', 10), host('b', 10)]));
    const local = doc([host('a', 20, 'a-local'), host('b', 10), host('c', 21)]);
    const remote = doc([host('a', 15, 'a-remote'), host('b', 30, 'b-remote'), host('d', 22)]);
    expect(names(mergeDocs(base, local, remote))).toEqual(['a:a-local', 'b:b-remote', 'c:c', 'd:d']);
  });

  it('a local deletion becomes a tombstone and removes the remote copy', () => {
    const base = baseOf(doc([host('a', 10), host('b', 10)]));
    const local = doc([host('a', 10)]);
    const remote = doc([host('a', 10), host('b', 10)]);
    const now = Date.now();
    const merged = mergeDocs(base, local, remote, now);
    expect(names(merged)).toEqual(['a:a']);
    expect(merged.deleted).toEqual({ 'hosts:b': now });
    expect(localTombstones(base, local, now)).toEqual({ 'hosts:b': now });
  });

  it('a remote deletion (tombstone) removes the local copy unless it was edited later', () => {
    const base = baseOf(doc([host('a', 10), host('b', 10)]));
    const remote = doc([host('a', 10)], { deleted: { 'hosts:b': Date.now() - 1000, 'hosts:a2': Date.now() - 1000 } });
    expect(names(mergeDocs(base, doc([host('a', 10), host('b', 10)]), remote))).toEqual(['a:a']);
    const editedAfter = doc([host('a', 10), host('b', Date.now(), 'b-edited')]);
    const merged = mergeDocs(base, editedAfter, remote);
    expect(names(merged)).toEqual(['a:a', 'b:b-edited']);
    expect(merged.deleted?.['hosts:b']).toBeUndefined();
  });

  it('a remote edit made after a local deletion brings the record back', () => {
    const base = baseOf(doc([host('a', 10)]));
    const now = Date.now();
    expect(names(mergeDocs(base, doc([]), doc([host('a', now + 5000, 'a-new')]), now))).toEqual(['a:a-new']);
    expect(names(mergeDocs(base, doc([]), doc([host('a', 10)])))).toEqual([]);
  });

  it('first sync on a fresh device: untouched seeds the account deleted stay deleted', () => {
    const now = Date.now();
    const local = doc([host('seed-host-maya', now, 'Maya', now), host('seed-host-rex', now, 'Rex', now), host('mine', now)]);
    const remote = doc([host('seed-host-rex', 5, 'Rex (edited)')], { deleted: { 'hosts:seed-host-maya': now - 86400e3 } });
    // Rex: both sides have it, the fresh device's copy is newer by time but the merge keeps one; Maya stays deleted
    expect(names(mergeDocs(undefined, local, remote)).map((n) => n.split(':')[0])).toEqual(['mine', 'seed-host-rex']);
  });

  it('first sync on a fresh device: its untouched starter hosts never replace the edited ones on the account', () => {
    const seeded = Date.now() - 3600e3;
    const fresh = Date.now();
    const local = doc([host('seed-host-maya', fresh, 'Maya', fresh), host('seed-host-rex', fresh, 'Rex', fresh)]);
    const remote = doc([host('seed-host-maya', seeded + 600e3, 'Maya (Ollama)', seeded), host('seed-host-rex', seeded, 'Rex', seeded)]);
    expect(names(mergeDocs(undefined, local, remote))).toEqual(['seed-host-maya:Maya (Ollama)', 'seed-host-rex:Rex']);
    // and the other way round: an edit made on this device wins over the account's untouched starter
    const edited = doc([host('seed-host-maya', fresh, 'Maya (here)', seeded - 7200e3)]);
    const untouched = doc([host('seed-host-maya', seeded + 2, 'Maya', seeded + 2)]);
    expect(names(mergeDocs(baseOf(untouched), edited, untouched))).toEqual(['seed-host-maya:Maya (here)']);
  });

  it('first sync takes the account profile/settings over untouched defaults; onboarded is sticky', () => {
    const local = doc([], {
      profile: { id: 'me', name: '', about: '', callMe: '', lifeEvents: [], notes: [], reminders: [], interests: [], avoidTopics: [], units: 'metric', createdAt: 900, updatedAt: 900 },
      settings: { theme: 'dark', onboarded: true, connections: { weather: { enabled: true } }, updatedAt: 900 },
    });
    const remote = doc([], {
      profile: { ...local.profile!, name: 'Sam', updatedAt: 100 },
      settings: { theme: 'light', onboarded: false, connections: { calendar: { google: true, icsUrls: [] } }, updatedAt: 100 },
    });
    const merged = mergeDocs(undefined, local, remote);
    expect(merged.profile?.name).toBe('Sam');
    expect(merged.settings?.theme).toBe('light');
    expect(merged.settings?.onboarded).toBe(true);
    expect(merged.settings?.connections).toEqual({ weather: { enabled: true }, calendar: { google: true, icsUrls: [] } });
    // later syncs: newer wins
    const base = baseOf(merged);
    const later = mergeDocs(base, { ...merged, settings: { ...merged.settings, theme: 'system', updatedAt: 5000 } }, remote);
    expect(later.settings?.theme).toBe('system');
  });

  it('a new device joining an account does not bring its untouched starter records (live QA: Host-Caster 88.1 came back)', () => {
    const t = Date.now();
    const station = (id: string, updatedAt: number, createdAt = updatedAt) => ({ id, name: id, createdAt, updatedAt }) as never;
    // the account deleted the starter station long ago (no tombstone left) and has its own
    const remote = doc([host('seed-host-maya', 5000, 'Maya (mine)', 100)], { stations: [station('yt-station', 900)] });
    const local = doc([host('seed-host-maya', t, 'Maya', t), host('seed-host-rex', t + 1, 'Rex', t + 1)], { stations: [station('seed-station-881', t)] });
    const merged = mergeDocs(undefined, local, remote);
    expect(merged.stations.map((s) => s.id)).toEqual(['yt-station']);
    expect(names(merged)).toEqual(['seed-host-maya:Maya (mine)']);
    // an edited starter record, or anything new made here, still joins
    const edited = doc([host('seed-host-rex', t + 5000, 'Rex (edited)', t), host('mine', t)]);
    expect(names(mergeDocs(undefined, edited, remote))).toEqual(['mine:mine', 'seed-host-maya:Maya (mine)', 'seed-host-rex:Rex (edited)']);
    // the first device of a new account (no doc yet) keeps its starters
    expect(mergeDocs(undefined, local, null).stations.map((s) => s.id)).toEqual(['seed-station-881']);
    // later rounds on the joined device: the starters it kept were synced and behave like any record
    const joined = mergeDocs(undefined, edited, remote);
    expect(names(mergeDocs(baseOf(joined), joined, joined))).toEqual(names(joined));
  });

  it('docHash ignores record order and undefined fields', () => {
    const a = doc([host('a', 1), host('b', 2)]);
    const b = doc([host('b', 2), { ...host('a', 1), tagline: undefined } as unknown as Host]);
    expect(docHash(a)).toBe(docHash(b));
    expect(docHash(a)).not.toBe(docHash(doc([host('a', 1)])));
  });
});

// ---- a device joining an account (the 11-02 bug: account A's leftovers overwrote account B) ----------------------

const T = Date.now();
const starterHost = (i: number, at = T, patch: Partial<Host> = {}): Host => ({ ...STARTER_HOSTS[i]!, createdAt: at + i, updatedAt: at + i, ...patch });
const starterStation = (at = T, patch: object = {}) => ({ ...STARTER_STATION, createdAt: at, updatedAt: at, ...patch }) as never;
const blankProfile = (at = T) =>
  ({ id: 'me', name: '', about: '', callMe: '', lifeEvents: [], notes: [], reminders: [], interests: [], avoidTopics: [], units: 'metric', createdAt: at, updatedAt: at }) as SyncDoc['profile'];

/** An account with real data: edited hosts on its own brain and voices, a profile, its own station, a deleted starter. */
function richAccount(): SyncDoc {
  const day = T - 86400e3;
  return {
    ...emptyDoc(),
    hosts: [0, 1, 2].map((i) => starterHost(i, day - 7 * 86400e3, { brainId: 'b-acct', voice: { voiceProviderId: 'v-acct', voiceId: `voice-${i}`, speed: 1, pitch: 1 }, updatedAt: day + i })),
    stations: [{ id: 'st-acct', name: 'Morning Mix', createdAt: day, updatedAt: day } as never],
    brains: [{ id: 'b-acct', name: 'Account AI', kind: 'openai', model: 'm', transport: 'server', createdAt: day, updatedAt: day } as never],
    profile: { ...blankProfile(day)!, name: 'Bea', callMe: 'Bea', about: 'Night shift nurse', interests: ['jazz'], location: { name: 'Lisbon', lat: 38.7, lon: -9.1 } },
    settings: { theme: 'light', activeStationId: 'st-acct', onboarded: true, connections: { weather: { enabled: true } }, updatedAt: day },
    deleted: { 'stations:seed-station-881': day },
  };
}

/** A device that only ever ran the first-run setup: starters, blank profile, default settings. */
function seedOnlyDevice(at = T): SyncDoc {
  return {
    ...emptyDoc(),
    hosts: [0, 1, 2].map((i) => starterHost(i, at)),
    stations: [starterStation(at)],
    profile: blankProfile(at),
    settings: { theme: 'dark', activeStationId: 'seed-station-881', onboarded: false, connections: {}, createdAt: at, updatedAt: at },
  };
}

describe('untouched starter records', () => {
  it('a starter saved later with its content unchanged is still untouched; a real edit is not', () => {
    expect(isUntouchedSeed(starterHost(0))).toBe(true);
    expect(isUntouchedSeed(starterHost(0, T - 86400e3, { updatedAt: T }))).toBe(true); // saved, nothing changed
    expect(isUntouchedSeed(starterHost(0, T - 86400e3, { updatedAt: T, brainId: 'b1' }))).toBe(false);
    expect(isUntouchedSeed(starterStation(T - 86400e3, { updatedAt: T }))).toBe(true);
    expect(isUntouchedSeed(starterStation(T - 86400e3, { updatedAt: T, name: 'Mine' }))).toBe(false);
    expect(isUntouchedSeed({ id: 'mine', createdAt: 1, updatedAt: 1 })).toBe(false);
  });

  it('an untouched starter always loses to an edited copy, even when it is newer', () => {
    const edited = starterHost(0, T - 86400e3, { updatedAt: T - 3600e3, name: 'Maya (mine)' });
    const resaved = starterHost(0, T - 7200e3, { updatedAt: T }); // newer stamp, starter content
    const base = baseOf(doc([edited]));
    expect(names(mergeDocs(base, doc([resaved]), doc([edited])))).toEqual(['seed-host-maya:Maya (mine)']);
    expect(names(mergeDocs(base, doc([edited]), doc([resaved])))).toEqual(['seed-host-maya:Maya (mine)']);
  });
});

describe('joining an account', () => {
  it('seed-only device into a rich account: the account wins everywhere and nobody is asked', () => {
    const remote = richAccount();
    const local = seedOnlyDevice(T + 5000); // seeded after every account edit
    expect(planJoin(local, remote)).toEqual({ kind: 'merge' });
    const merged = mergeDocs(undefined, local, remote);
    expect(canon(merged.hosts)).toEqual(canon(remote.hosts));
    expect(merged.stations.map((s) => s.id)).toEqual(['st-acct']);
    expect(merged.profile).toEqual(remote.profile);
    expect(merged.settings).toMatchObject({ theme: 'light', activeStationId: 'st-acct', onboarded: true });
    expect(merged.deleted).toEqual(remote.deleted);
    expect(isDestructiveJoin(remote, merged)).toBe(false);
  });

  it('newer edits made on the device never overwrite the account in a join (the account copy wins)', () => {
    const remote = richAccount();
    // the 11-02 leftovers: edited starter hosts with no brain and device voices, a filled-in profile, newer than all
    const local: SyncDoc = {
      ...seedOnlyDevice(T - 30 * 86400e3),
      hosts: [0, 1, 2].map((i) => starterHost(i, T - 30 * 86400e3, { updatedAt: T + i, tagline: 'leftover' })),
      stations: [starterStation(T - 30 * 86400e3, { updatedAt: T, name: 'Leftover 88.1' })],
      profile: { ...blankProfile(T)!, name: 'Ann', callMe: 'Ann', updatedAt: T + 10 },
      tracker: [{ id: 'trk-leftover', what: 'Phone check', createdAt: T, updatedAt: T } as never],
    };
    for (const join of ['add', 'account'] as const) {
      const merged = mergeDocs(undefined, local, remote, T + 100, { join });
      expect(canon(merged.hosts)).toEqual(canon(remote.hosts));
      expect(merged.profile).toEqual(remote.profile);
      // the account deleted the starter station: it stays deleted even though the copy here is newer and edited
      expect(merged.stations.map((s) => s.id)).toEqual(['st-acct']);
      expect(merged.deleted?.['stations:seed-station-881']).toBe(remote.deleted!['stations:seed-station-881']);
      expect(merged.settings).toMatchObject({ theme: 'light', activeStationId: 'st-acct' });
    }
    // 'add' brings only what the account does not have; 'account' brings nothing
    expect(mergeDocs(undefined, local, remote, T + 100, { join: 'add' }).tracker?.map((t) => t.id)).toEqual(['trk-leftover']);
    expect(mergeDocs(undefined, local, remote, T + 100, { join: 'account' }).tracker).toEqual([]);
  });

  it('own work on a local-first device into an account with data: ask, with what would be added', () => {
    const remote = richAccount();
    const local: SyncDoc = {
      ...seedOnlyDevice(T - 86400e3),
      hosts: [...seedOnlyDevice(T - 86400e3).hosts, { id: 'h-mine', name: 'DJ Kim', createdAt: T, updatedAt: T } as never],
      stations: [{ id: 'st-mine', name: 'Kim FM', createdAt: T, updatedAt: T } as never],
      memories: [{ id: 'm1', text: 'likes tea', createdAt: T, updatedAt: T } as never],
    };
    const plan = planJoin(local, remote, 12);
    expect(plan.kind).toBe('ask');
    if (plan.kind !== 'ask') return;
    expect(plan.adds).toMatchObject({ hosts: ['DJ Kim'], stations: ['Kim FM'], memories: 1, songs: 12, profile: false, brains: 0 });
    // 'add': the account keeps all it had and gains the new records; 'account': exactly the account
    const added = mergeDocs(undefined, local, remote, T, { join: 'add' });
    expect(added.hosts.map((h) => h.id).sort()).toEqual(['h-mine', 'seed-host-jules', 'seed-host-maya', 'seed-host-rex']);
    expect(added.stations.map((s) => s.id).sort()).toEqual(['st-acct', 'st-mine']);
    expect(isDestructiveJoin(remote, added)).toBe(false);
    const kept = mergeDocs(undefined, local, remote, T, { join: 'account' });
    expect(kept.hosts.map((h) => h.id).sort()).toEqual(remote.hosts.map((h) => h.id).sort());
    expect(kept.stations.map((s) => s.id)).toEqual(['st-acct']);
    expect(kept.memories).toEqual([]);
    // songs alone are own work too
    expect(planJoin(seedOnlyDevice(), remote, 3)).toMatchObject({ kind: 'ask', adds: { songs: 3, hosts: [] } });
  });

  it('a local profile counts as own work only when the account has none', () => {
    const local = { ...seedOnlyDevice(), profile: { ...blankProfile()!, name: 'Kim' } };
    expect(planJoin(local, richAccount())).toEqual({ kind: 'merge' }); // the account profile wins, nothing to add
    const noProfile = { ...richAccount(), profile: blankProfile(T - 9e6) };
    expect(planJoin(local, noProfile)).toMatchObject({ kind: 'ask', adds: { profile: true } });
    expect(mergeDocs(undefined, local, noProfile, T, { join: 'add' }).profile?.name).toBe('Kim');
    expect(mergeDocs(undefined, local, noProfile, T, { join: 'account' }).profile?.name).toBe('');
  });

  it('a new or empty account keeps the device data (no question)', () => {
    const local: SyncDoc = { ...seedOnlyDevice(), stations: [{ id: 'st-mine', name: 'Kim FM', createdAt: T, updatedAt: T } as never] };
    expect(planJoin(local, null, 40)).toEqual({ kind: 'merge' });
    expect(accountIsEmpty(seedOnlyDevice(T - 9e6))).toBe(true);
    expect(planJoin(local, seedOnlyDevice(T - 9e6), 40)).toEqual({ kind: 'merge' });
    expect(mergeDocs(undefined, local, null).stations.map((s) => s.id)).toEqual(['st-mine']);
    // an empty account that deleted the starter station: the deletion still holds
    const emptied = { ...emptyDoc(), deleted: { 'stations:seed-station-881': T - 9e6 } };
    expect(accountIsEmpty(emptied)).toBe(true);
    const joined = mergeDocs(undefined, { ...local, stations: [...local.stations, starterStation(T, { updatedAt: T + 5, name: 'Edited' })] }, emptied);
    expect(joined.stations.map((s) => s.id)).toEqual(['st-mine']);
  });
});

describe('join modes', () => {
  it("'add' lets an edit here replace a starter the account only re-saved; 'add-new' keeps every account record", () => {
    const resaved = starterHost(0, T - 9e6, { updatedAt: T - 1e6 }); // saved on the account, starter content
    const editedHere = starterHost(0, T - 9e6, { updatedAt: T, name: 'Maya (here)' });
    const mine = { id: 'h-mine', name: 'Mine', createdAt: T, updatedAt: T } as Host;
    const remote = { ...richAccount(), hosts: [resaved] };
    const local = doc([editedHere, mine]);
    expect(names(mergeDocs(undefined, local, remote, T, { join: 'add' }))).toEqual(['h-mine:Mine', 'seed-host-maya:Maya (here)']);
    expect(names(mergeDocs(undefined, local, remote, T, { join: 'add-new' }))).toEqual(['h-mine:Mine', 'seed-host-maya:Maya']);
    expect(joinOverwrites(remote, mergeDocs(undefined, local, remote, T, { join: 'add-new' })).changed).toBe(0);
  });
});

describe('mass overwrite guard', () => {
  it('flags a pushed doc that would replace most of an account (the 11-02 shape) and passes normal joins', () => {
    const remote = richAccount();
    const leftovers: SyncDoc = {
      ...remote,
      hosts: remote.hosts.map((h) => ({ ...h, brainId: null, voice: { voiceProviderId: 'device', voiceId: '', speed: 1, pitch: 1 }, updatedAt: T })),
      stations: [...remote.stations, starterStation(T, { updatedAt: T + 1, name: 'Back' })],
      profile: { ...remote.profile!, about: '', interests: [], location: undefined, name: 'Ann' },
      deleted: {},
    };
    expect(joinOverwrites(remote, leftovers)).toEqual({ changed: 5, parts: 7 }); // 3 hosts, 1 station, profile, settings, 1 deletion
    expect(isDestructiveJoin(remote, leftovers)).toBe(true);
    expect(isDestructiveJoin(remote, remote)).toBe(false);
    // one host edited on a small account is not "most"
    const one = { ...remote, hosts: [{ ...remote.hosts[0]!, name: 'Maya 2' }, ...remote.hosts.slice(1)] };
    expect(isDestructiveJoin(remote, one)).toBe(false);
    // starters the account never saved carry nothing of it
    expect(joinOverwrites(seedOnlyDevice(T - 9e6), leftovers).parts).toBe(1);
  });
});

const canon = (hosts: Host[]) => hosts.map((h) => JSON.stringify(h)).sort();
