// Spotify is built against the documented API and tested with recorded-shape fixtures (no live account).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSettings, initDb, kvGet, kvSet } from '../../db';
import type { Track } from '../../types';
import { spotifyApi } from './api';
import {
  beginSpotifyLogin,
  completeSpotifyLogin,
  disconnectSpotify,
  getSpotifyAccessToken,
  loadSpotifyTokens,
  parseSpotifyDeepLink,
  refreshSpotifyTokens,
  setSpotifyClientId,
  setSpotifyFetch,
  type SpotifyTokens,
} from './auth';
import { SpotifyAdapter, setSpotifyPrefs } from './adapter';
import { SpotifyConnectAdapter, judgeState } from './connect';
import * as fx from './fixtures';
import { importSpotifyLiked, importSpotifyPlaylist, listSpotifyPlaylists, pickImage, playlistTrackCount, spotifyPlaylistTracks } from './library';
import { base64Url, buildAuthorizeUrl, challengeFor, randomVerifier, redirectUriProblem } from './pkce';
import { captureSpotifyRedirect } from './redirect';
import { SpotifySdkAdapter, type SdkPlayer, type SdkPlayerCtor, type SdkState } from './sdk';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
interface Call {
  method: string;
  url: URL;
  body?: string;
  auth?: string;
}

function fakeNet(handler: Handler) {
  const calls: Call[] = [];
  setSpotifyFetch(async (u, init = {}) => {
    const url = new URL(u);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? String(init.body) : undefined, auth: headers.Authorization });
    return handler(url, init);
  });
  return calls;
}

async function seedTokens(over: Partial<SpotifyTokens> = {}) {
  await kvSet<SpotifyTokens>('spotify:tokens', {
    accessToken: 'tok-1',
    refreshToken: 'ref-1',
    expiresAt: Date.now() + 3600_000,
    scope: '',
    clientId: CLIENT_ID,
    ...over,
  });
  setSpotifyFetch(undefined); // drop the in-memory token cache
}

beforeEach(async () => {
  await db.delete();
  await initDb();
  setSpotifyFetch(undefined);
});

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('makes valid verifiers', () => {
    const v = randomVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(randomVerifier()).not.toBe(v);
    expect(() => randomVerifier(42)).toThrow();
    expect(base64Url(new Uint8Array([251, 255]))).toBe('-_8');
  });
  it('builds the authorize URL', () => {
    const u = new URL(buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: 'http://127.0.0.1:8666/spotify/callback', challenge: 'ch', state: 'st' }));
    expect(u.origin + u.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: 'ch',
      state: 'st',
      redirect_uri: 'http://127.0.0.1:8666/spotify/callback',
    });
    expect(u.searchParams.get('scope')).toContain('streaming');
    expect(u.searchParams.get('scope')).toContain('user-library-read');
  });
  it('knows the redirect URI rules', () => {
    expect(redirectUriProblem('https://radio.example.com/spotify/callback')).toBeUndefined();
    expect(redirectUriProblem('http://127.0.0.1:8660/spotify/callback')).toBeUndefined();
    expect(redirectUriProblem('hostcaster://spotify')).toBeUndefined();
    expect(redirectUriProblem('http://localhost:8660/spotify/callback')).toMatch(/localhost/);
    expect(redirectUriProblem('http://192.168.1.5:8660/spotify/callback')).toMatch(/https/);
  });
});

