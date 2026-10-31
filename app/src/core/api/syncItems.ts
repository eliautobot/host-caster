// Item sync (owner: server agent): songs, playlist lists and unplayable marks as their own records next to the sync
// doc, so a liked list of thousands of songs is not resent on every edit. A round pulls what changed since this
// device's cursor (pages of 1000), applies it, then pushes what changed here: each record is compared with the hash of
// what was last synced, so only edits go up (500 per request). Songs and marks: the newer edit wins. Playlist lists:
// pushed against the server version they were edited from; when another device got there first, both edits merge
// (its order, minus what this device removed, plus what it added). See ARCHITECTURE.md "Sync".
import { db } from '../db/db';
import { kvDelete, kvGet, kvSet } from '../db/kv';
import { applyUnplayable, UNPLAYABLE_KEY, UNPLAYABLE_TTL_MS, unplayableEntries, type UnplayableEntry } from '../player/unplayable';
import type { Playlist, Track } from '../types';
import { newId } from '../util/id';
import { ApiError, request } from './client';
import {
  dataHash,
  isSyncedTrack,
  localMembers,
  mergeLists,
  sameList,
  trackData,
  trackFromData,
  trackKey,
  wireMembers,
  type SyncItem,
  type TrackData,
} from './itemMerge';

const META = 'sync:items';
const TRACKS = 'sync:items:tracks';
const MARKS = 'sync:items:unplayable';
const LISTS = 'sync:items:members';
const PENDING = 'sync:items:pending';
const KEYS = [META, TRACKS, MARKS, LISTS, PENDING];
const PAGE = 1000;
const PUSH_BATCH = 500;
const MAX_PAGES = 500;
/** under the server's limits (16 KB per song, 1 MB per list) */
const MAX_TRACK_BYTES = 15_000;
const MAX_LIST_BYTES = 1_000_000;

interface ListBase {
  /** the server's updatedAt of this list (the base for the next push) */
  at: number;
  keys: string[];
}

interface State {
  userId: string;
  cursor: number;
  /** song key -> hash of this device's copy when it last matched the server */
  tracks: Record<string, string>;
  /** song key -> time of the mark last synced */
  marks: Record<string, number>;
  /** playlist id -> the server's list */
  lists: Record<string, ListBase>;
  /** lists of playlists that are not on this device yet (the doc brings them) */
  pending: Record<string, ListBase>;
}

interface PullPage {
  items: SyncItem[];
  cursor: number;
  more: boolean;
  reset?: boolean;
}

interface PushResult {
  before: number;
  cursor: number;
  stale: SyncItem[];
  refused?: { kind: string; id: string }[];
  full?: number;
  max?: number;
}

export interface ItemRound {
  pulled: number;
  pushed: number;
  /** songs the account had no room for (they stay on this device) */
  refused: number;
  max?: number;
}

const fresh = (userId: string): State => ({ userId, cursor: 0, tracks: {}, marks: {}, lists: {}, pending: {} });

async function loadState(userId: string): Promise<State> {
  const meta = (await kvGet<{ userId: string; cursor: number }>(META))?.value;
  if (!meta || meta.userId !== userId) return fresh(userId);
  const [tracks, marks, lists, pending] = await Promise.all([TRACKS, MARKS, LISTS, PENDING].map((k) => kvGet<Record<string, never>>(k)));
  return { userId, cursor: meta.cursor, tracks: tracks?.value ?? {}, marks: marks?.value ?? {}, lists: lists?.value ?? {}, pending: pending?.value ?? {} };
}

async function saveState(st: State): Promise<void> {
  await kvSet(TRACKS, st.tracks);
  await kvSet(MARKS, st.marks);
  await kvSet(LISTS, st.lists);
  await kvSet(PENDING, st.pending);
  await kvSet(META, { userId: st.userId, cursor: st.cursor });
}

/** Forget what was synced (sign out, another account next). */
export async function resetItemState(): Promise<void> {
  for (const k of KEYS) await kvDelete(k);
}

