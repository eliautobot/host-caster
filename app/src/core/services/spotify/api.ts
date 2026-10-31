// Spotify Web API client: bearer token with one refresh-and-retry on 401, Retry-After on 429, 204 = no body.
import { getSpotifyAccessToken, refreshSpotifyTokens, spotifyFetchImpl } from './auth';

export const SPOTIFY_API = 'https://api.spotify.com/v1';

export class SpotifyApiError extends Error {
  override name = 'SpotifyApiError';
  constructor(
    readonly status: number,
    message: string,
    /** Spotify player error reason, e.g. NO_ACTIVE_DEVICE, PREMIUM_REQUIRED, VOLUME_CONTROL_DISALLOW */
    readonly reason?: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SpotifyRequest {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** path is '/me/playlists' or a full https://api.spotify.com/v1/... URL (pagination `next`). */
export async function spotifyApi<T = unknown>(path: string, req: SpotifyRequest = {}): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${SPOTIFY_API}${path}`);
  if (url.origin !== new URL(SPOTIFY_API).origin) throw new Error('Refusing a non-Spotify URL');
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  let token = await getSpotifyAccessToken();
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await spotifyFetchImpl()(url.toString(), {
      method: req.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = (await refreshSpotifyTokens()).accessToken;
      continue;
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(10, Number(res.headers.get('Retry-After')) || 1);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 204 || res.status === 202) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw toError(res.status, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T; // some player endpoints answer 200 with an opaque id string
    }
  }
  throw new SpotifyApiError(429, 'Spotify is busy right now. Try again in a minute.');
}

function toError(status: number, text: string): SpotifyApiError {
  let message = `Spotify answered ${status}`;
  let reason: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: { message?: string; reason?: string; status?: number } };
    message = j.error?.message || message;
    reason = j.error?.reason;
  } catch {
    // not JSON
  }
  if (reason === 'PREMIUM_REQUIRED') message = 'Playing Spotify from Host-Caster needs Spotify Premium.';
  else if (reason === 'NO_ACTIVE_DEVICE') message = 'Open Spotify on one of your devices, then press play here.';
  else if (status === 403 && /user may not be registered|not registered/i.test(message))
    message = 'This Spotify account is not added to your Spotify app (Dashboard > User management).';
  return new SpotifyApiError(status, message, reason);
}
