import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEvents, PlayerAdapter, Track } from '../types';
import { createEmitter } from '../util/emitter';
import { Player } from './player';

/** In-memory adapter: time advances only when the test calls tick(). */
class FakeAdapter implements PlayerAdapter {
  private em = createEmitter<AdapterEvents>();
  track?: Track;
  pos = 0;
  playing = false;
  vol = 1;
  loads: string[] = [];
  constructor(readonly id: string) {}
  canPlay = (t: Track) => t.source === 'local' || t.source === 'stream';
  async load(t: Track) {
    this.track = t;
    this.pos = 0;
    this.loads.push(t.id);
  }
  async play() {
    this.playing = true;
    this.em.emit('play', undefined);
  }
  pause() {
    this.playing = false;
  }
  seek(ms: number) {
    this.pos = ms;
  }
  volume(v: number) {
    this.vol = v;
  }
  on<E extends keyof AdapterEvents>(e: E, cb: (p: AdapterEvents[E]) => void) {
    return this.em.on(e, cb);
  }
  tick(ms: number) {
    if (!this.playing || !this.track) return;
    this.pos += ms;
    this.em.emit('time', { positionMs: this.pos, durationMs: this.track.durationMs });
  }
  end() {
    this.playing = false;
    this.em.emit('ended', undefined);
  }
}

