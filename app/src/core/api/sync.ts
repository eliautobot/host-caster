// Sync engine (owner: server agent). Signed in: pull on start, debounced push of the user doc on every local change,
// pull again on focus and every few minutes; 409 = someone else pushed first -> pull, three-way merge, push again.
// API keys never travel in the doc: they go to the server's secrets and the doc carries secretRef.
// Songs, playlist lists and unplayable marks sync as their own records after the doc (./syncItems.ts).
// Every device knows which account its data belongs to (core/db/account.ts): another account's data is removed before
// a round, never merged; data that never belonged to an account joins once (the person is asked when it would add
// their own work to an account that already has data).
import { liveQuery, type Subscription } from 'dexie';
import { clearAccountData, dataOwner, setDataOwner } from '../db/account';
import { db } from '../db/db';
import { kvDelete, kvGet, kvSet } from '../db/kv';
import { migrateDocBrains } from '../db/noBrain';
import { desktop } from '../native/desktop';
import { PROFILE_ID, SETTINGS_ID, type Brain, type Playlist, type Settings, type SyncDoc, type VoiceProvider } from '../types';
import { createEmitter } from '../util/emitter';
import { api, ApiError, isOffline, request } from './client';
import { isSyncedTrack } from './itemMerge';
import { COLLECTIONS, docHash, isDestructiveJoin, localTombstones, mergeDocs, planJoin, stampsOf, type JoinAdds, type JoinMode, type SyncBase } from './merge';
import { resetItemState, syncItemsRound, watchItemChanges } from './syncItems';

const BASE_KEY = 'sync:base';
const KEYS_KEY = 'sync:secret-hashes';
/** the person's answer to "Add the stations and hosts on this device to your account?" until the join is done */
const JOIN_KEY = 'sync:join';
const SESSION_KEY = 'api:session';
const PUSH_DELAY = 2000;
const PULL_EVERY = 5 * 60_000;

/** Settings fields that follow the account; the rest (serverUrl) stays on this device. */
const SYNCED_SETTINGS = ['theme', 'activeStationId', 'connections', 'onboarded', 'createdAt', 'updatedAt'] as const;

/** 'choice': waiting for the person to say whether this device's own data joins the account (`join`) */
export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'choice';
export type JoinChoice = 'add' | 'account';
/**
 * Told once: 'other-account': this device held another account's data, it was removed (that account keeps it);
 * 'kept-account': a join would have replaced most of the account, so the account's version was kept.
 */
export type SyncNotice = 'other-account' | 'kept-account';
export interface SyncState {
  status: SyncStatus;
  /** status 'choice': what this device would add to the account */
  join?: JoinAdds;
  lastSyncedAt?: number;
  rev?: number;
  error?: string;
  /** songs the account had no room for in the last round (they stay on this device), and its limit */
  songsRefused?: number;
  songsMax?: number;
}

const events = createEmitter<{ state: SyncState; notice: SyncNotice }>();
let state: SyncState = { status: 'off' };
const setState = (patch: Partial<SyncState>) => {
  state = { ...state, ...patch };
  events.emit('state', state);
};

// ---- local doc ------------------------------------------------------------------------------------------------------

const refFor = (kind: 'brain' | 'voice', rec: { id: string; secretRef?: string }) => rec.secretRef || `${kind}:${rec.id}`;

function keyHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + value.length;
}

