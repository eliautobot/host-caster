// Subsonic songs -> Host-Caster tracks (source 'subsonic', ref = server song id). Covers are cached as blobs.
import type { Playlist, Track } from '../../types';
import { storeArtMany, upsertImportedPlaylist, upsertTracks, type TrackDraft } from '../imports';
import type { SubsonicClient } from './client';
import type { SubsonicSong } from './types';

export const subsonicArtId = (coverArt: string) => `art:subsonic:${coverArt}`;

export function songToDraft(song: SubsonicSong, artworkId?: string, liked?: boolean): TrackDraft {
  return {
    title: song.title?.trim() || 'Untitled',
    artist: song.artist?.trim() || 'Unknown artist',
    album: song.album?.trim() || '',
    albumArtist: song.displayAlbumArtist || undefined,
    year: song.year || undefined,
    genre: song.genre || undefined,
    durationMs: Math.max(0, Math.round((song.duration ?? 0) * 1000)),
    artworkId,
    source: 'subsonic',
    ref: song.id,
    liked: liked || Boolean(song.starred) || undefined,
  };
}

export interface ImportOptions {
  /** mark as liked (starred import) */
  liked?: boolean;
  /** download covers (default true) */
  art?: boolean;
}

export async function importSongs(client: SubsonicClient, songs: SubsonicSong[], opts: ImportOptions = {}) {
  const audio = songs.filter((s) => !s.isVideo && s.type !== 'video');
  let arts = new Map<string, string>();
  if (opts.art !== false) {
    const wanted = audio
      .filter((s) => s.coverArt)
      .map((s) => ({ id: subsonicArtId(s.coverArt!), url: client.coverArtUrl(s.coverArt!, 512) }));
    arts = await storeArtMany(wanted);
  }
  return upsertTracks(
    audio.map((s) => songToDraft(s, s.coverArt ? arts.get(subsonicArtId(s.coverArt)) : undefined, opts.liked)),
  );
}

/** Imports a server playlist as a Host-Caster playlist (source 'subsonic'); re-import refreshes it. */
export async function importSubsonicPlaylist(client: SubsonicClient, id: string): Promise<{ playlist: Playlist; tracks: Track[] }> {
  const pl = await client.playlist(id);
  const tracks = await importSongs(client, pl.entry ?? []);
  const playlist = await upsertImportedPlaylist(`subsonic:${client.baseUrl}:${id}`, {
    name: pl.name,
    description: pl.comment || undefined,
    trackIds: tracks.map((t) => t.id),
    source: 'subsonic',
    coverId: tracks.find((t) => t.artworkId)?.artworkId,
  });
  return { playlist, tracks };
}

export async function importSubsonicAlbum(client: SubsonicClient, id: string): Promise<Track[]> {
  const album = await client.album(id);
  return importSongs(client, album.song ?? []);
}

/** Starred songs plus the songs of starred albums, all marked liked. */
export async function importSubsonicStarred(client: SubsonicClient): Promise<Track[]> {
  const starred = await client.starred();
  const albumSongs: SubsonicSong[] = [];
  for (const a of starred.albums.slice(0, 50)) {
    try {
      albumSongs.push(...((await client.album(a.id)).song ?? []));
    } catch {
      // skip albums that vanished
    }
  }
  return importSongs(client, [...starred.songs, ...albumSongs], { liked: true });
}