// ---- this device ----------------------------------------------------------------------------------------------------

interface Index {
  byId: Map<string, Track>;
  byKey: Map<string, Track>;
}

async function localIndex(): Promise<Index> {
  const all = await db.tracks.toArray();
  const byId = new Map(all.map((t) => [t.id, t]));
  const byKey = new Map<string, Track>();
  for (const t of all) {
    if (!isSyncedTrack(t)) continue;
    const k = trackKey(t);
    const prev = byKey.get(k);
    if (!prev || t.addedAt < prev.addedAt) byKey.set(k, t);
  }
  return { byId, byKey };
}

const idByKey = (idx: Index) => new Map([...idx.byKey].map(([k, t]) => [k, t.id]));

/** True while this module writes what it pulled (the change watchers ignore those writes). */
let applyingItems = false;

async function applying<T>(fn: () => Promise<T>): Promise<T> {
  applyingItems = true;
  try {
    return await fn();
  } finally {
    applyingItems = false;
  }
}

/** Puts the server's list into a playlist here, merged with this device's edits since the last sync. */
async function applyList(pl: Playlist, remote: ListBase, st: State, idx: Index): Promise<void> {
  const local = wireMembers(pl.trackIds, idx.byId);
  const base = st.lists[pl.id]?.keys;
  const merged = base && sameList(local, base) ? remote.keys : mergeLists(base ?? [], local, remote.keys);
  st.lists[pl.id] = remote;
  delete st.pending[pl.id];
  const next = localMembers(merged, idByKey(idx));
  // not an edit here: updatedAt stays (the doc carries the playlist's name and when it was edited)
  if (!sameList(next, pl.trackIds)) await db.playlists.update(pl.id, { trackIds: next });
}

/**
 * Applies records from the server (a pull page, or the server's versions of records it refused). `idx` is this
 * device's index for the whole round (read once, kept current here), so a first pull of many pages stays linear.
 */
async function applyRemote(items: SyncItem[], st: State, idx: Index): Promise<void> {
  if (!items.length) return;
  await applying(async () => {
    // songs first: the lists and marks below refer to them
    const puts: Track[] = [];
    const gone: string[] = [];
    for (const it of items) {
      if (it.kind !== 'track') continue;
      const local = idx.byKey.get(it.id);
      const localHash = local ? dataHash(trackData(local)) : undefined;
      const editedHere = local !== undefined && st.tracks[it.id] !== localHash;
      if (it.deleted) {
        // deleted on another device; an edit here made after that keeps it (and sends it back up)
        if (local && (!editedHere || local.updatedAt <= it.updatedAt)) {
          gone.push(local.id);
          idx.byKey.delete(it.id);
        }
        delete st.tracks[it.id];
        continue;
      }
      const data = it.data as TrackData;
      if (local && localHash === dataHash(data)) {
        st.tracks[it.id] = localHash;
        continue;
      }
      if (local && editedHere && local.updatedAt > it.updatedAt) continue; // this device's newer edit goes up next
      const row = trackFromData(data, local, newId, it.updatedAt, (id) => !idx.byId.has(id));
      puts.push(row);
      idx.byKey.set(it.id, row);
      idx.byId.set(row.id, row);
      st.tracks[it.id] = dataHash(trackData(row));
    }
    if (puts.length) await db.tracks.bulkPut(puts);
    if (gone.length) {
      const { deleteTracks } = await import('../library/tracks');
      await deleteTracks(gone, { fromSync: true });
      for (const id of gone) idx.byId.delete(id);
    }

    // unplayable marks (only for songs that are here)
    const marks = items.filter((i) => i.kind === 'unplayable');
    if (marks.length) {
      const here = await unplayableEntries();
      const add: Record<string, UnplayableEntry> = {};
      const remove: string[] = [];
      for (const it of marks) {
        const t = idx.byKey.get(it.id);
        if (it.deleted) {
          if (t && here[t.id] && here[t.id]!.at <= it.updatedAt) remove.push(t.id);
          delete st.marks[it.id];
        } else if (t) {
          const d = it.data as { reason?: string; code?: number };
          add[t.id] = { reason: d.reason || 'This song cannot play here.', ...(d.code !== undefined ? { code: d.code } : {}), at: it.updatedAt };
          st.marks[it.id] = it.updatedAt;
        }
      }
      await applyUnplayable(add, remove);
    }

    // playlist lists
    for (const it of items) {
      if (it.kind !== 'members') continue;
      if (it.deleted) {
        delete st.lists[it.id];
        delete st.pending[it.id];
        continue;
      }
      const remote = { at: it.updatedAt, keys: ((it.data as { keys?: unknown })?.keys as string[] | undefined)?.filter((k) => typeof k === 'string') ?? [] };
      const pl = await db.playlists.get(it.id);
      if (pl) await applyList(pl, remote, st, idx);
      else st.pending[it.id] = remote;
    }
  });
}