const track = (id: string, sec = 180, source: Track['source'] = 'local'): Track => ({
  id,
  title: id,
  artist: 'A',
  album: 'B',
  durationMs: sec * 1000,
  source,
  ref: id,
  playCount: 0,
  addedAt: 0,
  createdAt: 0,
  updatedAt: 0,
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('player', () => {
  let a: FakeAdapter;
  let b: FakeAdapter;
  let p: Player;

  beforeEach(() => {
    vi.useFakeTimers();
    a = new FakeAdapter('a');
    b = new FakeAdapter('b');
    p = new Player({ graph: null, decks: [a, b], persist: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads paused, plays, emits trackstart and moves on at the end', async () => {
    const starts: string[] = [];
    p.on('trackstart', (t) => starts.push(t.id));
    await p.load([track('one'), track('two')]);
    expect(p.state.status).toBe('paused');
    await p.play();
    expect(p.state.status).toBe('playing');
    a.end();
    await flush();
    expect(p.state.track?.id).toBe('two');
    expect(starts).toEqual(['one', 'two']);
  });

  it("fires 'nearend' 20 s before the end, and at the start for short tracks", async () => {
    const near: string[] = [];
    p.on('nearend', (t) => near.push(t.id));
    await p.playQueue([track('long', 180), track('short', 30)]);
    a.tick(150_000);
    expect(near).toEqual([]);
    a.tick(11_000);
    expect(near).toEqual(['long']);
    a.tick(1000);
    expect(near).toEqual(['long']);
    a.end();
    await flush();
    expect(near).toEqual(['long', 'short']);
  });

  it('runs a break between tracks, then continues', async () => {
    await p.playQueue([track('one'), track('two')]);
    let aired = false;
    p.holdAfterCurrent(async () => {
      expect(p.state.holding).toBe(true);
      await new Promise((r) => setTimeout(r, 5000));
      aired = true;
    });
    a.end();
    await flush();
    expect(p.state.track?.id).toBe('one');
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(aired).toBe(true);
    expect(p.state.holding).toBe(false);
    expect(p.state.track?.id).toBe('two');
    expect(p.state.status).toBe('playing');
  });

  it('a break that throws or stalls for 25 s never leaves silence', async () => {
    await p.playQueue([track('one'), track('two'), track('three')]);
    p.holdAfterCurrent(() => {
      throw new Error('brain down');
    });
    a.end();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('two');

    let signal: AbortSignal | undefined;
    p.holdAfterCurrent((s) => {
      signal = s;
      return new Promise<void>(() => undefined); // never resolves
    });
    a.end();
    await flush();
    await vi.advanceTimersByTimeAsync(24_000);
    expect(p.state.track?.id).toBe('two');
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(p.state.track?.id).toBe('three');
    expect(p.state.status).toBe('playing');
  });

  it('a long break with voice activity runs past 25 s, up to its own maxMs', async () => {
    await p.playQueue([track('one'), track('two'), track('three')]);
    let signal: AbortSignal | undefined;
    const beat = setInterval(() => p.markActivity(), 2000);
    p.holdAfterCurrent(
      (s) => {
        signal = s;
        return new Promise<void>(() => undefined);
      },
      { maxMs: 60_000 },
    );
    a.end();
    await flush();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(signal?.aborted).toBe(false);
    expect(p.state.holding).toBe(true);
    await vi.advanceTimersByTimeAsync(16_000);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(p.state.track?.id).toBe('two');
    expect(p.state.status).toBe('playing');
    clearInterval(beat);
  });

  it('Next during a break skips the break', async () => {
    await p.playQueue([track('one'), track('two')]);
    let aborted = false;
    p.holdAfterCurrent(
      (s) =>
        new Promise<void>((r) => {
          s.addEventListener('abort', () => {
            aborted = true;
            r();
          });
        }),
    );
    a.end();
    await flush();
    expect(p.state.holding).toBe(true);
    await p.next();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(aborted).toBe(true);
    expect(p.state.track?.id).toBe('two');
  });

  it('talk over intro: the break starts the next track ducked, then unducks', async () => {
    await p.playQueue([track('one'), track('two')]);
    p.holdAfterCurrent(async () => {
      await p.introNext(0.2);
      expect(p.state.track?.id).toBe('two');
      expect(p.state.ducked).toBe(true);
      expect(p.mixer.duck.target).toBe(0.2);
    });
    a.end();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(p.state.track?.id).toBe('two');
    expect(p.state.ducked).toBe(false);
    expect(p.mixer.duck.target).toBe(1);
    expect(a.loads).toEqual(['one', 'two']);
  });

  it('a break booked during talk over intro waits for the next song to end', async () => {
    await p.playQueue([track('one'), track('two'), track('three')]);
    let second = false;
    p.holdAfterCurrent(async () => {
      await p.introNext(0.2);
      p.holdAfterCurrent(() => {
        second = true;
      });
    });
    a.end();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(p.state.track?.id).toBe('two');
    expect(p.state.holding).toBe(false);
    expect(second).toBe(false);
    a.end();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(second).toBe(true);
    expect(p.state.track?.id).toBe('three');
  });

  it('ducks plain outputs with volume() steps and honours master volume', async () => {
    await p.playQueue([track('one')]);
    p.setVolume(0.5);
    await vi.advanceTimersByTimeAsync(200);
    expect(a.vol).toBeCloseTo(0.5, 2);
    p.duck(0.2, 400);
    await vi.advanceTimersByTimeAsync(500);
    expect(a.vol).toBeCloseTo(0.1, 2);
    p.unduck(600);
    await vi.advanceTimersByTimeAsync(700);
    expect(a.vol).toBeCloseTo(0.5, 2);
    p.setMuted(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(a.vol).toBe(0);
  });

  it('repeat one replays, prev restarts after 3 s, shuffle keeps current', async () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((x) => track(x));
    await p.playQueue(list, 2);
    p.setRepeat('one');
    a.end();
    await flush();
    expect(p.state.track?.id).toBe('c');
    p.setRepeat('off');
    a.tick(5000);
    await p.prev();
    expect(p.state.track?.id).toBe('c');
    expect(a.pos).toBe(0);
    await p.prev();
    expect(p.state.track?.id).toBe('b');
    p.setShuffle(true);
    expect(p.state.track?.id).toBe('b');
    expect(p.state.index).toBe(0);
    expect(new Set(p.state.queue.map((t) => t.id)).size).toBe(5);
    p.setShuffle(false);
    expect(p.state.queue.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(p.state.track?.id).toBe('b');
  });

  it('skips a song that fails to load', async () => {
    a.load = async (t: Track) => {
      if (t.id === 'bad') throw new Error('gone');
      a.track = t;
    };
    const errors: string[] = [];
    p.on('error', (e) => errors.push(e.message));
    await p.playQueue([track('bad'), track('good')]);
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(errors).toEqual(['gone']);
    expect(p.state.track?.id).toBe('good');
    expect(p.state.status).toBe('playing');
  });

  it('streams are live: no nearend, no seek', async () => {
    const near: string[] = [];
    p.on('nearend', (t) => near.push(t.id));
    await p.playQueue([track('radio', 0, 'stream')]);
    expect(p.state.live).toBe(true);
    a.tick(60_000);
    p.seek(1000);
    expect(near).toEqual([]);
    expect(p.state.positionMs).toBe(60_000);
  });

  it('service adapters win over the built-in decks', async () => {
    const yt = new FakeAdapter('youtube');
    yt.canPlay = (t: Track) => t.source === 'youtube';
    p.registerAdapter(yt);
    await p.playQueue([track('v', 200, 'youtube'), track('l')]);
    expect(yt.loads).toEqual(['v']);
    yt.end();
    await flush();
    expect(a.loads).toEqual(['l']);
  });
});