describe('sign-in', () => {
  it('validates the client id', async () => {
    await expect(setSpotifyClientId('nope')).rejects.toThrow(/32/);
    await setSpotifyClientId(CLIENT_ID);
    expect((await getSettings()).connections.spotify?.clientId).toBe(CLIENT_ID);
  });

  it('runs the PKCE flow: begin -> redirect -> exchange', async () => {
    await setSpotifyClientId(CLIENT_ID);
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:8666', protocol: 'http:', assign });
    try {
      await beginSpotifyLogin();
    } finally {
      vi.unstubAllGlobals();
    }
    const authUrl = new URL(assign.mock.calls[0]![0] as string);
    const state = authUrl.searchParams.get('state')!;
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8666/spotify/callback');
    const pending = (await kvGet<{ verifier: string }>('spotify:pending'))!.value;
    expect(await challengeFor(pending.verifier)).toBe(authUrl.searchParams.get('code_challenge'));

    const calls = fakeNet((url) => {
      expect(url.toString()).toBe('https://accounts.spotify.com/api/token');
      return Response.json(fx.tokenResponse);
    });
    await expect(completeSpotifyLogin({ code: 'c', state: 'wrong' })).rejects.toThrow(/did not match/);
    const tokens = await completeSpotifyLogin({ code: 'the-code', state });
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:8666/spotify/callback',
      client_id: CLIENT_ID,
      code_verifier: pending.verifier,
    });
    expect(form.has('client_secret')).toBe(false);
    expect(tokens.accessToken).toBe('BQD-access-1');
    expect(tokens.refreshToken).toBe('AQD-refresh-1');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect((await getSettings()).connections.spotify).toMatchObject({ connected: true, clientId: CLIENT_ID });
    expect(await kvGet('spotify:pending')).toBeUndefined();
    // the code is single use: a replay finds no pending login
    await expect(completeSpotifyLogin({ code: 'the-code', state })).rejects.toThrow(/expired/);
  });

  it('reports a cancelled sign-in', async () => {
    await expect(completeSpotifyLogin({ error: 'access_denied', state: 'x' })).rejects.toThrow(/cancelled/);
  });
});