/** Records that changed here since they were last synced, songs first (other devices pull in this order). */
async function changes(st: State, now = Date.now()): Promise<SyncItem[]> {
  let idx = await localIndex();
  // lists that arrived before their playlist did
  const waiting = Object.keys(st.pending);
  if (waiting.length) {
    const found = (await db.playlists.bulkGet(waiting)).filter((p): p is Playlist => Boolean(p));
    if (found.length) {
      await applying(async () => {
        for (const pl of found) await applyList(pl, st.pending[pl.id]!, st, idx);
      });
      idx = await localIndex();
    }
  }
  const out: SyncItem[] = [];
  for (const [key, t] of idx.byKey) {
    const d = trackData(t);
    if (st.tracks[key] === dataHash(d) || JSON.stringify(d).length > MAX_TRACK_BYTES) continue;
    out.push({ kind: 'track', id: key, updatedAt: Math.max(1, t.updatedAt || 0), data: d });
  }
  for (const key of Object.keys(st.tracks)) if (!idx.byKey.has(key)) out.push({ kind: 'track', id: key, updatedAt: now, deleted: true });

  const entries = await unplayableEntries(now);
  const marked = new Set<string>();
  for (const [id, e] of Object.entries(entries)) {
    const t = idx.byId.get(id);
    if (!t || !isSyncedTrack(t)) continue;
    const key = trackKey(t);
    marked.add(key);
    if (st.marks[key] === e.at) continue;
    out.push({ kind: 'unplayable', id: key, updatedAt: e.at, data: { reason: e.reason, ...(e.code !== undefined ? { code: e.code } : {}) } });
  }
  for (const [key, at] of Object.entries(st.marks)) {
    if (marked.has(key)) continue;
    // expired by itself, or the song is gone: nothing to tell; cleared here (it played after all): tell
    if (now - at >= UNPLAYABLE_TTL_MS || !idx.byKey.has(key)) delete st.marks[key];
    else out.push({ kind: 'unplayable', id: key, updatedAt: now, deleted: true });
  }

  const playlists = await db.playlists.toArray();
  for (const pl of playlists) {
    const keys = wireMembers(pl.trackIds, idx.byId);
    const base = st.lists[pl.id];
    if (base ? sameList(keys, base.keys) : !keys.length) continue;
    if (JSON.stringify(keys).length > MAX_LIST_BYTES) continue;
    out.push({ kind: 'members', id: pl.id, updatedAt: Math.max(now, (base?.at ?? 0) + 1), base: base?.at ?? 0, data: { keys } });
  }
  const here = new Set(playlists.map((p) => p.id));
  for (const [id, base] of Object.entries(st.lists)) {
    if (!here.has(id)) out.push({ kind: 'members', id, updatedAt: Math.max(now, base.at + 1), base: base.at, deleted: true });
  }
  return out;
}

