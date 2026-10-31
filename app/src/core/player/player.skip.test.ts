// Songs that do not start: what the player does next (skip, pause, ask for a tap) and checks ahead of time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEvents, PlayerAdapter, Track } from '../types';
import { createEmitter } from '../util/emitter';
import { PlaybackError } from './errors';
import { Player } from './player';
import { resetUnplayableCache, unplayableIds } from './unplayable';

/** A music service: refs listed in `bad` fail to start with `err`, refs in `unprobeable` fail the ahead check. */
class FakeService implements PlayerAdapter {
  readonly id = 'svc';
  private em = createEmitter<AdapterEvents>();
  track?: Track;
  started: string[] = [];
  bad = new Map<string, Error>();
  unprobeable = new Set<string>();
  probes: string[] = [];
  playDelayMs = 0;
  canPlay = (t: Track) => t.source === 'youtube';
  async load(t: Track) {
    this.track = t;
  }
  play() {
    const t = this.track!;
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        const err = this.bad.get(t.ref);
        if (err) return reject(err);
        this.started.push(t.ref);
        this.em.emit('play', undefined);
        resolve();
      }, this.playDelayMs);
    });
  }
  pause() {}
  seek() {}
  volume() {}
  async probe(t: Track) {
    this.probes.push(t.ref);
    if (this.unprobeable.has(t.ref)) throw new PlaybackError('The owner of this video does not allow playback outside YouTube.', 'unplayable', 150);
  }
  on<E extends keyof AdapterEvents>(e: E, cb: (p: AdapterEvents[E]) => void) {
    return this.em.on(e, cb);
  }
  end() {
    this.em.emit('ended', undefined);
  }
  emitError(err: Error) {
    this.em.emit('error', err);
  }
}

class NoDeck implements PlayerAdapter {
  readonly id = 'deck';
  private em = createEmitter<AdapterEvents>();
  canPlay = () => false;
  async load() {}
  async play() {}
  pause() {}
  seek() {}
  volume() {}
  on<E extends keyof AdapterEvents>(e: E, cb: (p: AdapterEvents[E]) => void) {
    return this.em.on(e, cb);
  }
}

const yt = (id: string): Track => ({
  id,
  title: id,
  artist: 'A',
  album: '',
  durationMs: 180_000,
  source: 'youtube',
  ref: id,
  playCount: 0,
  addedAt: 0,
  createdAt: 0,
  updatedAt: 0,
});

describe('player: songs that do not start', () => {
  let svc: FakeService;
  let p: Player;
  let skipped: string[];
  let errors: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetUnplayableCache();
    svc = new FakeService();
    p = new Player({ graph: null, decks: [new NoDeck(), new NoDeck()], persist: false });
    p.registerAdapter(svc);
    skipped = [];
    errors = [];
    p.on('skipped', ({ track }) => skipped.push(track.id));
    p.on('error', (e) => errors.push(e.message));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** playQueue under fake timers (the fake service starts on a timer) */
  async function start(list: Track[]) {
    const go = p.playQueue(list);
    await vi.advanceTimersByTimeAsync(10);
    await go;
  }

  it('leaves out a song that cannot play here and plays the next one, after a song ends', async () => {
    svc.bad.set('y2', new PlaybackError('The owner of this video does not allow playback outside YouTube.', 'unplayable', 150));
    await start([yt('y1'), yt('y2'), yt('y3')]);
    svc.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.started).toEqual(['y1', 'y3']);
    expect(p.state.status).toBe('playing');
    expect(skipped).toEqual(['y2']);
    expect(errors).toEqual([]); // a short "skipped" note, not an error
    expect((await unplayableIds()).has('y2')).toBe(true);
  });

  it('moves on when an automatic start fails for another reason (network), with the reason', async () => {
    svc.bad.set('y2', new Error('YouTube did not start playing. Check your connection and try again.'));
    await start([yt('y1'), yt('y2'), yt('y3')]);
    svc.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.started).toEqual(['y1', 'y3']);
    expect(errors).toHaveLength(1);
    expect((await unplayableIds()).has('y2')).toBe(false);
  });

  it('pauses and asks for a tap when the browser blocks autoplay (skipping would not help)', async () => {
    svc.bad.set('y2', new PlaybackError('The browser paused YouTube until you press play.', 'needs-gesture'));
    await start([yt('y1'), yt('y2'), yt('y3')]);
    svc.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.started).toEqual(['y1']);
    expect(p.state.status).toBe('paused');
    expect(p.state.track?.id).toBe('y2');
    expect(errors).toEqual(['The browser paused YouTube until you press play.']);
  });

  it('a song someone picked that fails for another reason pauses with the reason', async () => {
    svc.bad.set('y1', new Error('offline'));
    await start([yt('y1'), yt('y2')]);
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.started).toEqual([]);
    expect(p.state.status).toBe('paused');
    expect(errors).toEqual(['offline']);
  });

  it('handles an adapter error during a start once (no double skip)', async () => {
    const err = new PlaybackError('gone', 'unplayable', 100);
    svc.bad.set('y2', err);
    await start([yt('y1'), yt('y2'), yt('y3'), yt('y4')]);
    svc.end();
    svc.emitError(err); // arrives as an event while y2's start is in flight
    await vi.advanceTimersByTimeAsync(800);
    expect(svc.started).toEqual(['y1', 'y3']);
    expect(skipped).toEqual(['y2']);
  });

  it('checks the next songs ahead and drops unplayable ones before anyone names them', async () => {
    svc.unprobeable.add('y2');
    await start([yt('y1'), yt('y2'), yt('y3'), yt('y4')]);
    await p.aheadReady();
    expect(p.state.queue.map((t) => t.id)).toEqual(['y1', 'y3', 'y4']);
    expect(svc.probes).toEqual(['y2', 'y3', 'y4']);
    expect(skipped).toEqual(['y2']);
    svc.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(svc.started).toEqual(['y1', 'y3']);
  });

  it('talk over the intro: introNext returns before the next song plays', async () => {
    await start([yt('y1'), yt('y2')]);
    svc.playDelayMs = 1500; // a slow music service
    let introDone = false;
    p.holdAfterCurrent(async () => {
      await p.introNext(0.2);
      introDone = true;
      await new Promise((r) => setTimeout(r, 3000)); // the last line
    });
    svc.end();
    await vi.advanceTimersByTimeAsync(50);
    expect(introDone).toBe(true);
    expect(svc.started).toEqual(['y1']);
    await vi.advanceTimersByTimeAsync(1500);
    expect(svc.started).toEqual(['y1', 'y2']);
  });
});
