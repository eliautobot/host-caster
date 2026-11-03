// Three-way merge of sync docs (pure, no I/O). base = what this device last agreed with the server (ids + updatedAt
// per collection), local = this device now, remote = the server doc. Newer edits win per record; deletions travel
// as tombstones ('<collection>:<id>' -> deletedAt) and lose to an edit made after them.
// A device joining an account (no base) never overwrites the account: see mergeDocs and planJoin.
import { STARTER_HOSTS, STARTER_STATION } from '../db/defaults';
import type { SyncDoc } from '../types';
import { contentOf, stableStringify } from '../util/stable';

export { stableStringify };

export const COLLECTIONS = ['hosts', 'stations', 'brains', 'voices', 'playlists', 'memories', 'tracker'] as const;
export type Collection = (typeof COLLECTIONS)[number];

interface Rec {
  id: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SyncBase {
  userId: string;
  rev: number;
  /** collection -> id -> updatedAt */
  stamps: Record<Collection, Record<string, number>>;
  profileAt?: number;
  settingsAt?: number;
  /** tombstones as last seen on the server */
  deleted: Record<string, number>;
  /** hash of the doc last pushed or pulled */
  hash?: string;
}

const TOMBSTONE_TTL = 90 * 24 * 3600_000;
const at = (r: Rec | undefined) => r?.updatedAt ?? 0;

/** A starter record that was never saved after seeding (the server's guard uses this rule too). */
export const seededUnsaved = (r: Rec) => r.id.startsWith('seed-') && (r.updatedAt ?? 0) <= (r.createdAt ?? 0) + 1000;
const STARTERS = new Map<string, string>([...STARTER_HOSTS, STARTER_STATION].map((s) => [s.id, contentOf(s)]));

/**
 * A starter host or station nobody changed: never saved since seeding, or saved with the starter content still (a
 * save that changed nothing, or an edit undone). It never wins over an account's or another device's record.
 */
export function isUntouchedSeed(r: Rec): boolean {
  if (!r.id.startsWith('seed-')) return false;
  if (seededUnsaved(r)) return true;
  const starter = STARTERS.get(r.id);
  return starter !== undefined && starter === contentOf(r);
}

/**
 * How a device with no base joins an account that already has a doc. 'add': the device's own records join, the
 * account's records win over the device's copies (an untouched starter of the account loses to an edit made here).
 * 'add-new': the same, but every record the account has wins (used when 'add' would change most of the account).
 * 'account': only the account's data stays.
 */
export type JoinMode = 'add' | 'add-new' | 'account';

export function emptyDoc(): SyncDoc {
  return { hosts: [], stations: [], brains: [], voices: [], playlists: [], memories: [], tracker: [], deleted: {} };
}

export function stampsOf(doc: SyncDoc): SyncBase['stamps'] {
  const out = {} as SyncBase['stamps'];
  for (const c of COLLECTIONS) out[c] = Object.fromEntries(((doc[c] ?? []) as Rec[]).map((r) => [r.id, at(r)]));
  return out;
}

/** Tombstones for records that were in base but are gone locally (this device deleted them). */
export function localTombstones(base: SyncBase | undefined, local: SyncDoc, now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  if (!base) return out;
  for (const c of COLLECTIONS) {
    const ids = new Set((local[c] as Rec[]).map((r) => r.id));
    for (const id of Object.keys(base.stamps[c] ?? {})) if (!ids.has(id)) out[`${c}:${id}`] = now;
  }
  return out;
}

function mergeTombstones(...lists: (Record<string, number> | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  const cutoff = Date.now() - TOMBSTONE_TTL;
  for (const l of lists) {
    for (const [k, v] of Object.entries(l ?? {})) if (v > cutoff && v > (out[k] ?? 0)) out[k] = v;
  }
  return out;
}

/**
 * Both sides hold the record: the newer edit wins, but a starter record nobody edited never beats an edited one (a new
 * device seeds the starter hosts and station "now", later than the edits made on the first device).
 */
function pickEdited<T extends Rec>(l: T, r: T): T {
  const lSeed = isUntouchedSeed(l);
  if (lSeed !== isUntouchedSeed(r)) return lSeed ? r : l;
  return at(l) > at(r) ? l : r;
}

/** Joining: the account's copy wins; only an untouched starter of the account gives way to an edit made here ('add'). */
function pickJoined<T extends Rec>(l: T, r: T, join: JoinMode): T {
  return join === 'add' && isUntouchedSeed(r) && !isUntouchedSeed(l) ? l : r;
}

function mergeCollection<T extends Rec>(
  c: Collection,
  base: Record<string, number> | undefined,
  local: T[],
  remote: T[],
  tombs: Record<string, number>,
  join: JoinMode | undefined,
  accountDeleted: Record<string, number>,
): T[] {
  const L = new Map(local.map((r) => [r.id, r]));
  const R = new Map(remote.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id);
    const r = R.get(id);
    const dead = tombs[`${c}:${id}`];
    let keep: T | undefined;
    if (l && r) keep = join ? pickJoined(l, r, join) : pickEdited(l, r);
    else if (l && join) {
      // a device joining an account that already has a doc: its untouched starter records stay out (the account
      // either never had them or deleted them, maybe longer ago than tombstones live), and so does anything the
      // account deleted, however new the copy here is (it was never part of the account's history)
      keep = join !== 'account' && !isUntouchedSeed(l) && accountDeleted[`${c}:${id}`] === undefined ? l : undefined;
    } else if (l) {
      // gone remotely: a tombstone (or, for old docs, missing after we had synced it) means deleted elsewhere
      const deletedRemotely = dead !== undefined || (base !== undefined && id in base);
      const deletedAt = dead ?? base?.[id] ?? 0;
      keep = deletedRemotely && (isUntouchedSeed(l) || at(l) <= deletedAt) ? undefined : l;
    } else if (r) {
      // gone locally: deleted here if we had synced it before; an edit elsewhere after that wins
      const deletedHere = (base !== undefined && id in base) || dead !== undefined;
      keep = deletedHere && at(r) <= Math.max(base?.[id] ?? 0, dead ?? 0) ? undefined : r;
    }
    if (keep) out.push(keep);
  }
  return out;
}

function newer<T extends Rec>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  return at(a) > at(b) ? a : b;
}