/** Reads this device's syncable data (keys stripped, secretRefs filled in). */
export async function readLocalDoc(): Promise<{ doc: SyncDoc; keys: { ref: string; value: string }[] }> {
  const [hosts, stations, brains, voices, playlists, profile, settings, memories, tracker] = await Promise.all([
    db.hosts.toArray(),
    db.stations.toArray(),
    db.brains.toArray(),
    db.voices.toArray(),
    db.playlists.toArray(),
    db.profile.get(PROFILE_ID),
    db.settings.get(SETTINGS_ID),
    db.memories.toArray(),
    db.tracker.toArray(),
  ]);
  const keys: { ref: string; value: string }[] = [];
  const strip = <T extends Brain | VoiceProvider>(kind: 'brain' | 'voice', rec: T): T => {
    const { apiKey, ...rest } = rec;
    if (!apiKey) return rest as T;
    const ref = refFor(kind, rec);
    keys.push({ ref, value: apiKey });
    return { ...rest, secretRef: ref } as T;
  };
  const syncedSettings = settings
    ? (Object.fromEntries(SYNCED_SETTINGS.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]])) as Partial<Settings>)
    : undefined;
  return {
    doc: {
      hosts,
      stations,
      brains: brains.filter((b) => b.kind !== 'builtin').map((b) => strip('brain', b)), // the scripted fallback is never stored
      voices: voices.map((v) => strip('voice', v)),
      playlists: playlists.map(({ trackIds: _t, ...meta }) => meta),
      memories,
      tracker,
      profile,
      settings: syncedSettings,
    },
    keys,
  };
}

/** Uploads keys that changed since the last upload; server transport keys then leave this device. */
async function uploadKeys(all: { ref: string; value: string }[], doc: SyncDoc): Promise<void> {
  // only keys of brains and voices the account holds (never those of records a join leaves out)
  const refs = new Set([...doc.brains, ...doc.voices].map((r) => r.secretRef).filter(Boolean));
  const keys = all.filter((k) => refs.has(k.ref));
  if (!keys.length) return;
  const sent = (await kvGet<Record<string, string>>(KEYS_KEY))?.value ?? {};
  for (const { ref, value } of keys) {
    const h = keyHash(value);
    if (sent[ref] === h) continue;
    await request('PUT', `/api/secrets/${encodeURIComponent(ref)}`, { value });
    sent[ref] = h;
  }
  await kvSet(KEYS_KEY, sent);
  // The server holds keys for 'server' transport now; 'device' transport keeps its key (direct calls need it).
  await db.transaction('rw', [db.brains, db.voices], async () => {
    for (const table of [db.brains, db.voices] as const) {
      const kind = table === db.brains ? 'brain' : 'voice';
      await (table as typeof db.brains).toCollection().modify((rec: Brain) => {
        if (!rec.apiKey) return;
        rec.secretRef = refFor(kind, rec);
        if (rec.transport === 'server') delete rec.apiKey;
      });
    }
  });
}

/** Writes the merged doc into IndexedDB, keeping device-only fields (apiKey, trackIds, serverUrl). */
async function applyLocal(merged: SyncDoc, local: SyncDoc): Promise<void> {
  const tables = { hosts: db.hosts, stations: db.stations, brains: db.brains, voices: db.voices, playlists: db.playlists, memories: db.memories, tracker: db.tracker };
  await db.transaction('rw', [...Object.values(tables), db.profile, db.settings], async () => {
    for (const c of COLLECTIONS) {
      const table = tables[c] as unknown as typeof db.hosts;
      const mergedRecs = (merged[c] ?? []) as { id: string; updatedAt: number }[];
      const localById = new Map(((local[c] ?? []) as { id: string; updatedAt: number }[]).map((r) => [r.id, r]));
      const keep = new Set(mergedRecs.map((r) => r.id));
      const gone = [...localById.keys()].filter((id) => !keep.has(id));
      if (gone.length) await table.bulkDelete(gone);
      const changed = mergedRecs.filter((r) => localById.get(r.id)?.updatedAt !== r.updatedAt || !localById.has(r.id));
      if (!changed.length) continue;
      const existing = new Map((await table.bulkGet(changed.map((r) => r.id))).filter(Boolean).map((r) => [r!.id, r!]));
      const rows = changed.map((r) => {
        const prev = existing.get(r.id) as Record<string, unknown> | undefined;
        const row: Record<string, unknown> = { ...r };
        if (c === 'brains' || c === 'voices') {
          if (prev?.apiKey && (prev.secretRef === row.secretRef || !row.secretRef)) row.apiKey = prev.apiKey;
        }
        if (c === 'playlists') row.trackIds = (prev as Playlist | undefined)?.trackIds ?? [];
        return row;
      });
      await table.bulkPut(rows as never[]);
    }
    if (merged.profile && merged.profile.updatedAt !== local.profile?.updatedAt) await db.profile.put(merged.profile);
    if (merged.settings && merged.settings.updatedAt !== local.settings?.updatedAt) {
      const cur = await db.settings.get(SETTINGS_ID);
      if (cur) await db.settings.put({ ...cur, ...merged.settings, id: SETTINGS_ID, serverUrl: cur.serverUrl } as Settings);
    }
  });
}

