// Player state that survives a reload: the queue, where you were, and your player preferences (kv table).
import { db, kvGet, kvSet } from '../db';
import type { RepeatMode, Track } from '../types';

export const RESUME_KEY = 'player:resume';
export const PREFS_KEY = 'player:prefs';
const MAX_SAVED = 2000;

export interface ResumeSnapshot {
  /** queue in play order (full tracks so server/stream entries survive) */
  items: Track[];
  /** unshuffled order as ids, while shuffle is on */
  original?: string[];
  index: number;
  positionMs: number;
}

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** 0 = off */
  crossfadeMs: number;
}

export const DEFAULT_PREFS: PlayerPrefs = { volume: 0.85, muted: false, shuffle: false, repeat: 'off', crossfadeMs: 0 };

export async function saveResume(s: ResumeSnapshot): Promise<void> {
  // keep a window around the current track for very long queues
  let { items, index } = s;
  if (items.length > MAX_SAVED) {
    const start = Math.max(0, Math.min(index - 100, items.length - MAX_SAVED));
    items = items.slice(start, start + MAX_SAVED);
    index -= start;
  }
  await kvSet<ResumeSnapshot>(RESUME_KEY, { ...s, items, index });
}

/** Loads the snapshot with fresh copies of the tracks (likes, play counts); deleted local songs are dropped. */
export async function loadResume(): Promise<ResumeSnapshot | undefined> {
  const rec = await kvGet<ResumeSnapshot>(RESUME_KEY);
  const snap = rec?.value;
  if (!snap?.items?.length) return undefined;
  const fresh = await db.tracks.bulkGet(snap.items.map((t) => t.id));
  const current = snap.items[snap.index];
  const items: Track[] = [];
  snap.items.forEach((t, k) => {
    const live = fresh[k];
    if (live) items.push(live);
    else if (t.source !== 'local') items.push(t);
  });
  if (!items.length) return undefined;
  let index = current ? items.findIndex((t) => t.id === current.id) : -1;
  const positionMs = index >= 0 ? snap.positionMs : 0;
  if (index < 0) index = Math.min(Math.max(0, snap.index), items.length - 1);
  return { items, index, positionMs, original: snap.original };
}

export async function loadPrefs(): Promise<PlayerPrefs> {
  const rec = await kvGet<Partial<PlayerPrefs>>(PREFS_KEY);
  return { ...DEFAULT_PREFS, ...(rec?.value ?? {}) };
}

export async function savePrefs(p: PlayerPrefs): Promise<void> {
  await kvSet(PREFS_KEY, p);
}
