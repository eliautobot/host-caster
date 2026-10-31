// YouTube videos -> Host-Caster tracks (source 'youtube', ref = videoId). Titles like "Artist - Song (Official Video)"
// are split so the hosts can talk about the artist and the song.
import { markUnplayable } from '../../player/unplayable';
import type { Playlist, Track } from '../../types';
import { storeArtMany, upsertImportedPlaylist, upsertTracks, type TrackDraft } from '../imports';
import { ytPlaylistAll, type YtPlaylist, type YtVideo, type YtWholePlaylist } from './api';

const NOISE =
  /\s*[([](?:official\s*(?:music\s*)?(?:video|audio|visualizer|lyric(?:s)?\s*video)|lyrics?(?:\s*video)?|audio|hd|hq|4k|remastered(?:\s*\d{4})?|music\s*video|mv|visualizer|video\s*oficial|clip\s*officiel)[)\]]/gi;

/** "Daft Punk - One More Time (Official Video)" -> { artist: 'Daft Punk', title: 'One More Time' } */
export function splitVideoTitle(raw: string, channel: string): { title: string; artist: string } {
  const cleaned = raw.replace(NOISE, '').replace(/\s*\|\s*.*$/, '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(cleaned);
  if (m) {
    const artist = m[1]!.trim();
    const title = m[2]!.replace(/^["“](.*)["”]$/, '$1').trim();
    if (artist && title) return { artist, title };
  }
  const ch = channel.replace(/\s*(VEVO|- Topic|Official)$/i, '').trim();
  return { title: cleaned || raw.trim() || 'Untitled', artist: ch || 'YouTube' };
}

export const youtubeArtId = (videoId: string) => `art:youtube:${videoId}`;

export function videoToDraft(v: YtVideo, artworkId?: string, liked?: boolean): TrackDraft {
  const { title, artist } = splitVideoTitle(v.title, v.channel);
  return {
    title,
    artist,
    album: '',
    albumArtist: v.channel || undefined,
    durationMs: Math.max(0, v.durationMs ?? 0),
    artworkId,
    artUrl: v.thumbnail || thumbUrl(v.videoId),
    source: 'youtube',
    ref: v.videoId,
    liked: liked || undefined,
  };
}

/** Thumbnail URL when the server did not send one. */
export const thumbUrl = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/** Up to this many videos the covers are stored on the device while importing; longer lists show them from YouTube. */
const STORE_ART_MAX = 500;

export async function importVideos(videos: YtVideo[], opts: { liked?: boolean } = {}): Promise<Track[]> {
  const arts =
    videos.length <= STORE_ART_MAX
      ? await storeArtMany(videos.map((v) => ({ id: youtubeArtId(v.videoId), url: v.thumbnail || thumbUrl(v.videoId) })))
      : new Map<string, string>();
  const tracks = await upsertTracks(videos.map((v) => videoToDraft(v, arts.get(youtubeArtId(v.videoId)), opts.liked)));
  // the server read YouTube's embeddable flag: stations leave those out instead of trying them on air
  const blocked = new Set(videos.filter((v) => v.embeddable === false).map((v) => v.videoId));
  if (blocked.size) await markUnplayable(tracks.filter((t) => blocked.has(t.ref)), 'The owner of this video does not allow playback outside YouTube.', 101).catch(() => undefined);
  return tracks;
}

export interface YouTubeImport extends Omit<YtWholePlaylist, 'items'> {
  playlist: Playlist;
  tracks: Track[];
}

/**
 * Imports a whole playlist (up to YT_IMPORT_MAX videos, read in steps: onProgress(read, total)) into the library and
 * the playlist that mirrors it. Says what was left out: private, deleted, unavailable, over the limit, and how many
 * cannot play outside YouTube.
 */
export async function importYouTubePlaylist(
  pl: Pick<YtPlaylist, 'id' | 'title' | 'liked' | 'thumbnail'>,
  opts: { onProgress?: (read: number, total?: number) => void } = {},
): Promise<YouTubeImport> {
  const liked = pl.liked || pl.id === 'LL';
  const whole = await ytPlaylistAll(pl.id, { onProgress: opts.onProgress });
  const tracks = await importVideos(whole.items, { liked });
  let coverId = tracks.find((t) => t.artworkId)?.artworkId;
  if (pl.thumbnail) coverId = (await storeArtMany([{ id: `art:youtube-pl:${pl.id}`, url: pl.thumbnail }])).get(`art:youtube-pl:${pl.id}`) ?? coverId;
  const playlist = await upsertImportedPlaylist(`youtube:${pl.id}`, {
    name: liked ? 'Liked videos (YouTube)' : pl.title,
    trackIds: tracks.map((t) => t.id),
    source: 'youtube',
    coverId,
  });
  return { playlist, tracks, total: whole.total, left: whole.left, blocked: whole.blocked };
}