describe('tokens', () => {
  it('returns a fresh token without network', async () => {
    await seedTokens();
    const calls = fakeNet(() => new Response('', { status: 500 }));
    expect(await getSpotifyAccessToken()).toBe('tok-1');
    expect(calls.length).toBe(0);
  });

  it('refreshes near expiry, keeps the old refresh token when none comes back, and runs once', async () => {
    await seedTokens({ expiresAt: Date.now() + 10_000 });
    const calls = fakeNet(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({ access_token: 'tok-2', token_type: 'Bearer', expires_in: 3600, scope: '' });
    });
    const [a, b] = await Promise.all([getSpotifyAccessToken(), getSpotifyAccessToken()]);
    expect([a, b]).toEqual(['tok-2', 'tok-2']);
    expect(calls.length).toBe(1);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'ref-1',
      client_id: CLIENT_ID,
    });
    expect((await loadSpotifyTokens())!.refreshToken).toBe('ref-1');
  });

  it('stores a rotated refresh token', async () => {
    await seedTokens({ expiresAt: 0 });
    fakeNet(() => Response.json({ access_token: 'tok-3', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref-2' }));
    await refreshSpotifyTokens();
    expect((await kvGet<SpotifyTokens>('spotify:tokens'))!.value.refreshToken).toBe('ref-2');
  });

  it('disconnects when the refresh token was revoked', async () => {
    await seedTokens({ expiresAt: 0 });
    fakeNet(() => Response.json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, { status: 400 }));
    await expect(getSpotifyAccessToken()).rejects.toThrow(/signed you out/);
    expect(await kvGet('spotify:tokens')).toBeUndefined();
    expect((await getSettings()).connections.spotify?.connected).toBe(false);
  });

  it('API retries once after a 401 with a refreshed token, and waits on 429', async () => {
    await seedTokens();
    let n = 0;
    const calls = fakeNet((url) => {
      if (url.host === 'accounts.spotify.com') return Response.json({ access_token: 'tok-new', expires_in: 3600, token_type: 'Bearer' });
      n++;
      if (n === 1) return Response.json({ error: { status: 401, message: 'The access token expired' } }, { status: 401 });
      if (n === 2) return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      return Response.json({ id: 'me', display_name: 'Me' });
    });
    expect(await spotifyApi<{ id: string }>('/me')).toEqual({ id: 'me', display_name: 'Me' });
    const apiCalls = calls.filter((c) => c.url.host === 'api.spotify.com');
    expect(apiCalls.map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-new', 'Bearer tok-new']);
  });

  it('turns player errors into plain words', async () => {
    await seedTokens();
    fakeNet(() => Response.json({ error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }, { status: 403 }));
    await expect(spotifyApi('/me/player/play', { method: 'PUT' })).rejects.toThrow(/needs Spotify Premium/);
  });

  it('disconnect keeps the client id', async () => {
    await setSpotifyClientId(CLIENT_ID);
    await seedTokens();
    await disconnectSpotify();
    expect(await loadSpotifyTokens()).toBeUndefined();
    expect((await getSettings()).connections.spotify).toEqual({ connected: false, clientId: CLIENT_ID });
  });
});

describe('library', () => {
  beforeEach(async () => {
    await seedTokens();
    const orig = globalThis.fetch;
    // cover art downloads go through global fetch
    globalThis.fetch = (async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }))) as typeof fetch;
    return () => {
      globalThis.fetch = orig;
    };
  });

  const net = () =>
    fakeNet((url) => {
      const p = url.pathname;
      if (p === '/v1/me/playlists') return Response.json(url.searchParams.get('offset') === '50' ? fx.mePlaylistsPage2 : fx.mePlaylistsPage1);
      if (p === '/v1/playlists/pl1/items') return Response.json(fx.playlistItemsNew);
      if (p === '/v1/playlists/pl2/items') return Response.json({ error: { status: 404, message: 'Not found' } }, { status: 404 });
      if (p === '/v1/playlists/pl2/tracks') return Response.json(fx.playlistTracksClassic);
      if (p === '/v1/me/tracks') return Response.json(fx.savedTracks);
      return Response.json({ error: { status: 404, message: 'no route ' + p } }, { status: 404 });
    });

  it('pages through playlists and reads both count shapes', async () => {
    net();
    const lists = await listSpotifyPlaylists();
    expect(lists.map((l) => [l.name, playlistTrackCount(l)])).toEqual([
      ['Night Drive', 3],
      ['Road Trip', 1],
    ]);
  });

  it('reads /items rows (item) and skips local files and episodes', async () => {
    net();
    const tracks = await spotifyPlaylistTracks('pl1');
    expect(tracks.map((t) => t.name)).toEqual(['Awake', 'Blinding Lights']);
  });

  it('falls back to /tracks rows (track) on older API generations', async () => {
    const calls = net();
    const tracks = await spotifyPlaylistTracks('pl2');
    expect(tracks.map((t) => t.name)).toEqual(['Blinding Lights']);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v1/playlists/pl2/items', '/v1/playlists/pl2/tracks']);
  });

  it('imports a playlist as spotify tracks + a Host-Caster playlist, idempotently', async () => {
    net();
    const first = await importSpotifyPlaylist(fx.mePlaylistsPage1.items[0]!);
    expect(first.tracks.map((t) => [t.title, t.artist, t.album, t.source, t.ref, t.durationMs, t.year])).toEqual([
      ['Awake', 'Tycho', 'Awake', 'spotify', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', 284000, 2019],
      ['Blinding Lights', 'The Weeknd', 'After Hours', 'spotify', 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b', 200040, 2019],
    ]);
    expect(first.tracks[0]!.artworkId).toBe('art:spotify:al1');
    expect(first.playlist).toMatchObject({ name: 'Night Drive', source: 'spotify', description: 'Late night drive & chill' });
    const again = await importSpotifyPlaylist(fx.mePlaylistsPage1.items[0]!);
    expect(again.playlist.id).toBe(first.playlist.id);
    expect(await db.tracks.count()).toBe(2);
  });

  it('imports liked songs as liked, skipping unplayable ones', async () => {
    net();
    const { tracks, playlist } = await importSpotifyLiked();
    expect(tracks.map((t) => [t.title, t.liked])).toEqual([['Awake', true]]);
    expect(playlist.name).toBe('Liked Songs (Spotify)');
  });

  it('picks the closest image size', () => {
    expect(pickImage(fx.trackA.album.images, 300)).toContain('-300');
    expect(pickImage(fx.trackA.album.images, 50)).toContain('-64');
    expect(pickImage([], 300)).toBeUndefined();
  });
});

