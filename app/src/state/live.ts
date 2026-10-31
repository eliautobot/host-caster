import { liveQuery } from 'dexie';

/** Subscribes `onValue` to a Dexie live query; re-runs whenever the tables it read change. */
export function bindLive<T>(query: () => Promise<T>, onValue: (value: T) => void): () => void {
  const sub = liveQuery(query).subscribe({
    next: onValue,
    error: (err: unknown) => console.error('[hostcaster] live query failed', err),
  });
  return () => sub.unsubscribe();
}
