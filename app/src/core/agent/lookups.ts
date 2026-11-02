// The Lookups log: what the hosts read, when and why. Lookups the server ran are logged there; the ones this device
// ran (weather, calendar feeds) are reported to it, so every device signed in to the account shows the same list.
// Signed out, this device's own list (kv) is the log. Also counts this device's lookups for its daily cap.
import { api, request } from '../api';
import { kvGet, kvSet } from '../db';

export interface Lookup {
  id?: number | string;
  at: number;
  tool: string;
  what: string;
  host?: string;
  purpose?: string;
  ok: boolean;
  ms?: number;
  where?: 'server' | 'device';
}

const KEY = 'agent:lookups';
const KEEP = 300;
/** this device's lookups in 24 hours when no server counts them */
export const DEVICE_LOOKUPS_PER_DAY = 400;

let pending: Lookup[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

async function flush(): Promise<void> {
  flushTimer = undefined;
  const items = pending.splice(0, 50);
  if (!items.length || !api.available || !api.signedIn) return;
  await request('POST', '/api/agent/lookups', { items }).catch(() => undefined);
}

/** Records a lookup this device ran (and, signed in, reports it to the server soon). */
export function noteLookup(l: Omit<Lookup, 'at' | 'where'> & { at?: number }, opts: { report?: boolean } = {}): void {
  const entry: Lookup = { ...l, at: l.at ?? Date.now(), where: 'device' };
  void (async () => {
    const list = (await kvGet<Lookup[]>(KEY))?.value ?? [];
    await kvSet(KEY, [entry, ...list].slice(0, KEEP));
  })().catch(() => undefined);
  if (opts.report === false) return;
  pending.push(entry);
  flushTimer ??= setTimeout(() => void flush(), 3000);
}

export async function localLookups(): Promise<Lookup[]> {
  return (await kvGet<Lookup[]>(KEY))?.value ?? [];
}

/** The log for the Lookups list: the account's (signed in) or this device's. */
export async function listLookups(limit = 100): Promise<{ lookups: Lookup[]; from: 'account' | 'device' }> {
  if (api.available && api.signedIn) {
    try {
      const r = await request<{ lookups: Lookup[] }>('GET', `/api/agent/lookups?limit=${limit}`);
      return { lookups: r.lookups, from: 'account' };
    } catch {
      // fall back to this device's list
    }
  }
  return { lookups: (await localLookups()).slice(0, limit), from: 'device' };
}

export async function clearLookups(): Promise<void> {
  await kvSet(KEY, []);
  if (api.available && api.signedIn) await request('DELETE', '/api/agent/lookups').catch(() => undefined);
}

/** This device's lookups in the last 24 hours (the cap when no server counts them). */
export async function deviceLookupsToday(now = Date.now()): Promise<number> {
  return (await localLookups()).filter((l) => now - l.at < 86_400_000).length;
}
