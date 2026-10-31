// Subsonic REST client (JSON). Works with any server that speaks the Subsonic API: Navidrome, Airsonic(-Advanced),
// Gonic, Ampache, LMS, Jellyfin (Subsonic plugin). `fetchImpl` is injectable for tests.
import { authParams, type SubsonicAuth } from './auth';
import type {
  AlbumListType,
  SearchResult,
  Starred,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicPlaylist,
  SubsonicServerInfo,
  SubsonicSong,
} from './types';

/** Subsonic error codes we act on. */
export const SUBSONIC_ERR = {
  generic: 0,
  missingParam: 10,
  clientTooOld: 20,
  serverTooOld: 30,
  wrongCredentials: 40,
  tokenNotSupported: 41,
  authMechanismNotSupported: 42,
  multipleAuth: 43,
  invalidApiKey: 44,
  notAuthorized: 50,
  notFound: 70,
} as const;

export class SubsonicError extends Error {
  override name = 'SubsonicError';
  constructor(
    readonly code: number,
    message: string,
    /** HTTP status when the call did not reach the Subsonic layer */
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Old Subsonic JSON returns a lone object instead of a one-item array. */
export function arr<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

interface Envelope {
  'subsonic-response'?: SubsonicServerInfo & {
    status: 'ok' | 'failed';
    error?: { code: number; message?: string };
    [key: string]: unknown;
  };
}

export class SubsonicClient {
  constructor(
    readonly baseUrl: string,
    private auth: SubsonicAuth,
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private timeoutMs = 15000,
  ) {}

  /** Full URL for a method (used for stream / cover art, which the browser loads directly). */
  url(method: string, params: Record<string, string | number | undefined> = {}): string {
    const q = new URLSearchParams(authParams(this.auth));
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return `${this.baseUrl}/rest/${method}?${q.toString()}`;
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, string | number | undefined> = {}) {
    const url = this.url(method, { ...params, f: 'json' });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), credentials: 'omit' });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new SubsonicError(-1, `The server ${reason}. Check the address, and that it allows this app (CORS).`);
    }
    if (!res.ok) {
      const hint = res.status === 404 ? ' Is this a Subsonic-compatible server?' : '';
      throw new SubsonicError(-1, `The server answered ${res.status}.${hint}`, res.status);
    }
    let body: Envelope;
    try {
      body = (await res.json()) as Envelope;
    } catch {
      throw new SubsonicError(-1, 'The server did not answer with Subsonic JSON. Is this the right address?');
    }
    const r = body['subsonic-response'];
    if (!r) throw new SubsonicError(-1, 'Not a Subsonic response. Is this the right address?');
    if (r.status !== 'ok') {
      const code = r.error?.code ?? 0;
      throw new SubsonicError(code, friendlyMessage(code, r.error?.message));
    }
    return r as unknown as SubsonicServerInfo & T;
  }

  async ping(): Promise<SubsonicServerInfo> {
    const r = await this.call('ping');
    return { version: r.version, type: r.type, serverVersion: r.serverVersion, openSubsonic: r.openSubsonic };
  }

  async playlists(): Promise<SubsonicPlaylist[]> {
    const r = await this.call<{ playlists?: { playlist?: SubsonicPlaylist[] } }>('getPlaylists');
    return arr(r.playlists?.playlist);
  }

  async playlist(id: string): Promise<SubsonicPlaylist> {
    const r = await this.call<{ playlist: SubsonicPlaylist }>('getPlaylist', { id });
    return { ...r.playlist, entry: arr(r.playlist.entry) };
  }

  async albumList(type: AlbumListType, size = 40, offset = 0): Promise<SubsonicAlbum[]> {
    const r = await this.call<{ albumList2?: { album?: SubsonicAlbum[] } }>('getAlbumList2', { type, size, offset });
    return arr(r.albumList2?.album);
  }

  async album(id: string): Promise<SubsonicAlbum> {
    const r = await this.call<{ album: SubsonicAlbum }>('getAlbum', { id });
    return { ...r.album, song: arr(r.album.song) };
  }

  async artists(): Promise<SubsonicArtist[]> {
    const r = await this.call<{ artists?: { index?: { artist?: SubsonicArtist[] }[] } }>('getArtists');
    return arr(r.artists?.index).flatMap((ix) => arr(ix.artist));
  }

  async artist(id: string): Promise<SubsonicArtist> {
    const r = await this.call<{ artist: SubsonicArtist }>('getArtist', { id });
    return { ...r.artist, album: arr(r.artist.album) };
  }

  async starred(): Promise<Starred> {
    const r = await this.call<{ starred2?: { artist?: SubsonicArtist[]; album?: SubsonicAlbum[]; song?: SubsonicSong[] } }>(
      'getStarred2',
    );
    return { artists: arr(r.starred2?.artist), albums: arr(r.starred2?.album), songs: arr(r.starred2?.song) };
  }

  async search(query: string, counts = { artist: 8, album: 12, song: 40 }): Promise<SearchResult> {
    const r = await this.call<{
      searchResult3?: { artist?: SubsonicArtist[]; album?: SubsonicAlbum[]; song?: SubsonicSong[] };
    }>('search3', { query, artistCount: counts.artist, albumCount: counts.album, songCount: counts.song });
    const s = r.searchResult3;
    return { artists: arr(s?.artist), albums: arr(s?.album), songs: arr(s?.song) };
  }

  async randomSongs(size = 50): Promise<SubsonicSong[]> {
    const r = await this.call<{ randomSongs?: { song?: SubsonicSong[] } }>('getRandomSongs', { size });
    return arr(r.randomSongs?.song);
  }

  /** Report a play to the server (submission=false = "now playing"). Best effort. */
  async scrobble(id: string, submission = true): Promise<void> {
    await this.call('scrobble', { id, submission: String(submission), time: Date.now() }).catch(() => undefined);
  }

  streamUrl(id: string, opts: { maxBitRate?: number; format?: string } = {}): string {
    return this.url('stream', { id, maxBitRate: opts.maxBitRate, format: opts.format });
  }

  coverArtUrl(id: string, size?: number): string {
    return this.url('getCoverArt', { id, size });
  }
}

function friendlyMessage(code: number, serverMessage?: string): string {
  switch (code) {
    case SUBSONIC_ERR.wrongCredentials:
      return 'Wrong username or password.';
    case SUBSONIC_ERR.tokenNotSupported:
    case SUBSONIC_ERR.authMechanismNotSupported:
      return 'This server does not support token sign-in.';
    case SUBSONIC_ERR.notAuthorized:
      return 'This user is not allowed to do that on the server.';
    case SUBSONIC_ERR.notFound:
      return 'Not found on the server.';
    case SUBSONIC_ERR.clientTooOld:
      return 'The server needs a newer client protocol.';
    case SUBSONIC_ERR.serverTooOld:
      return 'The server is too old (needs Subsonic API 1.13 or newer).';
    default:
      return serverMessage || `Server error ${code}`;
  }
}