/** What the server now holds for a record it took. */
function record(st: State, it: SyncItem): void {
  if (it.kind === 'track') {
    if (it.deleted) delete st.tracks[it.id];
    else st.tracks[it.id] = dataHash(it.data as TrackData);
  } else if (it.kind === 'unplayable') {
    if (it.deleted) delete st.marks[it.id];
    else st.marks[it.id] = it.updatedAt;
  } else if (it.deleted) delete st.lists[it.id];
  else st.lists[it.id] = { at: it.updatedAt, keys: (it.data as { keys: string[] }).keys };
}

let unsupported = false;

/** One round for the signed-in user: pull, apply, push (again after the server kept a newer version). */
export async function syncItemsRound(userId: string): Promise<ItemRound | undefined> {
  if (unsupported) return undefined;
  let st = await loadState(userId);
  const out: ItemRound = { pulled: 0, pushed: 0, refused: 0 };
  let idx: Index | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    let res: PullPage;
    try {
      res = await request<PullPage>('GET', `/api/sync/items?since=${st.cursor}&limit=${PAGE}`);
    } catch (err) {
      // an older server without item sync: the doc still syncs; songs stay on each device
      if (err instanceof ApiError && err.status === 404) {
        unsupported = true;
        return undefined;
      }
      throw err;
    }
    // the server dropped tombstones this device never saw (or it is not the server it knew): start over, keep everything
    if (res.reset) st = fresh(userId);
    if (res.items.length) await applyRemote(res.items, st, (idx ??= await localIndex()));
    out.pulled += res.items.length;
    st.cursor = res.cursor;
    await saveState(st);
    if (!res.more) break;
  }

  for (let round = 0; round < 3; round++) {
    const todo = await changes(st);
    if (!todo.length) break;
    let stale = 0;
    for (let i = 0; i < todo.length; i += PUSH_BATCH) {
      const batch = todo.slice(i, i + PUSH_BATCH);
      const res = await request<PushResult>('POST', '/api/sync/items', { items: batch });
      const kept = new Set([...res.stale, ...(res.refused ?? [])].map((s) => `${s.kind}\u0000${s.id}`));
      for (const it of batch) if (!kept.has(`${it.kind}\u0000${it.id}`)) record(st, it);
      out.pushed += batch.length - kept.size;
      out.refused += res.refused?.length ?? 0;
      out.max = res.max ?? out.max;
      // nobody else wrote in between: this device has seen everything up to the new cursor
      if (res.before === st.cursor) st.cursor = res.cursor;
      if (res.stale.length) await applyRemote(res.stale, st, await localIndex());
      stale += res.stale.length;
      await saveState(st);
    }
    if (!stale) break;
  }
  await saveState(st);
  return out;
}

/** Watches songs and unplayable marks so a change here is pushed (play counts and pulled records do not count). */
export function watchItemChanges(onChange: () => void): () => void {
  const local = new Set(['playCount', 'lastPlayedAt']);
  const fire = () => {
    if (!applyingItems) onChange();
  };
  function created(): void {
    fire();
  }
  function updated(mods: object): void {
    if (Object.keys(mods).some((k) => !local.has(k))) fire();
  }
  function kvChanged(key: string): void {
    if (key === UNPLAYABLE_KEY) fire();
  }
  function kvUpdated(_mods: object, key: string): void {
    kvChanged(key);
  }
  db.tracks.hook('creating', created);
  db.tracks.hook('updating', updated);
  db.tracks.hook('deleting', created);
  db.kv.hook('creating', kvChanged);
  db.kv.hook('updating', kvUpdated);
  return () => {
    db.tracks.hook('creating').unsubscribe(created);
    db.tracks.hook('updating').unsubscribe(updated);
    db.tracks.hook('deleting').unsubscribe(created);
    db.kv.hook('creating').unsubscribe(kvChanged);
    db.kv.hook('updating').unsubscribe(kvUpdated);
  };
}

/** tests */
export function resetItemSyncSession(): void {
  unsupported = false;
}
