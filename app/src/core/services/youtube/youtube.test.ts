import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../api';
import { db, initDb } from '../../db';
import type { Track } from '../../types';
import { YouTubeAdapter, type YouTubeAdapterOptions, YT_STATE, type YtPlayer, type YtPlayerCtor, type YtPlayerOptions } from './adapter';
import { parseVideoId, youTubeProblem, ytPlaylists } from './api';
import { importYouTubePlaylist, splitVideoTitle, videoToDraft } from './import';

describe('title splitting', () => {
  it.each([
    ['Daft Punk - One More Time (Official Video)', 'Daft Punk', 'One More Time', 'DaftPunkVEVO'],
    ['The Weeknd – Blinding Lights [Official Music Video]', 'The Weeknd', 'Blinding Lights', 'TheWeekndVEVO'],
    ['Nils Frahm - Says (Live) | Tripping with Nils Frahm', 'Nils Frahm', 'Says (Live)', 'Nils Frahm'],
    ['Weightless', 'Marconi Union', 'Weightless', 'Marconi Union - Topic'],
    ['Lo-fi beats to study to (HD)', 'Lofi Girl', 'Lo-fi beats to study to', 'Lofi Girl'],
  ])('%s', (raw, artist, title, channel) => {
    expect(splitVideoTitle(raw, channel)).toEqual({ artist, title });
  });

  it('maps a video to a youtube track', () => {
    expect(videoToDraft({ videoId: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up', channel: 'Rick Astley', durationMs: 213_000 })).toMatchObject({
      source: 'youtube',
      ref: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      durationMs: 213_000,
    });
  });

  it('parses video ids from links', () => {
    expect(parseVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('not a link')).toBeUndefined();
  });
});

describe('server access', () => {
  afterEach(() => {
    api.available = false;
    api.config = undefined;
    vi.unstubAllGlobals();
  });

  it('explains each missing piece', async () => {
    api.available = false;
    await expect(ytPlaylists()).rejects.toMatchObject({ problem: 'no-server' });
    expect(youTubeProblem(new ApiError(401, 'not_signed_in', 'Sign in first')).problem).toBe('signed-out');
    expect(youTubeProblem(new ApiError(409, 'youtube_not_connected', 'x')).problem).toBe('not-connected');
    expect(youTubeProblem(new ApiError(403, 'scope_missing', 'x')).problem).toBe('not-connected');
    expect(youTubeProblem(new ApiError(429, 'upstream_rate_limited', 'x')).problem).toBe('rate-limited');
  });

  it('adds Liked videos when the server does not list it', async () => {
    api.available = true;
    vi.stubGlobal('fetch', async () => Response.json({ playlists: [{ id: 'PL1', title: 'Mine', count: 3 }] }));
    const lists = await ytPlaylists();
    expect(lists.map((l) => l.id)).toEqual(['LL', 'PL1']);
  });

  it('turns a 409 into "connect YouTube"', async () => {
    api.available = true;
    vi.stubGlobal('fetch', async () =>
      Response.json({ error: { code: 'youtube_not_connected', message: 'Sign in with Google to use YouTube' } }, { status: 409 }),
    );
    await expect(ytPlaylists()).rejects.toMatchObject({ problem: 'not-connected' });
  });
});

describe('import', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });
  afterEach(() => {
    api.available = false;
    vi.unstubAllGlobals();
  });

  it('imports Liked videos as liked youtube tracks with cached thumbnails', async () => {
    api.available = true;
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      if (url.includes('/api/google/youtube/playlist/LL'))
        return Response.json({
          items: [
            { videoId: 'aaaaaaaaaaa', title: 'Artist A - Song A (Official Video)', channel: 'ArtistAVEVO', thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg', durationMs: 200_000 },
            { videoId: 'bbbbbbbbbbb', title: 'Song B', channel: 'Artist B - Topic', durationMs: 0 },
          ],
        });
      return new Response(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }));
    });
    const { tracks, playlist } = await importYouTubePlaylist({ id: 'LL', title: 'Liked videos', liked: true });
    expect(tracks.map((t) => [t.title, t.artist, t.liked, t.artworkId])).toEqual([
      ['Song A', 'Artist A', true, 'art:youtube:aaaaaaaaaaa'],
      ['Song B', 'Artist B', true, 'art:youtube:bbbbbbbbbbb'],
    ]);
    expect(playlist).toMatchObject({ name: 'Liked videos (YouTube)', source: 'youtube' });
    expect(seen.some((u) => u.includes('i.ytimg.com/vi/bbbbbbbbbbb/mqdefault.jpg'))).toBe(true);
  });
});

