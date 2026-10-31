// Spotify library: your playlists, playlist items, liked songs, search -> Host-Caster tracks (source 'spotify',
// ref = spotify:track:... URI). Handles both the February 2026 Development Mode shapes (/items, `item`,
// playlist `items`) and the classic Extended Quota shapes (/tracks, `track`, playlist `tracks`).
import type { Playlist, Track } from '../../types';
import { storeArtMany, upsertImportedPlaylist, upsertTracks, type TrackDraft } from '../imports';
import { SpotifyApiError, spotifyApi } from './api';
import { rememberSpotifyName } from './auth';

export interface SpotifyImage {
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface SpotifyTrackObject {
  id?: string | null;
  uri: string;
  name: string;
  type?: 'track' | 'episode';
  duration_ms: number;
  is_local?: boolean;
  is_playable?: boolean;
  explicit?: boolean;
  artists?: { name: string }[];
  album?: { id?: string; name?: string; images?: SpotifyImage[]; release_date?: string; artists?: { name: string }[] };
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  description?: string;
  images?: SpotifyImage[] | null;
  owner?: { id?: string; display_name?: string | null };
  collaborative?: boolean;
  /** Development Mode (2026) name */
  items?: { href?: string; total?: number };
  /** classic name */
  tracks?: { href?: string; total?: number };
}

interface Paging<T> {
  items: T[];
  next: string | null;
  total?: number;
}

interface PlaylistItemRow {
  item?: SpotifyTrackObject | null;
  track?: SpotifyTrackObject | null;
  is_local?: boolean;
}

export interface SpotifyProfile {
  id: string;
  display_name?: string | null;
  images?: SpotifyImage[];
}

/** Picks the image closest to `want` px (Spotify lists them large to small). */
export function pickImage(images: SpotifyImage[] | null | undefined, want = 300): string | undefined {
  if (!images?.length) return undefined;
  const sized = images.filter((i) => i.width);
  if (!sized.length) return images[0]!.url;
  return sized.reduce((best, i) => (Math.abs(i.width! - want) < Math.abs(best.width! - want) ? i : best)).url;
}

export function playlistTrackCount(p: SpotifyPlaylistSummary): number {
  return p.items?.total ?? p.tracks?.total ?? 0;
}

export function trackToDraft(t: SpotifyTrackObject, artworkId?: string, liked?: boolean): TrackDraft {
  const year = Number(t.album?.release_date?.slice(0, 4));
  return {
    title: t.name || 'Untitled',
    artist: t.artists?.map((a) => a.name).join(', ') || 'Unknown artist',
    album: t.album?.name ?? '',
    albumArtist: t.album?.artists?.map((a) => a.name).join(', ') || undefined,
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    durationMs: Math.max(0, t.duration_ms || 0),
    artworkId,
    // public album cover (other devices of the account show it)
    artUrl: pickImage(t.album?.images, 300),
    source: 'spotify',
    ref: t.uri,
    liked: liked || undefined,
  };
}

/** Playable Spotify tracks only (no local files, no podcast episodes, no greyed-out tracks). */
export function playableTracks(rows: (SpotifyTrackObject | null | undefined)[]): SpotifyTrackObject[] {
  return rows.filter(
    (t): t is SpotifyTrackObject =>
      Boolean(t) && !t!.is_local && (t!.type ?? 'track') === 'track' && t!.uri?.startsWith('spotify:track:') && t!.is_playable !== false,
  );
}

async function collect<T>(first: string, query: Record<string, string | number> = {}, max = 2000): Promise<T[]> {
  const out: T[] = [];
  let page = await spotifyApi<Paging<T>>(first, { query });
  out.push(...page.items);
  while (page.next && out.length < max) {
    page = await spotifyApi<Paging<T>>(page.next);
    out.push(...page.items);
  }
  return out.slice(0, max);
}

export async function spotifyProfile(): Promise<SpotifyProfile> {
  const me = await spotifyApi<SpotifyProfile>('/me');
  await rememberSpotifyName(me.display_name || me.id);
  return me;
}

export function listSpotifyPlaylists(): Promise<SpotifyPlaylistSummary[]> {
  return collect<SpotifyPlaylistSummary>('/me/playlists', { limit: 50 }, 500);
}

/** Items of a playlist you own or collaborate on (Development Mode apps cannot read other people's playlists). */
export async function spotifyPlaylistTracks(id: string): Promise<SpotifyTrackObject[]> {
  const path = `/playlists/${encodeURIComponent(id)}`;
  let rows: PlaylistItemRow[];
  try {
    rows = await collect<PlaylistItemRow>(`${path}/items`, { limit: 50, additional_types: 'track' });
  } catch (err) {
    // older/extended-quota API generations only have /tracks
    if (!(err instanceof SpotifyApiError) || (err.status !== 404 && err.status !== 400)) {
      if (err instanceof SpotifyApiError && err.status === 403)
        throw new SpotifyApiError(403, 'Spotify only lets this app read playlists you own or collaborate on.');
      throw err;
    }
    rows = await collect<PlaylistItemRow>(`${path}/tracks`, { limit: 50 });
  }
  return playableTracks(rows.map((r) => r.item ?? r.track));
}

export async function spotifyLikedTracks(max = 2000): Promise<SpotifyTrackObject[]> {
  const rows = await collect<{ track?: SpotifyTrackObject; item?: SpotifyTrackObject }>('/me/tracks', { limit: 50 }, max);
  return playableTracks(rows.map((r) => r.track ?? r.item));
}

/** Search is capped at 10 results per page by Spotify (2026). */
export async function searchSpotify(q: string, limit = 10): Promise<SpotifyTrackObject[]> {
  if (!q.trim()) return [];
  const r = await spotifyApi<{ tracks?: Paging<SpotifyTrackObject> }>('/search', {
    query: { q: q.trim(), type: 'track', limit: Math.min(10, limit) },
  });
  return playableTracks(r.tracks?.items ?? []);
}

export const spotifyArtId = (albumId: string) => `art:spotify:${albumId}`;

export async function importSpotifyTracks(tracks: SpotifyTrackObject[], opts: { liked?: boolean } = {}): Promise<Track[]> {
  const arts = await storeArtMany(
    tracks
      .filter((t) => t.album?.id && t.album.images?.length)
      .map((t) => ({ id: spotifyArtId(t.album!.id!), url: pickImage(t.album!.images, 300)! })),
  );
  return upsertTracks(
    tracks.map((t) => trackToDraft(t, t.album?.id ? arts.get(spotifyArtId(t.album.id)) : undefined, opts.liked)),
  );
}

export async function importSpotifyPlaylist(p: Pick<SpotifyPlaylistSummary, 'id' | 'name' | 'description' | 'images'>) {
  const tracks = await importSpotifyTracks(await spotifyPlaylistTracks(p.id));
  const cover = pickImage(p.images, 300);
  const coverId = cover ? (await storeArtMany([{ id: `art:spotify-pl:${p.id}`, url: cover }])).get(`art:spotify-pl:${p.id}`) : undefined;
  const playlist: Playlist = await upsertImportedPlaylist(`spotify:${p.id}`, {
    name: p.name,
    description: stripHtml(p.description) || undefined,
    trackIds: tracks.map((t) => t.id),
    source: 'spotify',
    coverId: coverId ?? tracks.find((t) => t.artworkId)?.artworkId,
  });
  return { playlist, tracks };
}

/** Liked Songs as tracks marked liked, mirrored into a "Liked Songs (Spotify)" playlist. */
export async function importSpotifyLiked(max = 2000) {
  const tracks = await importSpotifyTracks(await spotifyLikedTracks(max), { liked: true });
  const playlist = await upsertImportedPlaylist('spotify:liked', {
    name: 'Liked Songs (Spotify)',
    trackIds: tracks.map((t) => t.id),
    source: 'spotify',
    coverId: tracks.find((t) => t.artworkId)?.artworkId,
  });
  return { playlist, tracks };
}

function stripHtml(s: string | undefined): string {
  return (s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}
