// Pure queue logic (no DOM): play order, shuffle, repeat and queue edits. The player keeps `items` in play order;
// while shuffled, `original` holds the order the queue was loaded in so shuffle off can restore it.
import type { RepeatMode } from '../types';

export interface QueueItem {
  id: string;
}

export interface QueueState<T extends QueueItem> {
  items: T[];
  /** -1 = nothing selected */
  index: number;
  /** the unshuffled order; undefined while shuffle is off */
  original?: T[];
}

export type Rng = () => number;

/** Fisher-Yates shuffle (returns a new array). */
export function shuffled<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Builds a queue from `items` starting at `start`; with shuffle the start track plays first, the rest shuffled. */
export function createQueue<T extends QueueItem>(items: readonly T[], start = 0, shuffle = false, rng?: Rng): QueueState<T> {
  if (!items.length) return { items: [], index: -1, original: shuffle ? [] : undefined };
  const i = Math.max(0, Math.min(start, items.length - 1));
  if (!shuffle) return { items: items.slice(), index: i };
  const first = items[i]!;
  const rest = items.filter((_, k) => k !== i);
  return { items: [first, ...shuffled(rest, rng)], index: 0, original: items.slice() };
}

/** Shuffle on: the current track stays current (moved to the top), everything else is shuffled after it. */
export function enableShuffle<T extends QueueItem>(q: QueueState<T>, rng?: Rng): QueueState<T> {
  if (q.original) return q;
  if (q.index < 0) return { items: shuffled(q.items, rng), index: -1, original: q.items.slice() };
  const current = q.items[q.index]!;
  const rest = q.items.filter((_, k) => k !== q.index);
  return { items: [current, ...shuffled(rest, rng)], index: 0, original: q.items.slice() };
}

/** Shuffle off: back to the original order, keeping the current track current. */
export function disableShuffle<T extends QueueItem>(q: QueueState<T>): QueueState<T> {
  if (!q.original) return q;
  const current = q.index >= 0 ? q.items[q.index] : undefined;
  const items = q.original.slice();
  let index = current ? items.indexOf(current) : -1;
  if (current && index < 0) index = items.findIndex((t) => t.id === current.id);
  return { items, index: current ? Math.max(0, index) : -1 };
}

/**
 * Index to play after `index`. `auto` = the track ended by itself (repeat one replays it); a user Next always moves on.
 * Returns -1 at the end of the queue with repeat off.
 */
export function nextIndex(length: number, index: number, repeat: RepeatMode, auto: boolean): number {
  if (!length) return -1;
  if (auto && repeat === 'one' && index >= 0) return index;
  const i = index + 1;
  if (i < length) return i;
  return repeat === 'off' ? -1 : 0;
}

/** Index for Previous (the player restarts the current track instead when more than 3 s in). */
export function prevIndex(length: number, index: number, repeat: RepeatMode): number {
  if (!length) return -1;
  if (index > 0) return index - 1;
  return repeat === 'all' ? length - 1 : 0;
}

/** Puts tracks right after the current one ("Play next"). */
export function insertNext<T extends QueueItem>(q: QueueState<T>, tracks: readonly T[]): QueueState<T> {
  const at = q.index + 1;
  const items = [...q.items.slice(0, at), ...tracks, ...q.items.slice(at)];
  let original = q.original;
  if (original) {
    const cur = q.index >= 0 ? q.items[q.index] : undefined;
    const oi = cur ? original.indexOf(cur) + 1 : original.length;
    original = [...original.slice(0, oi), ...tracks, ...original.slice(oi)];
  }
  return { items, index: q.index < 0 && items.length ? 0 : q.index, original };
}

/** Adds tracks at the end ("Add to queue"). */
export function append<T extends QueueItem>(q: QueueState<T>, tracks: readonly T[]): QueueState<T> {
  return {
    items: [...q.items, ...tracks],
    index: q.index < 0 && tracks.length ? 0 : q.index,
    original: q.original ? [...q.original, ...tracks] : undefined,
  };
}

/** Removes the entry at `at`. Removing the current entry keeps the index (the next one becomes current). */
export function removeAt<T extends QueueItem>(q: QueueState<T>, at: number): QueueState<T> {
  if (at < 0 || at >= q.items.length) return q;
  const gone = q.items[at]!;
  const items = q.items.filter((_, k) => k !== at);
  let index = q.index;
  if (at < q.index) index--;
  if (index >= items.length) index = items.length - 1;
  let original = q.original;
  if (original) {
    const oi = original.indexOf(gone);
    original = oi >= 0 ? original.filter((_, k) => k !== oi) : original;
  }
  return { items, index, original };
}

/** Removes every entry whose id is in `ids` (deleted songs). */
export function removeIds<T extends QueueItem>(q: QueueState<T>, ids: ReadonlySet<string>): QueueState<T> {
  let out = q;
  for (let k = out.items.length - 1; k >= 0; k--) if (ids.has(out.items[k]!.id)) out = removeAt(out, k);
  if (out.original) out = { ...out, original: out.original.filter((t) => !ids.has(t.id)) };
  return out;
}

/** Moves the entry at `from` to `to` (drag to reorder); the current track stays current. */
export function move<T extends QueueItem>(q: QueueState<T>, from: number, to: number): QueueState<T> {
  const n = q.items.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return q;
  const items = q.items.slice();
  const [it] = items.splice(from, 1);
  items.splice(to, 0, it!);
  let index = q.index;
  if (q.index === from) index = to;
  else if (from < q.index && to >= q.index) index--;
  else if (from > q.index && to <= q.index) index++;
  return { items, index, original: q.original };
}

/** Drops everything after the current track. */
export function clearUpcoming<T extends QueueItem>(q: QueueState<T>): QueueState<T> {
  const keep = q.items.slice(0, q.index + 1);
  const keepSet = new Set(keep);
  return { items: keep, index: q.index, original: q.original?.filter((t) => keepSet.has(t)) };
}

/** Generic array move (playlists). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it!);
  return out;
}
