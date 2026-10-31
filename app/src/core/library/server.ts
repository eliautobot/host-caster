// The Host-Caster server's music library (MUSIC_DIR): synced into `tracks` as source 'server' so its songs work like any
// other (likes, playlists, stations). Off-line or signed out = nothing changes; the last synced list stays.
import { api, serverLibrary } from '../api';
import { db, kvGet, kvSet } from '../db';
import { SERVER_ART_PREFIX } from '../services/artwork';
import type { ServerTrack, Track } from '../types';

const SYNC_KEY = 'library:server:syncedAt';

export const serverTrackId = (id: string) => `srv-${id}`;

/** A server with a music folder, and you are signed in to it. */
export function serverLibraryAvailable(): boolean {
  return api.available && api.signedIn && Boolean(api.config?.serverLibrary);
}

export function serverTrackToTrack(s: ServerTrack, prev?: Track, now = Date.now()): Track {
  return {
    ...(prev ?? {}),
    id: prev?.id ?? serverTrackId(s.id),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    title: s.title,
    artist: s.artist,
    album: s.album,
    albumArtist: s.albumArtist,
    year: s.year,
    genre: s.genre,
    durationMs: s.durationMs,
    artworkId: s.hasArt ? `${SERVER_ART_PREFIX}${s.id}` : undefined,
    source: 'server',
    ref: s.id,
    playCount: prev?.playCount ?? 0,
    addedAt: prev?.addedAt ?? now,
  };
}

export interface ServerSyncResult {
  available: boolean;
  count: number;
  added: number;
  removed: number;
}

/** Pulls the server's track list into the library. Never throws for "no server"; returns available: false. */
export async function syncServerLibrary(): Promise<ServerSyncResult> {
  if (!serverLibraryAvailable()) return { available: false, count: 0, added: 0, removed: 0 };
  const { tracks } = await serverLibrary.tracks();
  const existing = await db.tracks.where('source').equals('server').toArray();
  const byRef = new Map(existing.map((t) => [t.ref, t]));
  const now = Date.now();
  const rows = tracks.map((s) => serverTrackToTrack(s, byRef.get(s.id), now));
  const keep = new Set(tracks.map((s) => s.id));
  const removed = existing.filter((t) => !keep.has(t.ref)).map((t) => t.id);
  await db.transaction('rw', db.tracks, async () => {
    await db.tracks.bulkPut(rows);
    if (removed.length) await db.tracks.bulkDelete(removed);
  });
  await kvSet(SYNC_KEY, now);
  return { available: true, count: rows.length, added: rows.length - (existing.length - removed.length), removed: removed.length };
}

/** Syncs when the last sync is older than `maxAgeMs` (default 10 min). */
export async function syncServerLibraryIfStale(maxAgeMs = 10 * 60_000): Promise<ServerSyncResult | undefined> {
  if (!serverLibraryAvailable()) return undefined;
  const last = await kvGet<number>(SYNC_KEY);
  if (last && Date.now() - last.value < maxAgeMs) return undefined;
  return syncServerLibrary();
}

export async function rescanServerLibrary(): Promise<ServerSyncResult> {
  if (!serverLibraryAvailable()) return { available: false, count: 0, added: 0, removed: 0 };
  await serverLibrary.rescan();
  return syncServerLibrary();
}