// ---- engine ---------------------------------------------------------------------------------------------------------

const baseFor = async (userId: string): Promise<SyncBase | undefined> => {
  const b = (await kvGet<SyncBase>(BASE_KEY))?.value;
  return b && b.userId === userId ? b : undefined;
};

async function saveBase(userId: string, rev: number, doc: SyncDoc): Promise<void> {
  const base: SyncBase = {
    userId,
    rev,
    stamps: stampsOf(doc),
    profileAt: doc.profile?.updatedAt,
    settingsAt: doc.settings?.updatedAt,
    deleted: doc.deleted ?? {},
    hash: docHash(doc),
  };
  await kvSet(BASE_KEY, base);
  // this device's data now belongs to the account (and a finished join needs no answer any more)
  await setDataOwner(userId);
  await kvDelete(JOIN_KEY);
}

let running: Promise<void> | undefined;
let again = false;
let applying = false;

/** One full round: the doc, then songs, playlist lists and unplayable marks. */
async function cycle(forcePull: boolean): Promise<void> {
  const userId = api.session?.user.id;
  if (!userId || !api.available) return;
  // a round while the question waits keeps it on screen (nothing of this device goes anywhere before the answer)
  setState({ status: state.status === 'choice' ? 'choice' : 'syncing', error: undefined });
  const rev = await docRound(userId, forcePull);
  // waiting for the person's answer: nothing of this device goes to the account meanwhile, songs included
  if (rev === undefined) return;
  const items = await syncItemsRound(userId);
  setState({ status: 'idle', join: undefined, lastSyncedAt: Date.now(), rev, songsRefused: items?.refused || undefined, songsMax: items?.max });
}

/** Removes this device's account data (another account's, or the person chose to keep only their account). */
async function clearForAccount(): Promise<void> {
  applying = true;
  try {
    await clearAccountData({ keepKv: [SESSION_KEY, JOIN_KEY] });
  } finally {
    applying = false;
  }
  lastFingerprint = '';
}

const countSyncedSongs = () => db.tracks.filter(isSyncedTrack).count();

async function joinChoice(userId: string): Promise<JoinChoice | undefined> {
  const saved = (await kvGet<{ userId: string; choice: JoinChoice }>(JOIN_KEY))?.value;
  return saved?.userId === userId ? saved.choice : undefined;
}

/**
 * The doc: push local changes; on conflict (or when asked) pull, merge, apply, push. Returns the server rev, or
 * undefined while the person decides whether this device's data joins the account.
 */
