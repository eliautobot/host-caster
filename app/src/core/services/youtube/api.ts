// YouTube through the Host-Caster server (it holds the Google tokens): your playlists (incl. Liked videos = 'LL'),
// playlist items, search. Every call explains what is missing when it cannot work.
import { ApiError, api, auth, request } from '../../api';

export interface YtPlaylist {
  id: string;
  title: string;
  count: number;
  thumbnail?: string;
  /** the user's Liked videos */
  liked?: boolean;
}

export interface YtVideo {
  videoId: string;
  title: string;
  channel: string;
  thumbnail?: string;
  /** 0 when the server could not read it */
  durationMs?: number;
  /** false: the owner turned embedding off (it cannot play outside YouTube) */
  embeddable?: boolean;
}

export type YouTubeProblem = 'no-server' | 'signed-out' | 'not-connected' | 'google-off' | 'rate-limited' | 'error';

export class YouTubeAccessError extends Error {
  override name = 'YouTubeAccessError';
  constructor(
    readonly problem: YouTubeProblem,
    message: string,
  ) {
    super(message);
  }
}

/** Maps server errors to what the UI should offer (sign in / connect YouTube / try later). */
export function youTubeProblem(err: unknown): YouTubeAccessError {
  if (err instanceof YouTubeAccessError) return err;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.code === 'not_signed_in')
      return new YouTubeAccessError('signed-out', 'Sign in to your Host-Caster server to use YouTube.');
    if (err.code === 'youtube_not_connected' || err.code === 'google_not_connected' || err.code === 'scope_missing')
      return new YouTubeAccessError('not-connected', 'Allow Host-Caster to read your YouTube playlists.');
    if (err.code === 'google_disabled' || err.code === 'provider_disabled')
      return new YouTubeAccessError('google-off', 'Google sign-in is not set up on this server.');
    if (err.status === 429 || err.code === 'upstream_rate_limited')
      return new YouTubeAccessError('rate-limited', 'YouTube says to slow down. Try again in a few minutes.');
    return new YouTubeAccessError('error', err.message || 'YouTube is not answering right now.');
  }
  if (err instanceof TypeError) return new YouTubeAccessError('no-server', 'Your Host-Caster server is not reachable.');
  return new YouTubeAccessError('error', err instanceof Error ? err.message : String(err));
}

async function call<T>(path: string, timeoutMs = 20000): Promise<T> {
  if (!api.available) {
    throw new YouTubeAccessError('no-server', 'YouTube needs your Host-Caster server (it keeps the Google sign-in). Connect one in Settings > Account.');
  }
  if (api.config && !api.config.signIn.google) {
    throw new YouTubeAccessError('google-off', 'Google sign-in is not set up on this server.');
  }
  try {
    return await request<T>('GET', path, undefined, { timeoutMs });
  } catch (err) {
    throw youTubeProblem(err);
  }
}

export async function ytPlaylists(): Promise<YtPlaylist[]> {
  const r = await call<{ playlists?: YtPlaylist[] }>('/api/google/youtube/playlists');
  const lists = r.playlists ?? [];
  // servers that do not list Liked videos still accept 'LL'
  return lists.some((p) => p.id === 'LL') ? lists : [{ id: 'LL', title: 'Liked videos', count: 0, liked: true }, ...lists];
}

/** Why videos of a playlist were left out: YouTube lists them but they cannot play anywhere. */
export interface YtLeftOut {
  private: number;
  deleted: number;
  /** gone, or nobody may see them */
  unavailable: number;
  /** past the import limit */
  overLimit: number;
}

export interface YtPlaylistPage {
  items: YtVideo[];
  /** the playlist's length as YouTube counts it (incl. private and deleted videos) */
  total?: number;
  next?: string;
  left?: Omit<YtLeftOut, 'overLimit'>;
  /** listed, but the owner does not allow playback outside YouTube (kept, skipped on air) */
  blocked?: number;
}

/** Most videos imported from one playlist. YouTube quota: about 2 units per 50 videos (200 for 5,000). */
export const YT_IMPORT_MAX = 5000;
const PAGE = 500;

/** One step of a playlist (about 500 videos, whole YouTube pages). */
export async function ytPlaylistPage(id: string, pageToken?: string): Promise<YtPlaylistPage> {
  const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const r = await call<YtPlaylistPage>(`/api/google/youtube/playlist/${encodeURIComponent(id)}?paged=1&limit=${PAGE}${token}`, 60000);
  return { ...r, items: (r.items ?? []).filter((v) => v.videoId) };
}

export interface YtWholePlaylist {
  items: YtVideo[];
  total?: number;
  left: YtLeftOut;
  blocked: number;
}

