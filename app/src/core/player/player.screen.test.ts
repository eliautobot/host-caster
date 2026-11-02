// Phone apps: YouTube plays only while the app is on screen (Player.setScreenOnly / setOnScreen).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEvents, PlayerAdapter, Track } from '../types';
import { createEmitter } from '../util/emitter';
import { Player, SCREEN_RESUME_MS } from './player';

/** One service per source; records what the player asked it to do. */
class Fake implements PlayerAdapter {
  private em = createEmitter<AdapterEvents>();
  track?: Track;
  log: string[] = [];
  constructor(readonly id: string) {}
  canPlay = (t: Track) => t.source === this.id;
  async load(t: Track) {
    this.track = t;
    this.log.push(`load ${t.id}`);
  }
  play() {
    const t = this.track!;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.log.push(`play ${t.id}`);
        this.em.emit('play', undefined);
        resolve();
      }, 5);
    });
  }
  pause() {
    if (this.track) this.log.push(`pause ${this.track.id}`);
  }
  unload() {
    this.log.push('unload');
    this.track = undefined;
  }
  seek() {}
  volume() {}
  on<E extends keyof AdapterEvents>(e: E, cb: (p: AdapterEvents[E]) => void) {
    return this.em.on(e, cb);
  }
  end() {
    this.em.emit('ended', undefined);
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

const song = (id: string, source: 'youtube' | 'stream' | 'server'): Track => ({
  id,
  title: id,
  artist: 'A',
  album: 'Album',
  durationMs: 180_000,
  source,
  ref: id,
  playCount: 0,
  addedAt: 0,
  createdAt: 0,
  updatedAt: 0,
});
const yt = (id: string) => song(id, 'youtube');
const radio = (id: string) => song(id, 'server');

describe('player: YouTube only on screen (phone apps)', () => {
  let youtube: Fake;
  let other: Fake;
  let p: Player;

  beforeEach(() => {
    vi.useFakeTimers();
    youtube = new Fake('youtube');
    other = new Fake('server');
    p = new Player({ graph: null, decks: [new NoDeck(), new NoDeck()], persist: false });
    p.registerAdapter(youtube);
    p.registerAdapter(other);
    p.setScreenOnly((t) => t.source === 'youtube');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function start(list: Track[]) {
    const go = p.playQueue(list);
    await vi.advanceTimersByTimeAsync(10);
    await go;
  }
  const ids = () => p.state.queue.map((t) => t.id);

  it('pauses a YouTube song when the app leaves the screen and plays on when it is back', async () => {
    await start([yt('y1'), yt('y2')]);
    expect(p.state.status).toBe('playing');
    p.setOnScreen(false);
    expect(p.state.status).toBe('paused');
    expect(p.state.waiting).toBe('screen');
    expect(youtube.log).toContain('pause y1');
    expect(youtube.log).not.toContain('unload'); // paused, not stopped: resuming is not a new video start
    await vi.advanceTimersByTimeAsync(60_000);
    p.setOnScreen(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('playing');
    expect(p.state.track?.id).toBe('y1');
    expect(p.state.waiting).toBeUndefined();
    expect(youtube.log.filter((l) => l === 'load y1')).toHaveLength(1);
  });

  it('offers to resume instead when the app was away a long time', async () => {
    await start([yt('y1')]);
    p.setOnScreen(false);
    await vi.advanceTimersByTimeAsync(SCREEN_RESUME_MS + 1000);
    p.setOnScreen(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('paused');
    expect(p.state.waiting).toBe('resume');
    const go = p.play();
    await vi.advanceTimersByTimeAsync(10);
    await go;
    expect(p.state.status).toBe('playing');
    expect(p.state.waiting).toBeUndefined();
  });

  it('off screen, the next song that may play goes first and the YouTube songs wait behind it', async () => {
    await start([radio('r1'), yt('y1'), yt('y2'), radio('r2'), radio('r3')]);
    p.setOnScreen(false);
    // right away, so the hosts announce the song that will really play
    expect(ids()).toEqual(['r1', 'r2', 'y1', 'y2', 'r3']);
    other.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('r2');
    expect(p.state.status).toBe('playing');
    expect(ids()).toEqual(['r1', 'r2', 'r3', 'y1', 'y2']);
    other.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('r3');
    // nothing left that may play off screen: the YouTube song waits, paused (cued, not played)
    other.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('y1');
    expect(p.state.status).toBe('paused');
    expect(p.state.waiting).toBe('screen');
    expect(youtube.log).toEqual(['load y1']);
    p.setOnScreen(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('playing');
    expect(youtube.log).toEqual(['load y1', 'play y1']);
  });

  it('a break between two songs talks on when the app leaves the screen', async () => {
    await start([yt('y1'), radio('r1')]);
    let talking = true;
    p.holdAfterCurrent(async (signal) => {
      await new Promise<void>((r) => {
        const t = setTimeout(r, 3000);
        signal.addEventListener('abort', () => (clearTimeout(t), r()));
      });
      talking = !signal.aborted;
    });
    youtube.end();
    await vi.advanceTimersByTimeAsync(500);
    p.setOnScreen(false);
    expect(p.state.status).toBe('playing');
    await vi.advanceTimersByTimeAsync(3000);
    expect(talking).toBe(true);
    expect(p.state.track?.id).toBe('r1');
    expect(p.state.status).toBe('playing');
  });

  it('a start in flight is dropped off screen and starts again on screen', async () => {
    const go = p.playQueue([yt('y1')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.state.status).toBe('loading');
    p.setOnScreen(false);
    await vi.advanceTimersByTimeAsync(20);
    await go;
    expect(p.state.status).toBe('paused');
    expect(youtube.log).toContain('unload');
    p.setOnScreen(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(p.state.status).toBe('playing');
    expect(p.state.track?.id).toBe('y1');
  });

  it('play from the notification off screen plays a song that may play, else keeps waiting', async () => {
    await start([yt('y1'), yt('y2')]);
    p.setOnScreen(false);
    await p.play();
    expect(p.state.status).toBe('paused');
    expect(p.state.waiting).toBe('screen');
    p.addToQueue([radio('r1')]);
    const go = p.play();
    await vi.advanceTimersByTimeAsync(10);
    await go;
    expect(p.state.track?.id).toBe('r1');
    expect(p.state.status).toBe('playing');
    expect(ids()).toEqual(['r1', 'y1', 'y2']);
  });

  it('a pause from the notification is the listener\'s choice: no resume on screen', async () => {
    await start([yt('y1')]);
    p.setOnScreen(false);
    p.pause();
    expect(p.state.waiting).toBeUndefined();
    p.setOnScreen(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('paused');
  });

  it('without the rule (web) nothing changes off screen', async () => {
    p.setScreenOnly(undefined);
    await start([yt('y1'), radio('r1')]);
    p.setOnScreen(false);
    expect(p.state.status).toBe('playing');
    expect(ids()).toEqual(['y1', 'r1']);
    youtube.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('r1');
  });
});

describe('player: the listener hides the YouTube video (phone and desktop apps)', () => {
  let youtube: Fake;
  let other: Fake;
  let p: Player;
  beforeEach(() => {
    vi.useFakeTimers();
    youtube = new Fake('youtube');
    other = new Fake('server');
    p = new Player({ graph: null, decks: [new NoDeck(), new NoDeck()], persist: false });
    p.registerAdapter(youtube);
    p.registerAdapter(other);
    p.setScreenOnly((t) => t.source === 'youtube');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  async function start(list: Track[]) {
    const go = p.playQueue(list);
    await vi.advanceTimersByTimeAsync(10);
    await go;
  }
  const ids = () => p.state.queue.map((t) => t.id);

  it('hiding stops the YouTube song and the next song that may play goes on; the YouTube songs wait behind it', async () => {
    await start([yt('y1'), yt('y2'), radio('r1'), yt('y3'), radio('r2')]);
    expect(p.state.track?.id).toBe('y1');
    p.setVideoHidden(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('r1');
    expect(p.state.status).toBe('playing');
    expect(p.state.waiting).toBeUndefined();
    expect(youtube.log).toEqual(['load y1', 'play y1', 'pause y1', 'unload']);
    expect(ids()).toEqual(['r1', 'y1', 'y2', 'y3', 'r2']);
    // the YouTube songs are skipped while hidden
    other.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('r2');
    expect(p.state.status).toBe('playing');
    expect(ids()).toEqual(['r1', 'r2', 'y1', 'y2', 'y3']);
    expect(youtube.log.filter((l) => l.startsWith('play'))).toEqual(['play y1']);
  });

  it('nothing else to play: the YouTube song waits, paused, with the hidden-video note', async () => {
    await start([yt('y1'), yt('y2')]);
    p.setVideoHidden(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('y1');
    expect(p.state.status).toBe('paused');
    expect(p.state.waiting).toBe('video');
    // play is refused while hidden (no hidden YouTube playback)
    await p.play();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('paused');
    expect(p.state.waiting).toBe('video');
    // shown again: it plays on, even after a long time (the listener asked for it)
    await vi.advanceTimersByTimeAsync(SCREEN_RESUME_MS + 1000);
    p.setVideoHidden(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('playing');
    expect(p.state.track?.id).toBe('y1');
    expect(p.state.waiting).toBeUndefined();
  });

  it('shown again, the YouTube songs play in their turn after the current song', async () => {
    await start([yt('y1'), radio('r1'), radio('r2')]);
    p.setVideoHidden(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(ids()).toEqual(['r1', 'y1', 'r2']);
    p.setVideoHidden(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('r1'); // the radio is not cut off
    other.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('y1');
    expect(p.state.status).toBe('playing');
  });

  it('hidden while another song plays: the next YouTube song is skipped before anyone names it', async () => {
    await start([radio('r1'), yt('y1'), radio('r2')]);
    p.setVideoHidden(true);
    expect(ids()).toEqual(['r1', 'r2', 'y1']);
    expect(p.state.track?.id).toBe('r1');
    expect(p.state.status).toBe('playing');
  });

  it('back on screen with the video still hidden: the song keeps waiting and the note says why', async () => {
    await start([yt('y1')]);
    p.setOnScreen(false);
    expect(p.state.waiting).toBe('screen');
    p.setVideoHidden(true);
    p.setOnScreen(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('paused');
    expect(p.state.waiting).toBe('video');
    p.setVideoHidden(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.status).toBe('playing');
  });

  it('without the rule (web) hiding changes nothing', async () => {
    p.setScreenOnly(undefined);
    await start([yt('y1'), radio('r1')]);
    p.setVideoHidden(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.state.track?.id).toBe('y1');
    expect(p.state.status).toBe('playing');
  });
});
