// Three-way merge of sync docs (pure, no I/O). base = what this device last agreed with the server (ids + updatedAt
// per collection), local = this device now, remote = the server doc. Newer edits win per record; deletions travel
// as tombstones ('<collection>:<id>' -> deletedAt) and lose to an edit made after them.
import type { SyncDoc } from '../types';

export const COLLECTIONS = ['hosts', 'stations', 'brains', 'voices', 'playlists'] as const;
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
const isUneditedSeed = (r: Rec) => r.id.startsWith('seed-') && (r.updatedAt ?? 0) <= (r.createdAt ?? 0) + 1000;

export function emptyDoc(): SyncDoc {
  return { hosts: [], stations: [], brains: [], voices: [], playlists: [], deleted: {} };
}

export function stampsOf(doc: SyncDoc): SyncBase['stamps'] {
  const out = {} as SyncBase['stamps'];
  for (const c of COLLECTIONS) out[c] = Object.fromEntries((doc[c] as Rec[]).map((r) => [r.id, at(r)]));
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
  const lSeed = isUneditedSeed(l);
  if (lSeed !== isUneditedSeed(r)) return lSeed ? r : l;
  return at(l) > at(r) ? l : r;
}

function mergeCollection<T extends Rec>(
  c: Collection,
  base: Record<string, number> | undefined,
  local: T[],
  remote: T[],
  tombs: Record<string, number>,
  joining: boolean,
): T[] {
  const L = new Map(local.map((r) => [r.id, r]));
  const R = new Map(remote.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id);
    const r = R.get(id);
    const dead = tombs[`${c}:${id}`];
    let keep: T | undefined;
    if (l && r) keep = pickEdited(l, r);
    else if (l) {
      // gone remotely: a tombstone (or, for old docs, missing after we had synced it) means deleted elsewhere
      const deletedRemotely = dead !== undefined || (base !== undefined && id in base);
      const deletedAt = dead ?? base?.[id] ?? 0;
      // a device joining an account that already has a doc: its untouched starter records stay out (the account
      // either never had them or deleted them, maybe longer ago than tombstones live)
      if (joining && isUneditedSeed(l)) keep = undefined;
      else keep = deletedRemotely && (isUneditedSeed(l) || at(l) <= deletedAt) ? undefined : l;
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

/**
 * Merges local and remote into the doc both sides should hold next.
 * First sync on a device (no base): the account's profile/settings win over this device's untouched defaults, and
 * this device's untouched starter hosts and station stay out of an account that already has a doc.
 */
export function mergeDocs(base: SyncBase | undefined, local: SyncDoc, remote: SyncDoc | null, now = Date.now()): SyncDoc {
  const r = remote ?? emptyDoc();
  const tombs = mergeTombstones(r.deleted, base?.deleted, localTombstones(base, local, now));
  const merged = emptyDoc();
  const joining = !base && remote !== null;
  for (const c of COLLECTIONS) {
    (merged[c] as Rec[]) = mergeCollection(c, base?.stamps[c], local[c] as Rec[], (r[c] ?? []) as Rec[], tombs, joining);
  }
  // a record that survived (edited after a delete) clears its tombstone
  for (const c of COLLECTIONS) for (const rec of merged[c] as Rec[]) delete tombs[`${c}:${rec.id}`];
  merged.deleted = tombs;

  if (!base && r.profile && blankProfile(local.profile)) merged.profile = r.profile;
  else merged.profile = newer(local.profile, r.profile);

  const ls = local.settings;
  const rs = r.settings;
  if (ls && rs) {
    const [older, newest] = !base || at(rs as Rec) >= at(ls as Rec) ? [ls, rs] : [rs, ls];
    merged.settings = {
      ...older,
      ...newest,
      connections: { ...older.connections, ...newest.connections },
      onboarded: Boolean(ls.onboarded || rs.onboarded),
    };
  } else merged.settings = ls ?? rs;
  return merged;
}

/** Stable JSON (sorted keys) for hashing and equality. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** Collections sorted by id so the hash does not depend on read order. */
export function canonical(doc: SyncDoc): SyncDoc {
  const out = { ...doc };
  for (const c of COLLECTIONS) (out[c] as Rec[]) = [...(doc[c] as Rec[])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