const blankProfile = (p: SyncDoc['profile']) =>
  !p || (!p.name && !p.about && !p.callMe && !p.lifeEvents?.length && !p.notes?.length && !p.reminders?.length && !p.interests?.length);

/** The account's doc holds nothing of its own: no record that is not an untouched starter, a blank profile. */
export function accountIsEmpty(remote: SyncDoc | null): boolean {
  if (!remote) return true;
  return blankProfile(remote.profile) && COLLECTIONS.every((c) => ((remote[c] ?? []) as Rec[]).every(isUntouchedSeed));
}

/**
 * Merges local and remote into the doc both sides should hold next.
 * First sync on a device (no base) with an account that already has a doc is a join (`opts.join`, default 'add'):
 * the account's records, profile and settings win over this device's copies, its deletions hold, and this device's
 * untouched starter hosts and station stay out. A device signing in to an account with no doc yet keeps everything.
 */
export function mergeDocs(
  base: SyncBase | undefined,
  local: SyncDoc,
  remote: SyncDoc | null,
  now = Date.now(),
  opts: { join?: JoinMode } = {},
): SyncDoc {
  const r = remote ?? emptyDoc();
  const join: JoinMode | undefined = !base && remote !== null ? (opts.join ?? 'add') : undefined;
  const accountDeleted = mergeTombstones(r.deleted);
  const tombs = mergeTombstones(r.deleted, base?.deleted, localTombstones(base, local, now));
  const merged = emptyDoc();
  for (const c of COLLECTIONS) {
    (merged[c] as Rec[]) = mergeCollection(c, base?.stamps[c], local[c] as Rec[], (r[c] ?? []) as Rec[], tombs, join, accountDeleted);
  }
  // a record that survived (edited after a delete) clears its tombstone
  for (const c of COLLECTIONS) for (const rec of merged[c] as Rec[]) delete tombs[`${c}:${rec.id}`];
  merged.deleted = tombs;

  if (join === 'account') merged.profile = r.profile ?? local.profile;
  else if (join) merged.profile = blankProfile(r.profile) && !blankProfile(local.profile) ? local.profile : (r.profile ?? local.profile);
  else merged.profile = newer(local.profile, r.profile);

  const ls = local.settings;
  const rs = r.settings;
  if (ls && rs) {
    const [older, newest] = join || at(rs as Rec) >= at(ls as Rec) ? [ls, rs] : [rs, ls];
    merged.settings = {
      ...older,
      ...newest,
      connections: join === 'account' ? { ...rs.connections } : { ...older.connections, ...newest.connections },
      onboarded: Boolean(ls.onboarded || rs.onboarded),
    };
  } else merged.settings = ls ?? rs;
  return merged;
}

// ---- joining an account ---------------------------------------------------------------------------------------------

/** What this device would add to the account (names for hosts and stations, counts for the rest). */
export interface JoinAdds {
  hosts: string[];
  stations: string[];
  brains: number;
  voices: number;
  playlists: number;
  memories: number;
  tracker: number;
  profile: boolean;
  /** songs in this device's library that can sync (files never do) */
  songs: number;
}

