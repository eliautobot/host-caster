import { describe, expect, it } from 'vitest';
import type { Host, SyncDoc } from '../types';
import { docHash, emptyDoc, localTombstones, mergeDocs, stampsOf, type SyncBase } from './merge';

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
