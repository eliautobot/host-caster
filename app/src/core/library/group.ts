// Albums, artists, sorting and search over the track list (pure).
import type { Track } from '../types';
import { hash53, norm } from './text';

export interface Album {
  id: string;
  title: string;
  artist: string;
  year?: number;
  artworkId?: string;
  tracks: Track[];
  durationMs: number;
  addedAt: number;
}

export interface Artist {
  id: string;
  name: string;
  artworkId?: string;
  tracks: Track[];
  albums: Album[];
}

export type TrackSort = 'added' | 'title' | 'artist' | 'album' | 'plays' | 'recent';

const UNKNOWN_ALBUM = 'Unknown album';
const UNKNOWN_ARTIST = 'Unknown artist';

export const VARIOUS_ARTISTS = 'Various artists';

export const albumArtistOf = (t: Track) => t.albumArtist || t.artist || UNKNOWN_ARTIST;

/** folder of a song imported with its folder ('Mix/CD1/01.mp3' -> 'mix/cd1'), else undefined */
const folderOf = (t: Track) => {
  const p = t.file?.path;
  const i = p ? p.lastIndexOf('/') : -1;
  return i > 0 ? norm(p!.slice(0, i)) : undefined;
};

/**
 * Album identity: the album artist tag when there is one; otherwise songs of one album name in the same folder
 * belong together even with different artists (compilations without tags); otherwise album name + artist.
 */
export function albumIdOf(t: Track): string {
  const by = t.albumArtist ? norm(t.albumArtist) : folderOf(t) ? `dir:${folderOf(t)}` : norm(albumArtistOf(t));
  return `al-${hash53(`${by}\u0000${norm(t.album || UNKNOWN_ALBUM)}`)}`;
}

export function artistIdOf(name: string): string {
  return `ar-${hash53(norm(name || UNKNOWN_ARTIST))}`;
}

/** album order: disc, track number, then title */
export function byAlbumOrder(a: Track, b: Track): number {
  return (
    (a.discNo ?? 1) - (b.discNo ?? 1) ||
    (a.trackNo ?? 9999) - (b.trackNo ?? 9999) ||
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  );
}

export function groupAlbums(tracks: readonly Track[]): Album[] {
  const map = new Map<string, Album>();
  for (const t of tracks) {
    if (t.source === 'stream') continue;
    const id = albumIdOf(t);
    let al = map.get(id);
    if (!al) {
      al = { id, title: t.album || UNKNOWN_ALBUM, artist: albumArtistOf(t), tracks: [], durationMs: 0, addedAt: t.addedAt };
      map.set(id, al);
    }
    al.tracks.push(t);
    if (!t.albumArtist && al.artist !== VARIOUS_ARTISTS && albumArtistOf(t) !== al.artist) al.artist = VARIOUS_ARTISTS;
    al.durationMs += t.durationMs || 0;
    al.addedAt = Math.max(al.addedAt, t.addedAt);
    al.year ??= t.year;
    al.artworkId ??= t.artworkId;
  }
  const out = [...map.values()];
  for (const al of out) al.tracks.sort(byAlbumOrder);
  return out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

export function groupArtists(tracks: readonly Track[]): Artist[] {
  const map = new Map<string, Artist>();
  for (const t of tracks) {
    if (t.source === 'stream') continue;
    const name = t.artist || UNKNOWN_ARTIST;
    const id = artistIdOf(name);
    let ar = map.get(id);
    if (!ar) map.set(id, (ar = { id, name, tracks: [], albums: [] }));
    ar.tracks.push(t);
    ar.artworkId ??= t.artworkId;
  }
  const out = [...map.values()];
  for (const ar of out) ar.albums = groupAlbums(ar.tracks);
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function sortTracks(tracks: readonly Track[], sort: TrackSort): Track[] {
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const list = tracks.slice();
  switch (sort) {
    case 'title':
      return list.sort((a, b) => cmp(a.title, b.title));
    case 'artist':
      return list.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) || byAlbumOrder(a, b));
    case 'album':
      return list.sort((a, b) => cmp(a.album, b.album) || byAlbumOrder(a, b));
    case 'plays':
      return list.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0) || cmp(a.title, b.title));
    case 'recent':
      return list.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || b.addedAt - a.addedAt);
    default:
      return list.sort((a, b) => b.addedAt - a.addedAt);
  }
}

/** Every word must appear in title, artist, album or genre. */
export function searchTracks(tracks: readonly Track[], query: string): Track[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return tracks.slice();
  return tracks.filter((t) => {
    const hay = norm(`${t.title} ${t.artist} ${t.albumArtist ?? ''} ${t.album} ${t.genre ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
}

export function matchesName(name: string, query: string): boolean {
  const words = norm(query).split(' ').filter(Boolean);
  const hay = norm(name);
  return words.length > 0 && words.every((w) => hay.includes(w));
}
