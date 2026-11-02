// Likes, deleting songs (with their files and orphaned covers), storage usage.
import { db } from '../db';
import { player } from '../player';
import { releaseArtworkUrl } from '../services/artwork';
import { releaseTrackUrl } from '../services/resolve';
import type { Track } from '../types';
import { noteLiked } from '../memory/journal';

export async function setLiked(track: Track, liked: boolean): Promise<Track> {
  const next: Track = { ...track, liked: liked || undefined, updatedAt: Date.now() };
  const exists = await db.tracks.get(track.id);
  // songs not in the library yet (a server song played from a list) are saved when liked
  await db.tracks.put(exists ? { ...exists, liked: next.liked, updatedAt: next.updatedAt } : next);
  player.updateTracks([exists ? { ...exists, liked: next.liked } : next]);
  if (liked) void noteLiked(track);
  return next;
}

export function toggleLike(track: Track): Promise<Track> {
  return setLiked(track, !track.liked);
}

/**
 * Deletes songs everywhere: library, playlists, the queue, their audio files and covers nobody else uses.
 * fromSync: the account's other device deleted them; playlists lose them without counting as edited here.
 */
export async function deleteTracks(ids: string[], opts: { fromSync?: boolean } = {}): Promise<void> {
  if (!ids.length) return;
  const gone = new Set(ids);
  const rows = (await db.tracks.bulkGet(ids)).filter((t): t is Track => Boolean(t));
  const audioBlobs = rows.filter((t) => t.source === 'local').map((t) => t.ref);
  const arts = [...new Set(rows.map((t) => t.artworkId).filter((a): a is string => Boolean(a)))];
  await player.removeTracks(ids);
  await db.transaction('rw', [db.tracks, db.blobs, db.playlists], async () => {
    await db.tracks.bulkDelete(ids);
    await db.blobs.bulkDelete(audioBlobs);
    await db.playlists
      .filter((p) => p.trackIds.some((t) => gone.has(t)))
      .modify((p) => {
        p.trackIds = p.trackIds.filter((t) => !gone.has(t));
        if (!opts.fromSync) p.updatedAt = Date.now();
      });
    for (const art of arts) {
      const used = await db.tracks.filter((t) => t.artworkId === art).first();
      const cover = await db.playlists.filter((p) => p.coverId === art).first();
      if (!used && !cover) await db.blobs.delete(art);
    }
  });
  audioBlobs.forEach(releaseTrackUrl);
  arts.forEach(releaseArtworkUrl);
}

export interface StorageUsage {
  /** audio + covers stored by Host-Caster */
  libraryBytes: number;
  /** what the browser reports for the whole site */
  usage?: number;
  quota?: number;
  persisted?: boolean;
}

export async function storageUsage(): Promise<StorageUsage> {
  let libraryBytes = 0;
  await db.blobs.each((b) => {
    libraryBytes += b.size || 0;
  });
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  const persisted = await navigator.storage?.persisted?.().catch(() => undefined);
  return { libraryBytes, usage: est?.usage, quota: est?.quota, persisted };
}
