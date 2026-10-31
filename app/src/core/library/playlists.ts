// Playlists: create, rename, add/remove/reorder songs, import and export M3U/PLS.
import { serverLibrary } from '../api';
import { db, getPlaylist, savePlaylist } from '../db';
import type { Playlist, Track } from '../types';
import { moveItem } from '../player/queue';
import { exportM3U, isUrl, matchEntries, parsePlaylistFile, type EntryMatch } from './m3u';
import { addStreams } from './streams';

export async function createPlaylist(name: string, trackIds: string[] = [], description?: string): Promise<Playlist> {
  return savePlaylist({ name: name.trim() || 'New playlist', description: description?.trim() || undefined, trackIds, source: 'local' });
}

export async function updatePlaylist(id: string, patch: Partial<Pick<Playlist, 'name' | 'description' | 'coverId'>>): Promise<void> {
  const p = await getPlaylist(id);
  if (!p) throw new Error('Playlist not found');
  await savePlaylist({ ...p, ...patch, name: (patch.name ?? p.name).trim() || p.name });
}

export async function removePlaylist(id: string): Promise<void> {
  await db.playlists.delete(id);
}

/** Appends songs that are not in the playlist yet. */
export async function addToPlaylist(id: string, trackIds: string[]): Promise<{ added: number; skipped: number }> {
  const p = await getPlaylist(id);
  if (!p) throw new Error('Playlist not found');
  const have = new Set(p.trackIds);
  const fresh = [...new Set(trackIds)].filter((t) => !have.has(t));
  if (fresh.length) await savePlaylist({ ...p, trackIds: [...p.trackIds, ...fresh] });
  return { added: fresh.length, skipped: trackIds.length - fresh.length };
}

export async function removeFromPlaylist(id: string, index: number): Promise<void> {
  const p = await getPlaylist(id);
  if (!p || index < 0 || index >= p.trackIds.length) return;
  await savePlaylist({ ...p, trackIds: p.trackIds.filter((_, i) => i !== index) });
}

export async function reorderPlaylist(id: string, from: number, to: number): Promise<void> {
  const p = await getPlaylist(id);
  if (!p) return;
  await savePlaylist({ ...p, trackIds: moveItem(p.trackIds, from, to) });
}

/** The playlist's songs in order (missing songs skipped). */
export async function playlistTracks(p: Pick<Playlist, 'trackIds'>): Promise<Track[]> {
  const rows = await db.tracks.bulkGet(p.trackIds);
  return rows.filter((t): t is Track => Boolean(t));
}

export interface PlaylistImportResult {
  playlist: Playlist;
  matched: number;
  /** entries no song in the library matched */
  missing: EntryMatch[];
  /** internet streams in the file, added to the library */
  streams: number;
}

/** Imports an M3U/M3U8/PLS file as a playlist, matching entries to library songs (path, file name, tags). */
export async function importPlaylistText(fileName: string, text: string): Promise<PlaylistImportResult> {
  const parsed = parsePlaylistFile(fileName, text);
  if (!parsed.entries.length) throw new Error('No songs found in this playlist file');
  const tracks = await db.tracks.toArray();
  let matches = matchEntries(parsed.entries, tracks);
  // internet radio entries that are not in the library yet become stream tracks
  const urls = matches.filter((m) => !m.track && isUrl(m.entry.location)).map((m) => m.entry);
  let streams = 0;
  if (urls.length) {
    const added = await addStreams(urls.map((e) => ({ url: e.location, name: e.title })));
    streams = added.length;
    matches = matchEntries(parsed.entries, [...tracks, ...added]);
  }
  const ids = matches.flatMap((m) => (m.track ? [m.track.id] : []));
  const playlist = await savePlaylist({ name: parsed.name ?? 'Imported playlist', trackIds: ids, source: 'm3u' });
  return { playlist, matched: ids.length, missing: matches.filter((m) => !m.track), streams };
}

export function playlistToM3U(p: Pick<Playlist, 'name'>, tracks: Track[]): string {
  return exportM3U(p.name, tracks, (id) => new URL(serverLibrary.streamUrl(id), location.href).href);
}