async function docRound(userId: string, forcePull: boolean): Promise<number | undefined> {
  let pull = forcePull;
  let join: JoinMode | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    // data of another account never goes into this one: it leaves this device first (that account keeps it)
    const owner = await dataOwner();
    if (owner && owner !== userId) {
      await clearForAccount();
      await kvDelete(BASE_KEY);
      await kvDelete(KEYS_KEY);
      await resetItemState();
      events.emit('notice', 'other-account');
    }
    const base = await baseFor(userId);
    let { doc: local, keys } = await readLocalDoc();
    if (!base) pull = true;

    let remote: { rev: number; doc: SyncDoc | null } | undefined;
    if (pull) remote = await request<{ rev: number; doc: SyncDoc | null }>('GET', '/api/sync');
    if (remote && base && remote.rev === base.rev) remote = undefined; // nothing new on the server
    // a doc from an older app may still give hosts the built-in brain: they get none (and the clean doc is pushed back)
    const remoteDoc = remote?.doc ? migrateDocBrains(remote.doc) : null;
    const joining = !base && remoteDoc !== null;

    // data that never belonged to an account meets an account with data: ask once when it holds the person's own work
    if (joining && !owner && !join) {
      const choice = await joinChoice(userId);
      if (choice === 'account') {
        await clearForAccount();
        ({ doc: local, keys } = await readLocalDoc());
      } else if (!choice) {
        const plan = planJoin(local, remoteDoc, await countSyncedSongs());
        if (plan.kind === 'ask') {
          setState({ status: 'choice', join: plan.adds });
          return undefined;
        }
      }
    }

    let target = remote
      ? mergeDocs(base, local, remoteDoc, Date.now(), { join })
      : { ...local, deleted: { ...(base?.deleted ?? {}), ...localTombstones(base, local) } };
    // last line of defence: a join never replaces most of an account (its records all stay; new ones still join)
    if (joining && join !== 'account' && join !== 'add-new' && isDestructiveJoin(remoteDoc, target)) {
      join = 'add-new';
      target = mergeDocs(base, local, remoteDoc, Date.now(), { join });
      events.emit('notice', 'kept-account');
    }
    const rev = remote?.rev ?? base?.rev ?? 0;

    if (remote) {
      applying = true;
      try {
        await applyLocal(target, local);
      } finally {
        applying = false;
      }
    }
    await uploadKeys(keys, target);
    const hash = docHash(target);
    const serverHas = remote ? remote.doc && docHash(remote.doc) === hash : base?.hash === hash;
    if (serverHas) {
      await saveBase(userId, rev, target);
      return rev;
    }
    try {
      const res = await request<{ rev: number }>('PUT', '/api/sync', { rev, doc: target, ...(joining ? { join: true } : {}) });
      await saveBase(userId, res.rev, target);
      return res.rev;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // the server's own guard refused a join that would replace most of the account: keep the account's version
        if (err.code === 'join_overwrites' && join !== 'account' && join !== 'add-new') {
          join = 'add-new';
          events.emit('notice', 'kept-account');
        }
        pull = true;
        continue;
      }
      throw err;
    }
  }
  throw new ApiError(409, 'conflict', 'Kept conflicting with another device. Try again.');
}

function run(forcePull: boolean): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = cycle(forcePull)
    .catch((err: unknown) => {
      if (isOffline(err)) setState({ status: 'offline' });
      else if (err instanceof ApiError && err.status === 401) setState({ status: 'off' });
      else setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      running = undefined;
      if (again) {
        again = false;
        schedule();
      }
    });
  return running;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pullTimer: ReturnType<typeof setInterval> | undefined;
let watch: Subscription | undefined;
let unwatchItems: (() => void) | undefined;
let lastFingerprint = '';

function schedule(delay = PUSH_DELAY): void {
  if (state.status === 'off') return;
  clearTimeout(timer);
  timer = setTimeout(() => void run(false), delay);
}

const onFocus = () => {
  if (document.visibilityState === 'visible') void run(true);
};
/** the desktop app keeps the page "visible" (music plays on when minimized): its window focus counts instead */
let offWindow: (() => void) | undefined;