/**
 * The first sync of a device whose data never belonged to an account. 'merge': nothing to decide (the account is new
 * or empty, so this device's data goes in; or this device has nothing of its own, so the account's data comes in).
 * 'ask': the account has data and this device has its own work: ask once whether to add it (`adds`).
 */
export type JoinPlan = { kind: 'merge' } | { kind: 'ask'; adds: JoinAdds };

export function planJoin(local: SyncDoc, remote: SyncDoc | null, songs = 0, now = Date.now()): JoinPlan {
  if (accountIsEmpty(remote)) return { kind: 'merge' };
  const added = mergeDocs(undefined, local, remote, now, { join: 'add' });
  const kept = mergeDocs(undefined, local, remote, now, { join: 'account' });
  const fresh = <C extends Collection>(c: C) => {
    const before = new Map(((kept[c] ?? []) as Rec[]).map((rec) => [rec.id, rec]));
    return ((added[c] ?? []) as Rec[]).filter((rec) => before.get(rec.id) !== rec);
  };
  const label = (rec: Rec) => String((rec as { name?: unknown }).name ?? '') || 'Untitled';
  const adds: JoinAdds = {
    hosts: fresh('hosts').map(label),
    stations: fresh('stations').map(label),
    brains: fresh('brains').length,
    voices: fresh('voices').length,
    playlists: fresh('playlists').length,
    memories: fresh('memories').length,
    tracker: fresh('tracker').length,
    profile: added.profile !== kept.profile && !blankProfile(added.profile),
    songs,
  };
  const any =
    adds.hosts.length || adds.stations.length || adds.brains || adds.voices || adds.playlists || adds.memories || adds.tracker || adds.profile || songs;
  return any ? { kind: 'ask', adds } : { kind: 'merge' };
}

const PROFILE_FIELDS = ['name', 'callMe', 'about', 'location', 'units', 'lifeEvents', 'notes', 'reminders', 'interests', 'avoidTopics'] as const;
const SETTINGS_FIELDS = ['theme', 'activeStationId'] as const;
const same = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

/**
 * How much of the account a join would overwrite, counted in parts: each host and station of the account (a starter
 * never saved does not count), its profile (when not blank), its settings and each of its deletions. `changed`: the
 * parts the pushed doc would change (a deletion dropped counts). Mirrored by the server's guard (syncGuard.js).
 */
export function joinOverwrites(remote: SyncDoc, target: SyncDoc): { changed: number; parts: number } {
  let changed = 0;
  let parts = 0;
  const count = (differs: boolean) => {
    parts++;
    if (differs) changed++;
  };
  for (const c of ['hosts', 'stations'] as const) {
    const next = new Map((target[c] as Rec[]).map((rec) => [rec.id, rec]));
    for (const rec of remote[c] as Rec[]) {
      if (seededUnsaved(rec)) continue;
      const t = next.get(rec.id);
      count(!t || contentOf(t) !== contentOf(rec));
    }
  }
  if (!blankProfile(remote.profile)) {
    const p = remote.profile as unknown as Record<string, unknown>;
    const q = (target.profile ?? {}) as unknown as Record<string, unknown>;
    count(PROFILE_FIELDS.some((k) => !same(p[k], q[k])));
  }
  if (remote.settings) {
    const s = remote.settings as Record<string, unknown>;
    const t = (target.settings ?? {}) as Record<string, unknown>;
    const conn = (remote.settings.connections ?? {}) as Record<string, unknown>;
    const tconn = (target.settings?.connections ?? {}) as Record<string, unknown>;
    count(SETTINGS_FIELDS.some((k) => s[k] !== undefined && !same(s[k], t[k])) || Object.keys(conn).some((k) => !same(conn[k], tconn[k])));
  }
  // deletions still in force (older ones are forgotten anyway)
  for (const key of Object.keys(mergeTombstones(remote.deleted))) count(!(target.deleted && key in target.deleted));
  return { changed, parts };
}

/** A join that would change most of an account (at least 3 parts): never pushed blindly. */
export function isDestructiveJoin(remote: SyncDoc, target: SyncDoc): boolean {
  const { changed, parts } = joinOverwrites(remote, target);
  return changed >= 3 && changed * 2 > parts;
}

/** Collections sorted by id so the hash does not depend on read order. */
export function canonical(doc: SyncDoc): SyncDoc {
  const out = { ...doc };
  for (const c of COLLECTIONS) (out[c] as Rec[]) = [...((doc[c] ?? []) as Rec[])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function docHash(doc: SyncDoc): string {
  // FNV-1a 64-bit over the canonical JSON; equality check only, not security.
  const text = stableStringify(canonical(doc));
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(36);
}
