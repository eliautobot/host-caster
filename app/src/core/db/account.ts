// Which account this device's data belongs to, and the cleanup when it stops belonging to one (sign out, another
// account signing in, "Keep only my account"). Data of one account never goes into another: the sync engine checks
// the owner before every round (core/api/sync.ts).
//
// Account data (removed): hosts, stations, AI brains, voices, profile, settings, Your list, memories, the journal, the
// on-air log (breaks, call transcripts), playlists, songs from services (YouTube, Spotify, streams, Subsonic, the
// server library), and every kv entry that is not about this device: tokens, sync state, caches of calendar, mail,
// news and weather, the message thread, pending actions, research, counters.
// Device data (kept): song files added on this device and device music folders (tracks 'local' and 'device', their
// files and covers, they never sync), player volume and crossfade, device music settings, update notices, migration
// markers, the theme and the server address.
import type { KvRecord, Track } from '../types';
import { SETTINGS_ID } from '../types';
import { db } from './db';
import { seedIfEmpty } from './seed';

export const OWNER_KEY = 'account:owner';

/** kv entries about this device, not a person: they stay when the account data goes. */
const DEVICE_KV: readonly RegExp[] = [
  /^player:prefs$/,
  /^devicemusic:/,
  /^radiobrowser:servers$/,
  /^update:/,
  /^ui:/,
  /^migrat(e|ion):/,
  // the user id that already picked a plan (checked against whoever signs in, holds nothing else)
  /^online:planChosen$/,
];

/** Tracks that live on this device only (files added here, device music folders): never synced, never removed. */
export const isDeviceTrack = (t: Pick<Track, 'source'>): boolean => t.source === 'local' || t.source === 'device';

const isDeviceKv = (id: string) => DEVICE_KV.some((re) => re.test(id));

/** The account this device's data belongs to (undefined: never signed in, or signed out since). */
export async function dataOwner(): Promise<string | undefined> {
  const rec = (await db.kv.get(OWNER_KEY)) as KvRecord<{ userId: string }> | undefined;
  return rec?.value?.userId || undefined;
}

export async function setDataOwner(userId: string | undefined): Promise<void> {
  if (!userId) return db.kv.delete(OWNER_KEY);
  if ((await dataOwner()) === userId) return;
  const now = Date.now();
  await db.kv.put({ id: OWNER_KEY, value: { userId }, fetchedAt: now, createdAt: now, updatedAt: now });
}

/**
 * Removes the account data from this device and seeds a clean first run (starter hosts and station, blank profile,
 * default settings with this device's theme and server). `keepKv` names kv entries to keep as well (the session when
 * the account signing in stays signed in).
 */
export async function clearAccountData(opts: { keepKv?: readonly string[]; now?: number } = {}): Promise<void> {
  const keep = new Set(opts.keepKv ?? []);
  const now = opts.now ?? Date.now();
  const personal = [db.hosts, db.stations, db.brains, db.voices, db.breaks, db.profile, db.memories, db.tracker, db.journal, db.playlists];
  await db.transaction('rw', [...personal, db.settings, db.tracks, db.blobs, db.kv], async () => {
    const prev = await db.settings.get(SETTINGS_ID);
    for (const table of personal) await table.clear();
    await db.settings.clear();
    await db.tracks.filter((t) => !isDeviceTrack(t)).delete();
    // files and covers of the songs that stay; the rest (service covers, playlist covers, host pictures) goes
    const used = new Set<string>();
    await db.tracks.each((t) => {
      if (t.source === 'local' && t.ref) used.add(t.ref);
      if (t.artworkId) used.add(t.artworkId);
    });
    await db.blobs.filter((b) => !used.has(b.id)).delete();
    await db.kv.filter((r) => !isDeviceKv(r.id) && !keep.has(r.id)).delete();
    await seedIfEmpty(db, now);
    if (prev) await db.settings.update(SETTINGS_ID, { theme: prev.theme, serverUrl: prev.serverUrl });
  });
}