export const sync = {
  get state(): SyncState {
    return state;
  },
  on: events.on.bind(events),

  /** Starts syncing for the signed-in user: pull + merge now, then watch local changes. */
  async start(): Promise<void> {
    if (!api.session) return;
    if (state.status === 'off') setState({ status: 'idle' });
    watch ??= liveQuery(async () => {
      const [h, s, b, v, p, pr, st, m, tr] = await Promise.all([
        db.hosts.toArray(),
        db.stations.toArray(),
        db.brains.toArray(),
        db.voices.toArray(),
        db.playlists.toArray(),
        db.profile.get(PROFILE_ID),
        db.settings.get(SETTINGS_ID),
        db.memories.toArray(),
        db.tracker.toArray(),
      ]);
      const ids = (rows: { id: string; updatedAt: number }[]) => rows.map((r) => `${r.id}@${r.updatedAt}`).sort().join(',');
      return [ids(h), ids(s), ids(b), ids(v), ids(p), ids(m), ids(tr), pr?.updatedAt, st?.updatedAt, b.some((x) => x.apiKey), v.some((x) => x.apiKey)].join('|');
    }).subscribe({
      next: (fp) => {
        if (fp === lastFingerprint) return;
        const first = lastFingerprint === '';
        lastFingerprint = fp;
        if (!first && !applying) schedule();
      },
      error: (err: unknown) => console.warn('[hostcaster] sync watch', err),
    });
    unwatchItems ??= watchItemChanges(() => {
      if (!applying) schedule();
    });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onFocus);
    offWindow ??= desktop?.onWindowState((s) => {
      if (s.focused) void run(true);
    });
    pullTimer ??= setInterval(() => void run(true), PULL_EVERY);
    await run(true);
  },

  /**
   * Stops syncing. keepBase (a session that ended by itself) keeps what was synced: the data still belongs to that
   * account. keepBase = false forgets it (the data stays here, belonging to no account).
   */
  async stop(keepBase = false): Promise<void> {
    clearTimeout(timer);
    clearInterval(pullTimer);
    pullTimer = undefined;
    watch?.unsubscribe();
    watch = undefined;
    unwatchItems?.();
    unwatchItems = undefined;
    lastFingerprint = '';
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onFocus);
    offWindow?.();
    offWindow = undefined;
    await running;
    if (!keepBase) {
      await kvDelete(BASE_KEY);
      await kvDelete(KEYS_KEY);
      await kvDelete(JOIN_KEY);
      await resetItemState();
      await setDataOwner(undefined);
    }
    setState({ status: 'off', join: undefined, rev: undefined, lastSyncedAt: undefined, error: undefined, songsRefused: undefined, songsMax: undefined });
  },

  /**
   * The answer to "Add the stations and hosts on this device to your account?": 'add' joins this device's own data
   * (the account's records win where both have one), 'account' replaces this device's data with the account's.
   */
  async chooseJoin(choice: JoinChoice): Promise<void> {
    const userId = api.session?.user.id;
    if (!userId) return;
    await kvSet(JOIN_KEY, { userId, choice });
    setState({ status: 'syncing', join: undefined });
    await run(true);
  },

  /** This device holds the account's data (it synced with it): signing out removes it. */
  async holdsAccountData(userId: string): Promise<boolean> {
    return (await dataOwner()) === userId || (await baseFor(userId)) !== undefined;
  },

  /**
   * Before signing out: pushes what is still waiting. True when the account holds everything of its data here (or
   * this device holds none of it: data that never joined the account is not the account's and stays).
   */
  async flush(): Promise<boolean> {
    const userId = api.session?.user.id;
    if (!userId || !(await sync.holdsAccountData(userId))) return true;
    clearTimeout(timer);
    if (api.available) await run(false);
    const base = await baseFor(userId);
    if (!base) return false;
    const { doc } = await readLocalDoc();
    return docHash({ ...doc, deleted: { ...(base.deleted ?? {}), ...localTombstones(base, doc) } }) === base.hash;
  },

  /** Pull + push right now. */
  syncNow(): Promise<void> {
    return run(true);
  },

  /** Low-level calls, kept for callers that want them. */
  pull: () => request<{ rev: number; doc: SyncDoc | null }>('GET', '/api/sync'),
  push: (rev: number, doc: SyncDoc) => request<{ rev: number }>('PUT', '/api/sync', { rev, doc }),
};