/**
 * The whole playlist, step by step (an older server answers once with what it has). Videos listed twice count once.
 * onProgress(done, total): videos read so far, of the playlist's length.
 */
export async function ytPlaylistAll(id: string, opts: { max?: number; onProgress?: (done: number, total?: number) => void } = {}): Promise<YtWholePlaylist> {
  const max = opts.max ?? YT_IMPORT_MAX;
  const left: YtLeftOut = { private: 0, deleted: 0, unavailable: 0, overLimit: 0 };
  const seen = new Set<string>();
  const items: YtVideo[] = [];
  let total: number | undefined;
  let read = 0;
  let next: string | undefined;
  do {
    const page = await ytPlaylistPage(id, next);
    total ??= page.total;
    for (const v of page.items) {
      if (seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      if (items.length >= max) left.overLimit++;
      else items.push(v);
    }
    left.private += page.left?.private ?? 0;
    left.deleted += page.left?.deleted ?? 0;
    left.unavailable += page.left?.unavailable ?? 0;
    read += page.items.length + (page.left ? page.left.private + page.left.deleted + page.left.unavailable : 0);
    next = page.next;
    opts.onProgress?.(Math.min(read, total ?? read), total);
  } while (next && items.length < max);
  // stopped at the limit: the rest of the list was not read
  if (next && total) left.overLimit += Math.max(0, total - read);
  return { items, total, left, blocked: items.filter((v) => v.embeddable === false).length };
}

/** The first videos of a playlist (one step). */
export async function ytPlaylistItems(id: string): Promise<YtVideo[]> {
  return (await ytPlaylistPage(id)).items;
}

/** "9 left out: 5 private, 4 deleted. 3 cannot play outside YouTube (skipped on air)." */
export function leftOutText(w: Pick<YtWholePlaylist, 'left' | 'blocked'>): string {
  const l = w.left;
  const parts = [
    l.private && `${l.private} private`,
    l.deleted && `${l.deleted} deleted`,
    l.unavailable && `${l.unavailable} unavailable`,
    l.overLimit && `${l.overLimit.toLocaleString()} over the ${YT_IMPORT_MAX.toLocaleString()} limit`,
  ].filter(Boolean);
  const out = l.private + l.deleted + l.unavailable + l.overLimit;
  const lines = [];
  if (out) lines.push(`${out.toLocaleString()} left out: ${parts.join(', ')}.`);
  if (w.blocked) lines.push(`${w.blocked.toLocaleString()} cannot play outside YouTube (skipped on air).`);
  return lines.join(' ');
}

export async function ytSearch(q: string, max = 20): Promise<YtVideo[]> {
  if (!q.trim()) return [];
  const r = await call<{ items?: YtVideo[] }>(`/api/google/youtube/search?q=${encodeURIComponent(q.trim())}&max=${max}`);
  return (r.items ?? []).filter((v) => v.videoId);
}

export type YouTubeStatus = { state: 'ready'; email?: string } | { state: YouTubeProblem; message: string };

const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/** Cheap check (no YouTube quota): GET /api/google/status. */
export async function youTubeStatus(): Promise<YouTubeStatus> {
  try {
    const s = await call<{ connected: boolean; email?: string; scopes?: string[] }>('/api/google/status');
    if (!s.connected) return { state: 'not-connected', message: 'Sign in with Google and allow YouTube.' };
    if (!s.scopes?.includes(YT_SCOPE)) return { state: 'not-connected', message: 'Allow Host-Caster to read your YouTube playlists.' };
    return { state: 'ready', email: s.email };
  } catch (err) {
    const e = youTubeProblem(err);
    return { state: e.problem, message: e.message };
  }
}

/**
 * Asks Google for the YouTube permission (incremental consent). Signed in: adds it to this Host-Caster account (web =
 * cookie + redirect back to Music services; native = link ticket + system browser + deep link). Signed out: signs
 * in with Google and YouTube in one go. Resolves on native once the app is back; on web the page navigates away.
 */
export async function connectYouTube(returnTo = '/settings/music-services'): Promise<void> {
  if (!api.available) throw new YouTubeAccessError('no-server', 'YouTube needs your Host-Caster server. Connect one in Settings > Account.');
  if (api.config && !api.config.signIn.google) throw new YouTubeAccessError('google-off', 'Google sign-in is not set up on this server.');
  await auth.connectGoogle(['youtube'], returnTo);
}

/** YouTube video ids are 11 chars of [A-Za-z0-9_-]. Accepts a full URL too. */
export function parseVideoId(input: string): string | undefined {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12) || undefined;
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = /\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
    return m?.[1];
  } catch {
    return undefined;
  }
}
