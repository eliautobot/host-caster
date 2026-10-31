import type { BlobRecord, Draft, Playlist, Track } from '../types';
import { db } from './db';
import { stamp } from './stamp';

export function listTracks(): Promise<Track[]> {
  return db.tracks.orderBy('addedAt').reverse().toArray();
}

export function countTracks(): Promise<number> {
  return db.tracks.count();
}

export function getTrack(id: string): Promise<Track | undefined> {
  return db.tracks.get(id);
}

export async function saveTracks(tracks: (Draft<Track> | Track)[]): Promise<Track[]> {
  const now = Date.now();
  const recs = tracks.map((t) => stamp<Track>(t, now));
  await db.tracks.bulkPut(recs);
  return recs;
}

export function deleteTrack(id: string): Promise<void> {
  return db.tracks.delete(id);
}

export function listPlaylists(): Promise<Playlist[]> {
  return db.playlists.orderBy('name').toArray();
}

export function getPlaylist(id: string): Promise<Playlist | undefined> {
  return db.playlists.get(id);
}

export async function savePlaylist(playlist: Draft<Playlist> | Playlist): Promise<Playlist> {
  const rec = stamp<Playlist>(playlist);
  await db.playlists.put(rec);
  return rec;
}

export function deletePlaylist(id: string): Promise<void> {
  return db.playlists.delete(id);
}

export async function putBlob(blob: Blob, id?: string): Promise<BlobRecord> {
  const rec = stamp<BlobRecord>({ id, blob, mime: blob.type || 'application/octet-stream', size: blob.size });
  await db.blobs.put(rec);
  return rec;
}

export function getBlob(id: string): Promise<BlobRecord | undefined> {
  return db.blobs.get(id);
}

export function deleteBlob(id: string): Promise<void> {
  return db.blobs.delete(id);
}