const track = (over: Partial<Track> = {}): Track => ({
  id: 't1',
  title: 'Awake',
  artist: 'Tycho',
  album: 'Awake',
  durationMs: 284_000,
  source: 'spotify',
  ref: fx.trackA.uri,
  playCount: 0,
  addedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('Connect end detection', () => {
  const ours = { uri: fx.trackA.uri, durationMs: 284_000, lastProgressMs: 100_000, startedAt: 0 };
  const st = (o: Parameters<typeof fx.playbackState>[0]) => fx.playbackState(o) as never;
  it('judges playback states', () => {
    expect(judgeState(st({ progress: 120_000 }), ours, 60_000)).toBe('playing');
    expect(judgeState(st({ playing: false, progress: 120_000 }), ours, 60_000)).toBe('paused');
    expect(judgeState(st({ playing: false, progress: 283_500 }), ours, 60_000)).toBe('ended');
    expect(judgeState(st({ playing: false, progress: 0 }), { ...ours, lastProgressMs: 282_000 }, 60_000)).toBe('ended');
    expect(judgeState(st({ uri: fx.trackB.uri }), { ...ours, lastProgressMs: 280_000 }, 60_000)).toBe('ended');
    expect(judgeState(st({ uri: fx.trackB.uri }), ours, 60_000)).toBe('away');
    // right after play() the device may still report the previous song
    expect(judgeState(st({ uri: fx.trackB.uri }), { ...ours, startedAt: 59_000 }, 60_000)).toBe('paused');
    expect(judgeState(undefined, { ...ours, lastProgressMs: 281_000 }, 60_000)).toBe('ended');
  });
});

describe('SpotifyConnectAdapter', () => {
  afterEach(() => vi.useRealTimers());

  function fakeApi(state: () => unknown) {
    const calls: { path: string; method: string; query?: Record<string, unknown>; body?: unknown }[] = [];
    const api = async <T,>(path: string, req: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}) => {
      calls.push({ path, method: req.method ?? 'GET', query: req.query, body: req.body });
      if (path === '/me/player/devices') return fx.devices as T;
      if (path === '/me/player') return state() as T;
      return undefined as T;
    };
    return { api, calls };
  }

  it('plays on the active device, ticks, and reports the end when the device moves on', async () => {
    vi.useFakeTimers();
    let state: unknown = fx.playbackState({ progress: 0 });
    const { api, calls } = fakeApi(() => state);
    const a = new SpotifyConnectAdapter({ api, pollPlayingMs: 1000 });
    const events: string[] = [];
    a.on('play', () => events.push('play'));
    a.on('ended', () => events.push('ended'));
    a.on('pause', () => events.push('pause'));
    await a.load(track());
    a.seek(5000); // before start: becomes the start position
    await a.play();
    const play = calls.find((c) => c.path === '/me/player/play')!;
    expect(play).toMatchObject({ method: 'PUT', query: { device_id: 'dev-phone' }, body: { uris: [fx.trackA.uri], position_ms: 5000 } });
    expect(a.device).toBe('dev-phone');
    expect(events).toEqual(['play']);

    vi.setSystemTime(Date.now() + 10_000);
    state = fx.playbackState({ progress: 120_000 });
    expect(await a.poll()).toBe('playing');

    // Spotify autoplay rolled on to another song: Host-Caster pauses it and the radio takes over
    vi.setSystemTime(Date.now() + 165_000);
    state = fx.playbackState({ uri: fx.trackB.uri, progress: 1500 });
    expect(await a.poll()).toBe('ended');
    expect(events).toEqual(['play', 'ended']);
    expect(calls.filter((c) => c.path === '/me/player/pause').length).toBe(1);
  });

  it('notices a pause made on the phone', async () => {
    vi.useFakeTimers();
    let state: unknown = fx.playbackState({ progress: 0 });
    const { api } = fakeApi(() => state);
    const a = new SpotifyConnectAdapter({ api });
    const events: string[] = [];
    a.on('pause', () => events.push('pause'));
    await a.load(track());
    await a.play();
    vi.setSystemTime(Date.now() + 30_000);
    state = fx.playbackState({ progress: 30_000, playing: false });
    expect(await a.poll()).toBe('paused');
    expect(events).toEqual(['pause']);
  });

  it('explains when no device is open', async () => {
    const api = async <T,>(path: string) => (path === '/me/player/devices' ? ({ devices: [] } as T) : (undefined as T));
    const a = new SpotifyConnectAdapter({ api });
    await a.load(track());
    await expect(a.play()).rejects.toThrow(/Open Spotify/);
  });

  it('skips volume calls on devices without volume control', async () => {
    const { api, calls } = fakeApi(() => fx.playbackState());
    const a = new SpotifyConnectAdapter({ api });
    await a.load(track());
    await a.play();
    a.volume(0.2); // the phone has supports_volume: false
    expect(calls.some((c) => c.path === '/me/player/volume')).toBe(false);
    a.unload();
  });

  it("leaves the device's own volume alone, and re-sends a duck that landed between songs", async () => {
    const calls: { path: string; query?: Record<string, unknown> }[] = [];
    const api = async <T,>(path: string, req: { query?: Record<string, unknown> } = {}) => {
      calls.push({ path, query: req.query });
      if (path === '/me/player/devices') return { devices: [{ id: 'dev-spk', name: 'Speaker', type: 'Speaker', is_active: true, supports_volume: true }] } as T;
      if (path === '/me/player') return fx.playbackState() as T;
      return undefined as T;
    };
    const volumes = () => calls.filter((c) => c.path === '/me/player/volume').map((c) => c.query?.volume_percent);
    const a = new SpotifyConnectAdapter({ api });
    a.volume(0.85); // the player sets its level before the first song: not sent
    await a.load(track());
    await a.play();
    expect(volumes()).toEqual([]);
    a.volume(0.15); // ducked under a host
    expect(volumes()).toEqual([15]);
    await a.load(track()); // next song starts while the unduck is under way
    a.volume(0.85);
    expect(volumes()).toEqual([15]);
    await a.play();
    expect(volumes()).toEqual([15, 85]);
    a.unload();
  });
});

describe('SpotifySdkAdapter + fallback', () => {
  function fakeSdk(behaviour: 'ready' | 'account_error') {
    const listeners = new Map<string, (p: unknown) => void>();
    const player: SdkPlayer & { volumes: number[] } = {
      volumes: [],
      connect: async () => {
        setTimeout(() => {
          if (behaviour === 'ready') listeners.get('ready')?.({ device_id: 'web-dev' });
          else listeners.get('account_error')?.({ message: 'This functionality is restricted to premium users only' });
        }, 0);
        return true;
      },
      disconnect: () => {},
      addListener: (ev, cb) => (listeners.set(ev, cb as (p: unknown) => void), true),
      getCurrentState: async () => null,
      setVolume: async (v) => void player.volumes.push(v),
      pause: async () => {},
      resume: async () => {},
      seek: async () => {},
      activateElement: async () => {},
    };
    const Ctor = function () {
      return player;
    } as unknown as SdkPlayerCtor;
    return { Ctor, player, emit: (ev: string, p: unknown) => listeners.get(ev)?.(p) };
  }

  it('plays in the browser device and detects the end from SDK state', async () => {
    const sdk = fakeSdk('ready');
    const calls: { path: string; query?: unknown; body?: unknown }[] = [];
    const api = async <T,>(path: string, req: { query?: unknown; body?: unknown } = {}) => (calls.push({ path, ...req }), undefined as T);
    const a = new SpotifySdkAdapter({ api, loadSdk: async () => sdk.Ctor });
    const ended = vi.fn();
    a.on('ended', ended);
    await a.load(track());
    await a.play();
    expect(calls[0]).toMatchObject({ path: '/me/player/play', query: { device_id: 'web-dev' }, body: { uris: [fx.trackA.uri] } });
    const state = (o: Partial<SdkState>): SdkState => ({
      paused: false,
      position: 1000,
      duration: 284_000,
      track_window: { current_track: { uri: fx.trackA.uri, id: fx.trackA.id, name: 'Awake' }, previous_tracks: [], next_tracks: [] },
      ...o,
    });
    a.onState(state({ position: 200_000 }));
    expect(ended).not.toHaveBeenCalled();
    a.onState(
      state({
        paused: true,
        position: 0,
        track_window: { current_track: { uri: fx.trackA.uri, id: fx.trackA.id, name: 'Awake' }, previous_tracks: [{ uri: fx.trackA.uri, id: fx.trackA.id, name: 'Awake' }], next_tracks: [] },
      }),
    );
    expect(ended).toHaveBeenCalledTimes(1);
    a.rampVolume(0.2, 0);
    expect(sdk.player.volumes.at(-1)).toBeCloseTo(0.2);
    a.unload();
  });

  it('falls back to Connect when the account has no Premium (auto mode)', async () => {
    await seedTokens();
    await setSpotifyPrefs({ mode: 'auto' });
    const sdk = fakeSdk('account_error');
    const noop = async <T,>() => undefined as T;
    const sdkAdapter = new SpotifySdkAdapter({ api: noop, loadSdk: async () => sdk.Ctor });
    const connectCalls: string[] = [];
    const connect = new SpotifyConnectAdapter({
      api: async <T,>(path: string) => {
        connectCalls.push(path);
        if (path === '/me/player/devices') return fx.devices as T;
        return undefined as T;
      },
    });
    const w = new SpotifyAdapter({ sdk: sdkAdapter, connect, supported: () => true });
    const errors: Error[] = [];
    w.on('error', (e) => errors.push(e));
    await w.load(track());
    expect(w.backend).toBe('browser');
    await w.play();
    expect(w.backend).toBe('connect');
    expect(connectCalls).toContain('/me/player/play');
    expect(errors[0]?.message).toMatch(/Premium/);
    w.unload();
  });
});

describe('redirect capture', () => {
  it('turns /spotify/callback into the hash route', () => {
    const replace = vi.fn();
    vi.stubGlobal('history', { replaceState: replace });
    try {
      expect(captureSpotifyRedirect({ pathname: '/spotify/callback', search: '?code=abc&state=xyz&junk=1', hash: '' })).toBe(true);
      expect(replace).toHaveBeenCalledWith(null, '', '/#/services/spotify/callback?code=abc&state=xyz');
      expect(captureSpotifyRedirect({ pathname: '/radio/spotify/callback/', search: '?error=access_denied', hash: '' })).toBe(true);
      expect(replace).toHaveBeenLastCalledWith(null, '', '/radio/#/services/spotify/callback?error=access_denied');
      expect(captureSpotifyRedirect({ pathname: '/', search: '', hash: '#/library' })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('native return link', () => {
  it('reads hostcaster://spotify links and ignores others', () => {
    expect(parseSpotifyDeepLink('hostcaster://spotify?code=abc&state=xyz&junk=1')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseSpotifyDeepLink('myradio://spotify/?error=access_denied')).toEqual({ error: 'access_denied' });
    expect(parseSpotifyDeepLink('hostcaster://spotify')).toEqual({});
    expect(parseSpotifyDeepLink('hostcaster://auth?code=abc')).toBeUndefined();
    expect(parseSpotifyDeepLink('hostcaster://spotifyx?code=abc')).toBeUndefined();
    expect(parseSpotifyDeepLink('https://example.com/spotify?code=abc')).toBeUndefined();
  });
});
