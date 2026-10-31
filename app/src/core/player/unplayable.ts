// Songs that cannot play here (YouTube: embedding turned off, removed, private, blocked in this country). Kept in kv
// for a while so stations leave them out up front instead of trying them again; owners can turn embedding back on,
// so an entry expires.
import { kvGet, kvSet } from '../db';
import type { Track } from '../types';

export const UNPLAYABLE_TTL_MS = 14 * 24 * 3600_000;
const MAX = 2000;

export type UnplayableEntry = { reason: string; code?: number; at: number };
type Entry = UnplayableEntry;
type Store = Record<string, Entry>;
export const UNPLAYABLE_KEY = 'player:unplayable';
const KEY = UNPLAYABLE_KEY;

let cache: Promise<Store> | undefined;

async function load(): Promise<Store> {
  cache ??= kvGet<Store>(KEY).then(
    (r) => r?.value ?? {},
    () => ({}),
  );
  return cache;
}

/** Remembers that these tracks cannot play (by track id). */
export async function markUnplayable(tracks: Pick<Track, 'id'>[], reason: string, code?: number, now = Date.now()): Promise<void> {
  if (!tracks.length) return;
  const store = { ...(await load()) };
  for (const t of tracks) store[t.id] = { reason, ...(code !== undefined ? { code } : {}), at: now };
  const fresh = Object.entries(store)
    .filter(([, e]) => now - e.at < UNPLAYABLE_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX);
  const next = Object.fromEntries(fresh);
  cache = Promise.resolve(next);
  await kvSet(KEY, next).catch(() => undefined);
}

/** A track played after all (owner turned embedding back on): forget it. */
export async function clearUnplayable(id: string): Promise<void> {
  const store = await load();
  if (!store[id]) return;
  const next = { ...store };
  delete next[id];
  cache = Promise.resolve(next);
  await kvSet(KEY, next).catch(() => undefined);
}

/** Track ids known not to play (not expired). */
export async function unplayableIds(now = Date.now()): Promise<Set<string>> {
  const store = await load();
  return new Set(Object.entries(store).filter(([, e]) => now - e.at < UNPLAYABLE_TTL_MS).map(([id]) => id));
}

/** Every mark that has not expired, by track id (sync sends them to the account's other devices). */
export async function unplayableEntries(now = Date.now()): Promise<Record<string, UnplayableEntry>> {
  const store = await load();
  return Object.fromEntries(Object.entries(store).filter(([, e]) => now - e.at < UNPLAYABLE_TTL_MS));
}

/** Marks from another device (kept when newer than the one here) and marks it cleared, in one write. */
export async function applyUnplayable(add: Record<string, UnplayableEntry>, remove: string[], now = Date.now()): Promise<void> {
  const store = { ...(await load()) };
  let changed = false;
  for (const [id, e] of Object.entries(add)) {
    if (now - e.at >= UNPLAYABLE_TTL_MS || (store[id] && store[id].at >= e.at)) continue;
    store[id] = e;
    changed = true;
  }
  for (const id of remove) if (store[id] && delete store[id]) changed = true;
  if (!changed) return;
  const next = Object.fromEntries(Object.entries(store).sort((a, b) => b[1].at - a[1].at).slice(0, MAX));
  cache = Promise.resolve(next);
  await kvSet(KEY, next).catch(() => undefined);
}

/** tests */
export function resetUnplayableCache(): void {
  cache = undefined;
}
