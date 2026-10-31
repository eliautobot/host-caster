// Every context source keeps its last snapshot in kv so the radio still talks offline.
import { kvGet, kvSet } from '../db';

export interface Cached<T> {
  value?: T;
  fetchedAt?: number;
  /** true when the value is older than the ttl (the fetch failed or was skipped) */
  stale: boolean;
  error?: string;
}

/**
 * Returns the cached value when it is fresher than `ttlMs`; otherwise fetches, stores and returns it. A failed fetch
 * returns the old snapshot (marked stale) so the hosts still have something true to say.
 */
export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>, now = Date.now()): Promise<Cached<T>> {
  const prev = await kvGet<T>(key).catch(() => undefined);
  if (prev && now - prev.fetchedAt < ttlMs) return { value: prev.value, fetchedAt: prev.fetchedAt, stale: false };
  try {
    const value = await fetcher();
    await kvSet(key, value, now).catch(() => undefined);
    return { value, fetchedAt: now, stale: false };
  } catch (err) {
    return { value: prev?.value, fetchedAt: prev?.fetchedAt, stale: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Races a promise against a timeout; resolves undefined on timeout or error (context sources never block a break). */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((resolve) => (t = setTimeout(() => resolve(undefined), ms)))]);
  } catch {
    return undefined;
  } finally {
    if (t) clearTimeout(t);
  }
}