describe('YouTubeAdapter', () => {
  /**
   * Behaves like the real IFrame player where it matters (measured in Chromium): a cue is applied asynchronously and
   * wins, so playVideo() or loadVideoById() sent right after cueVideoById() end with the video cued forever;
   * loadVideoById() alone buffers, then plays.
   */
  function fakeYT(opts2: { lost?: boolean } = {}) {
    let opts: YtPlayerOptions | undefined;
    const calls: string[] = [];
    let state: number = YT_STATE.cued;
    let time = 0;
    let cuePending = false;
    const set = (s: number) => {
      state = s;
      opts?.events?.onStateChange?.({ data: s, target: p });
    };
    const p: YtPlayer = {
      playVideo: () => {
        calls.push('play');
        if (cuePending) return; // lost: the cue lands after it
        setTimeout(() => set(YT_STATE.playing), 0);
      },
      pauseVideo: () => {
        calls.push('pause');
        set(YT_STATE.paused);
      },
      stopVideo: () => calls.push('stop'),
      seekTo: (s) => calls.push(`seek:${s}`),
      setVolume: (v) => calls.push(`vol:${v}`),
      unMute: () => {},
      getCurrentTime: () => time,
      getDuration: () => 213,
      getPlayerState: () => state,
      cueVideoById: ({ videoId }) => {
        calls.push(`cue:${videoId}`);
        cuePending = true;
        setTimeout(() => {
          cuePending = false;
          set(YT_STATE.cued);
        }, 0);
      },
      loadVideoById: ({ videoId, startSeconds }) => {
        calls.push(`load:${videoId}${startSeconds ? `@${startSeconds}` : ''}`);
        if (opts2.lost) return;
        if (cuePending) {
          // buffering, then the cue lands on top of it: stuck on cued
          setTimeout(() => set(YT_STATE.buffering), 0);
          setTimeout(() => set(YT_STATE.cued), 3);
          return;
        }
        setTimeout(() => set(YT_STATE.buffering), 0);
        setTimeout(() => set(YT_STATE.playing), 5);
      },
      destroy: () => {},
    };
    const Ctor = function (_el: HTMLElement, o: YtPlayerOptions) {
      opts = o;
      setTimeout(() => o.events?.onReady?.({ target: p }), 0);
      return p;
    } as unknown as YtPlayerCtor;
    return {
      Ctor,
      calls,
      opts: () => opts!,
      setTime: (s: number) => (time = s),
      fire: (s: number) => set(s),
      error: (code: number) => opts?.events?.onError?.({ data: code }),
      blocked: () => opts?.events?.onAutoplayBlocked?.(),
      raw: () => p,
    };
  }

  const track = (ref: string): Track => ({
    id: ref,
    title: 't',
    artist: 'a',
    album: '',
    durationMs: 0,
    source: 'youtube',
    ref,
    playCount: 0,
    addedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  // host.ts touches the DOM; give the adapter a detached mount and stub the host helpers' document use
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, querySelector: () => null, firstElementChild: {} }),
      body: { appendChild() {} },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const adapter = (yt: ReturnType<typeof fakeYT>, extra: Partial<YouTubeAdapterOptions> = {}) =>
    new YouTubeAdapter({ loadApi: async () => yt.Ctor, mount: () => ({}) as HTMLElement, scoutMount: () => ({}) as HTMLElement, ...extra });

  it('creates the player with a clean embed, plays, reports time, end and errors', async () => {
    const yt = fakeYT();
    const a = adapter(yt);
    const events: string[] = [];
    const times: number[] = [];
    a.on('play', () => events.push('play'));
    a.on('pause', () => events.push('pause'));
    a.on('ended', () => events.push('ended'));
    a.on('error', (e) => events.push(`error:${e.message}`));
    a.on('time', (t) => times.push(t.durationMs));

    await a.load(track('dQw4w9WgXcQ'));
    expect(yt.opts().videoId).toBe('dQw4w9WgXcQ');
    expect(yt.opts().playerVars).toMatchObject({ controls: 0, playsinline: 1, autoplay: 0 });
    a.seek(30_000); // before start: applied on play
    a.volume(0.5);
    await a.play();
    expect(yt.calls).toEqual(['vol:100', 'vol:50', 'vol:50', 'load:dQw4w9WgXcQ@30']); // onReady, volume(), play()
    expect(events).toEqual(['play']);
    expect(times.at(-1)).toBe(213_000);

    a.pause();
    expect(events).toEqual(['play', 'pause']);
    await a.play(); // resume: no reload
    expect(yt.calls.at(-1)).toBe('play');

    yt.fire(YT_STATE.ended);
    expect(events.at(-1)).toBe('ended');
    yt.error(150); // mid-song (started): an event
    expect(events.at(-1)).toBe('error:The owner of this video does not allow playback outside YouTube.');
    a.unload();
    expect(yt.calls.at(-1)).toBe('stop');
  });

  it('ramps volume for ducking', async () => {
    vi.useFakeTimers();
    const yt = fakeYT();
    const a = adapter(yt);
    const loading = a.load(track('dQw4w9WgXcQ'));
    await vi.advanceTimersByTimeAsync(10);
    await loading;
    a.rampVolume(0.18, 400);
    await vi.advanceTimersByTimeAsync(450);
    const vols = yt.calls.filter((c) => c.startsWith('vol:')).map((c) => Number(c.slice(4)));
    expect(vols.at(-1)).toBe(18);
    expect(vols.length).toBeGreaterThan(4); // stepped, not a jump
  });

  it('starts the next video with loadVideoById and no cue in front of it (cue + play/load stays cued forever)', async () => {
    const yt = fakeYT();
    const a = adapter(yt, { startTimeoutMs: 500 });
    await a.load(track('aaaaaaaaaaa'));
    await a.play();
    await a.load(track('bbbbbbbbbbb'));
    await a.play();
    expect(yt.calls.filter((c) => c.endsWith('bbbbbbbbbbb'))).toEqual(['load:bbbbbbbbbbb']);
    await new Promise((r) => setTimeout(r, 400));
    expect(yt.calls).not.toContain('cue:bbbbbbbbbbb'); // the deferred cue was cancelled
  });

  it('a paused load shows the picture (cue), and a later play waits for that cue to land', async () => {
    const yt = fakeYT();
    const a = adapter(yt, { startTimeoutMs: 1000 });
    await a.load(track('aaaaaaaaaaa'));
    await a.play();
    await a.load(track('bbbbbbbbbbb'));
    await new Promise((r) => setTimeout(r, 350));
    expect(yt.calls.at(-1)).toBe('cue:bbbbbbbbbbb');
    await a.play();
    expect(yt.calls.at(-1)).toBe('load:bbbbbbbbbbb');
  });

  it('a start lost behind a cue (buffering, then cued) is sent again', async () => {
    const yt = fakeYT();
    const a = adapter(yt, { retryMs: 200, startTimeoutMs: 2000 });
    await a.load(track('aaaaaaaaaaa'));
    await a.play();
    await a.load(track('bbbbbbbbbbb'));
    yt.raw().cueVideoById({ videoId: 'bbbbbbbbbbb' }); // a cue sneaks in from elsewhere, just before the start
    await a.play();
    expect(yt.calls.filter((c) => c === 'load:bbbbbbbbbbb').length).toBe(2);
  });

  it('ignores the old video pausing and its end while the next one loads', async () => {
    const yt = fakeYT();
    const a = adapter(yt);
    const events: string[] = [];
    a.on('pause', () => events.push('pause'));
    a.on('ended', () => events.push('ended'));
    await a.load(track('aaaaaaaaaaa'));
    await a.play();
    await a.load(track('bbbbbbbbbbb'));
    yt.fire(YT_STATE.paused);
    yt.fire(YT_STATE.ended);
    expect(events).toEqual([]);
  });

  it('rejects play() with an unplayable error when YouTube refuses the video', async () => {
    const yt = fakeYT();
    const a = adapter(yt);
    await a.load(track('xxxxxxxxxxx'));
    const p = a.play();
    yt.error(150);
    await expect(p).rejects.toMatchObject({ kind: 'unplayable', code: 150 });
    // an error before play() (while cueing) rejects the next play() at once
    await a.load(track('yyyyyyyyyyy'));
    yt.error(100);
    await expect(a.play()).rejects.toMatchObject({ kind: 'unplayable', code: 100 });
  });

  it('sends a start that shows no sign of life once more, then gives up as failed', async () => {
    vi.useFakeTimers();
    const yt = fakeYT({ lost: true });
    const a = adapter(yt, { retryMs: 1000, startTimeoutMs: 3000 });
    const loading = a.load(track('aaaaaaaaaaa'));
    await vi.advanceTimersByTimeAsync(10);
    await loading;
    const p = a.play();
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1300);
    expect(yt.calls.filter((c) => c.startsWith('load:'))).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).rejects.toMatchObject({ kind: 'failed' });
  });

  it('asks for a tap when the browser blocks autoplay (no skipping)', async () => {
    const yt = fakeYT({ lost: true });
    const a = adapter(yt);
    await a.load(track('aaaaaaaaaaa'));
    const p = a.play();
    yt.blocked();
    await expect(p).rejects.toMatchObject({ kind: 'needs-gesture' });
  });

  it('ends a song stuck on its last frame', async () => {
    vi.useFakeTimers();
    const yt = fakeYT();
    const a = adapter(yt);
    const ended: string[] = [];
    a.on('ended', () => ended.push('x'));
    const loading = a.load(track('aaaaaaaaaaa'));
    await vi.advanceTimersByTimeAsync(10);
    await loading;
    const p = a.play();
    await vi.advanceTimersByTimeAsync(20);
    await p;
    yt.setTime(212.6); // 0.4 s left, never moves again, no ENDED from YouTube
    await vi.advanceTimersByTimeAsync(2500);
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(ended).toEqual(['x']);
  });

  it('ends a Short that loops back to the start without ENDED (and stops it)', async () => {
    vi.useFakeTimers();
    const yt = fakeYT();
    const a = adapter(yt);
    const events: string[] = [];
    a.on('ended', () => events.push('ended'));
    a.on('pause', () => events.push('pause'));
    const loading = a.load(track('shortshort1'));
    await vi.advanceTimersByTimeAsync(10);
    await loading;
    const p = a.play();
    await vi.advanceTimersByTimeAsync(20);
    await p;
    yt.setTime(211.5);
    await vi.advanceTimersByTimeAsync(300);
    yt.setTime(0.3); // looped
    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual(['ended']); // its pause is not a listener's pause
    expect(yt.calls.at(-1)).toBe('pause');
  });

  it('checks upcoming videos with a hidden player and remembers the verdict', async () => {
    const yt = fakeYT();
    const a = adapter(yt);
    // first check creates the check player for that video; YouTube answers 150 (embedding off)
    const bad = a.probe(track('badbadbad01'));
    await new Promise((r) => setTimeout(r, 5));
    yt.error(150);
    await expect(bad).rejects.toMatchObject({ kind: 'unplayable', code: 150 });
    // a playable one is cued and settles without an error
    const ok = a.probe(track('goodgood001'));
    await expect(ok).resolves.toBeUndefined();
    expect(yt.calls).toContain('cue:goodgood001');
    // known verdicts answer at once, and load() refuses a known-bad video
    await expect(a.probe(track('badbadbad01'))).rejects.toMatchObject({ code: 150 });
    await expect(a.load(track('badbadbad01'))).rejects.toMatchObject({ kind: 'unplayable' });
  });
});
