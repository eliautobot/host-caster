// core/player (owner: player agent). One Web Audio graph (music gain + voice gain); adapters per source.
// The queue lives here (play order); see queue.ts for shuffle/repeat rules and holds.ts for breaks between tracks.
import { db } from '../db';
import type { PlayerAdapter, PlayerEventName, PlayerEvents, PlayerState, RepeatMode, Track } from '../types';
import { createEmitter } from '../util/emitter';
import { AudioDeck } from './audioDeck';
import { playbackErrorKind, type PlaybackErrorKind } from './errors';
import { AudioGraph } from './graph';
import { HoldRunner, type HoldFn, type HoldOptions } from './holds';
import { bindMediaSession, updateMediaSession, updatePositionState } from './mediaSession';
import { Mixer, type MixerLevels } from './mixer';
import { DEFAULT_PREFS, loadPrefs, loadResume, saveResume, savePrefs, type PlayerPrefs } from './persist';
import * as Q from './queue';
import { clearUnplayable, markUnplayable } from './unplayable';
import { VoiceChannel } from './voice';

/** 'nearend' fires this long before the end ... */
export const NEAR_END_MS = 20_000;
/** ... or right at the start for tracks this short, so a break has time to get ready */
export const SHORT_TRACK_MS = 45_000;
const RESTART_PREV_MS = 3_000;
const SAVE_EVERY_MS = 5_000;
/** upcoming songs checked ahead (adapters with probe(), e.g. YouTube) while the current one plays */
const AHEAD = 2;
const PROBE_MAX_MS = 9_000;
/** automatic starts that fail for other reasons (network ...) give up after this many in a row */
const MAX_FAILED_STARTS = 4;
/** back on screen within this long: a song that waited off screen plays on by itself (later: the app offers it) */
export const SCREEN_RESUME_MS = 10 * 60_000;
/** the notification's second line while a song waits for the app to be on screen */
const SCREEN_NOTE = 'Waiting: YouTube plays while Host-Caster is open';

export interface PlayerOptions {
  /** null = no Web Audio (tests) */
  graph?: AudioGraph | null;
  /** the two built-in decks (crossfade A/B); tests pass fakes */
  decks?: [PlayerAdapter, PlayerAdapter];
  /** save queue + prefs in kv */
  persist?: boolean;
  holdIdleTimeoutMs?: number;
}

const IDLE: PlayerState = {
  status: 'idle',
  index: -1,
  queue: [],
  positionMs: 0,
  durationMs: 0,
  shuffle: false,
  repeat: 'off',
  volume: DEFAULT_PREFS.volume,
  muted: false,
  holding: false,
  ducked: false,
  live: false,
};

export class Player {
  private emitter = createEmitter<PlayerEvents>();
  private _state: PlayerState = IDLE;
  private q: Q.QueueState<Track> = { items: [], index: -1 };
  private repeat: RepeatMode = 'off';
  private readonly graph: AudioGraph | null;
  private readonly decks: [PlayerAdapter, PlayerAdapter];
  private deckIdx = 0;
  private services: PlayerAdapter[] = [];
  private wired = new Set<PlayerAdapter>();
  private active?: PlayerAdapter;
  private loadedId?: string;
  private startedId?: string;
  private token = 0;
  private nearendFired = false;
  private crossfadeMs = 0;
  private fading?: PlayerAdapter;
  private errorsInRow = 0;
  private persist: boolean;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private lastSave = 0;
  private lastPosSync = 0;
  readonly mixer: Mixer;
  private holds: HoldRunner;
  private voiceChannel?: VoiceChannel;
  private stingChannel?: VoiceChannel;
  private fadeTriedFor?: string;
  /** token of the start in flight: its adapter errors arrive as the rejected play(), not as events */
  private startingToken = 0;
  private failedStarts = 0;
  private probed = new Map<string, Promise<void>>();
  private ahead: Promise<void> = Promise.resolve();
  /** songs that may play only while the app is on screen (phone apps: YouTube), see setScreenOnly */
  private screenOnly?: (track: Track) => boolean;
  private offScreen = false;
  /** the song that waits because the app left the screen, and since when */
  private heldOffScreen?: { id: string; at: number };

  constructor(opts: PlayerOptions = {}) {
    const browser = typeof window !== 'undefined' && typeof Audio !== 'undefined';
    this.graph = opts.graph !== undefined ? opts.graph : browser ? new AudioGraph() : null;
    this.decks = opts.decks ?? [new AudioDeck('audio-a', this.graph!), new AudioDeck('audio-b', this.graph!)];
    this.persist = opts.persist ?? browser;
    this.mixer = new Mixer(this.graph);
    if (this.graph) this.graph.onCreate = () => this.mixer.syncGraph();
    this.holds = new HoldRunner({
      idleTimeoutMs: opts.holdIdleTimeoutMs,
      voiceBusy: () => this.voiceChannel?.playing ?? false,
      stopVoice: () => this.stopVoice(),
      onChange: (holding) => this.set({ holding }),
    });
    if (browser && opts.decks === undefined) this.bindPlatform();
  }

  get state(): PlayerState {
    return this._state;
  }

  on<E extends PlayerEventName>(event: E, cb: (payload: PlayerEvents[E]) => void): () => void {
    return this.emitter.on(event, cb);
  }

  /** Service adapters (Spotify, YouTube ...): the first whose canPlay() says yes wins over the audio element. */
  registerAdapter(adapter: PlayerAdapter): void {
    if (!this.services.includes(adapter)) this.services.push(adapter);
  }

  // ------------------------------------------------------------------------------------------------ transport

  /** Replaces the queue and loads `startIndex` (paused). Call play() to start. */
  async load(queue: Track[], startIndex = 0): Promise<void> {
    this.holds.clear();
    this.q = Q.createQueue(queue, startIndex, Boolean(this._state.shuffle));
    this.syncQueue();
    if (this.q.index < 0) return this.stopAll();
    await this.startTrack(this.q.index, { autoplay: false });
  }

  /** load() + play() */
  async playQueue(queue: Track[], startIndex = 0): Promise<void> {
    this.holds.clear();
    this.q = Q.createQueue(queue, startIndex, Boolean(this._state.shuffle));
    this.syncQueue();
    if (this.q.index < 0) return this.stopAll();
    await this.startTrack(this.q.index, { autoplay: true });
  }

  async play(): Promise<void> {
    const track = this._state.track;
    if (!track) return;
    this.clearWait();
    if (this.mustWait(track)) {
      // off screen (notification play): a song that may play now goes first, else this one keeps waiting
      if (this.playableAfter(this.q.index) >= 0) await this.startTrack(this.q.index, { autoplay: true });
      else this.holdForScreen(track);
      return;
    }
    if (!this.active || this.loadedId !== track.id) {
      await this.startTrack(this.q.index, { autoplay: true, seekMs: this._state.positionMs });
      return;
    }
    await this.graph?.resume();
    const token = this.token;
    this.startingToken = token;
    try {
      await this.active.play();
    } catch (err) {
      if (token === this.token) this.failStart(track, err, false);
      return;
    } finally {
      if (this.startingToken === token) this.startingToken = 0;
    }
    if (token !== this.token) return;
    if (this.mustWait(track)) return this.waitOffScreen(track);
    this.set({ status: 'playing' });
    this.markStarted(track);
    this.notify(true);
  }

  pause(): void {
    this.clearWait();
    this.holds.abort('pause');
    this.active?.pause();
    if (this._state.status === 'playing' || this._state.status === 'loading') this.set({ status: 'paused' });
    this.notify(false);
    this.save(true);
  }

  /** Stop from the lock screen / notification: pause and take the notification down. */
  stop(): void {
    this.pause();
    this.notify(false, { dismiss: true });
  }

  async toggle(): Promise<void> {
    if (this._state.status === 'playing') this.pause();
    else await this.play();
  }

  /** Next track. During a break, the first press skips the break. */
  async next(): Promise<void> {
    if (this.holds.running) {
      this.holds.abort('skip');
      return;
    }
    await this.advance(false);
  }

  /** Previous track, or back to the start when more than 3 s in. */
  async prev(): Promise<void> {
    if (!this.q.items.length) return;
    if (this._state.positionMs > RESTART_PREV_MS && !this._state.live) {
      this.seek(0);
      return;
    }
    const i = Q.prevIndex(this.q.items.length, this.q.index, this.repeat);
    await this.startTrack(i, { autoplay: true });
  }

  /** Plays the queue entry at `index`. */
  async jumpTo(index: number): Promise<void> {
    if (index < 0 || index >= this.q.items.length) return;
    this.holds.clear();
    await this.startTrack(index, { autoplay: true });
  }

  seek(ms: number): void {
    if (this._state.live) return;
    const pos = Math.max(0, Math.min(ms, this._state.durationMs || ms));
    if (this.active && this.loadedId === this._state.track?.id) this.active.seek(pos);
    this.set({ positionMs: pos });
    updatePositionState(pos, this._state.durationMs, false);
    this.notify(this._state.status === 'playing');
    this.save();
  }

  seekBy(deltaMs: number): void {
    this.seek(this._state.positionMs + deltaMs);
  }

  setVolume(level: number): void {
    this.mixer.setVolume(level, level > 0 ? false : this.mixer.muted);
    this.set({ volume: this.mixer.volume, muted: this.mixer.muted });
    this.savePrefs();
  }

  setMuted(muted: boolean): void {
    this.mixer.setVolume(this.mixer.volume || 0.5, muted);
    this.set({ volume: this.mixer.volume, muted });
    this.savePrefs();
  }

  // ------------------------------------------------------------------------------------------------ voice & breaks

  /** Lower the music to `level` (0..1) for a voice line. */
  duck(level: number, rampMs = 400): void {
    this.mixer.setDuck(level, rampMs);
    this.set({ ducked: level < 1 });
  }

  unduck(rampMs = 600): void {
    this.mixer.setDuck(1, rampMs);
    this.set({ ducked: false });
  }

  /** Play a voice clip over the music; resolves when it finishes (or is stopped). */
  async playVoice(src: Blob | string): Promise<void> {
    this.voiceChannel ??= new VoiceChannel(
      this.graph,
      () => this.holds.activity(),
      () => (this.mixer.muted ? 0 : this.mixer.volume),
    );
    this.holds.activity();
    await this.voiceChannel.play(src);
  }

  /**
   * A short sting (station ident) on the voice bus on its own channel, so a voice line can start while it rings
   * out. Resolves when it finishes.
   */
  async playSting(src: Blob | string): Promise<void> {
    this.stingChannel ??= new VoiceChannel(
      this.graph,
      () => this.holds.activity(),
      () => (this.mixer.muted ? 0 : this.mixer.volume),
    );
    this.holds.activity();
    await this.stingChannel.play(src);
  }

  stopVoice(): void {
    this.voiceChannel?.stop();
    this.stingChannel?.stop();
  }

  /**
   * Run `fn` (a break) between the current track and the next one. `fn` gets an AbortSignal (Next pressed, paused,
   * 25 s without any voice activity, or `opts.maxMs` in total). A throw or a timeout moves on to the next track:
   * never silence.
   */
  holdAfterCurrent(fn: HoldFn, opts?: HoldOptions): void {
    this.holds.add(fn, opts);
  }

  /**
   * Inside a break: start the next track now, ducked to `duckLevel`, and keep talking over its intro. Returns once
   * the start is under way (not when the song plays): the host's line never waits for the music service.
   */
  async introNext(duckLevel = 0.18): Promise<void> {
    this.duck(duckLevel, 250);
    this.holds.markIntro();
    const i = Q.nextIndex(this.q.items.length, this.q.index, this.repeat, true);
    if (i >= 0) void this.startTrack(i, { autoplay: true, auto: true });
  }

  /**
   * Resolves when the next songs were checked ahead (unplayable ones already left out of the queue), or after
   * `maxMs`. The radio waits for this before it names the next song in a break.
   */
  aheadReady(maxMs = 4000): Promise<void> {
    return Promise.race([this.ahead, new Promise<void>((r) => setTimeout(r, maxMs))]);
  }

  /** Voice activity outside playVoice (device speech): keeps a break from timing out. */
  markActivity(): void {
    this.holds.activity();
  }

  // ------------------------------------------------------------------------------------------------ on screen only

  /**
   * Songs that may play only while the app is on screen (the phone apps: YouTube API Services do not allow a player
   * that is not on the screen the user is viewing). Off screen such a song pauses and waits; the songs after it that
   * may play go first (the hosts keep talking between them). Undefined (web) = no rule.
   */
  setScreenOnly(test: ((track: Track) => boolean) | undefined): void {
    this.screenOnly = test;
  }

  /** The app came on screen (true) or left it (home button, screen off, another app on top). */
  setOnScreen(on: boolean): void {
    if (this.offScreen === !on) return;
    this.offScreen = !on;
    if (!this.screenOnly) return;
    const s = this._state;
    const track = s.track;
    if (!on) {
      this.deferScreenOnly(this.q.index + 1);
      // a break between two songs talks on; the next start checks again
      if (track && this.mustWait(track) && (s.status === 'playing' || s.status === 'loading') && !this.holds.between) this.waitOffScreen(track);
      return;
    }
    const held = this.heldOffScreen;
    this.heldOffScreen = undefined;
    if (!held || track?.id !== held.id || s.status !== 'paused') {
      if (s.waiting) this.set({ waiting: undefined });
      return;
    }
    if (Date.now() - held.at <= SCREEN_RESUME_MS) {
      void this.play();
      return;
    }
    this.set({ waiting: 'resume' });
    this.notify(false);
  }

  get onScreen(): boolean {
    return !this.offScreen;
  }

  // ------------------------------------------------------------------------------------------------ modes & queue

  setShuffle(on: boolean): void {
    this.q = on ? Q.enableShuffle(this.q) : Q.disableShuffle(this.q);
    this.syncQueue({ shuffle: on });
    this.savePrefs();
  }

  toggleShuffle(): void {
    this.setShuffle(!this._state.shuffle);
  }

  setRepeat(mode: RepeatMode): void {
    this.repeat = mode;
    this.set({ repeat: mode });
    this.savePrefs();
  }

  /** off -> all -> one -> off */
  cycleRepeat(): void {
    this.setRepeat(this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off');
  }

  setCrossfade(ms: number): void {
    this.crossfadeMs = Math.max(0, Math.min(12_000, ms));
    this.savePrefs();
  }

  get crossfade(): number {
    return this.crossfadeMs;
  }

  /** "Play next": right after the current track. Starts playing when the queue was empty. */
  async playNext(tracks: Track[]): Promise<void> {
    const wasEmpty = !this.q.items.length;
    this.q = Q.insertNext(this.q, tracks);
    this.syncQueue();
    if (wasEmpty) await this.startTrack(0, { autoplay: true });
  }

  async addToQueue(tracks: Track[]): Promise<void> {
    const wasEmpty = !this.q.items.length;
    this.q = Q.append(this.q, tracks);
    this.syncQueue();
    if (wasEmpty) await this.startTrack(0, { autoplay: true });
  }

  /** Removes the queue entry at `index` (the current track cannot be removed; use next()). */
  removeFromQueue(index: number): void {
    if (index === this.q.index) return;
    this.q = Q.removeAt(this.q, index);
    this.syncQueue();
  }

  moveInQueue(from: number, to: number): void {
    this.q = Q.move(this.q, from, to);
    this.syncQueue();
  }

  clearUpcoming(): void {
    this.q = Q.clearUpcoming(this.q);
    this.syncQueue();
  }

  /** Deleted songs leave the queue; the current one stops when it is deleted. */
  async removeTracks(ids: string[]): Promise<void> {
    const set = new Set(ids);
    const current = this._state.track;
    const wasPlaying = this._state.status === 'playing';
    this.q = Q.removeIds(this.q, set);
    if (current && set.has(current.id)) {
      this.active?.pause();
      this.active?.unload?.();
      this.loadedId = undefined;
      this.syncQueue();
      if (this.q.index >= 0) await this.startTrack(this.q.index, { autoplay: wasPlaying });
      else this.stopAll();
      return;
    }
    this.syncQueue();
  }

  /** Fresh copies of tracks already in the queue (likes, edits). */
  updateTracks(tracks: Track[]): void {
    const byId = new Map(tracks.map((t) => [t.id, t]));
    if (!this.q.items.some((t) => byId.has(t.id))) return;
    const swap = (t: Track) => byId.get(t.id) ?? t;
    this.q = { ...this.q, items: this.q.items.map(swap), original: this.q.original?.map(swap) };
    this.syncQueue();
  }

  /** Debug and tests: the gains right now. */
  levels(): MixerLevels & { voicePlaying: boolean; holding: boolean } {
    return { ...this.mixer.levels(this.active), voicePlaying: this.voiceChannel?.playing ?? false, holding: this.holds.running };
  }

  /** Loads the saved queue and prefs (paused at the saved position). */
  async restore(): Promise<void> {
    const prefs = await loadPrefs().catch(() => DEFAULT_PREFS);
    this.applyPrefs(prefs);
    if (this.q.items.length) return;
    const snap = await loadResume().catch(() => undefined);
    if (!snap || this.q.items.length) return;
    const byId = new Map(snap.items.map((t) => [t.id, t]));
    const original = snap.original?.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t));
    this.q = { items: snap.items, index: snap.index, original: prefs.shuffle && original?.length ? original : undefined };
    const track = this.q.items[this.q.index];
    this.set({
      status: track ? 'paused' : 'idle',
      queue: this.q.items,
      index: this.q.index,
      track,
      positionMs: snap.positionMs,
      durationMs: track?.durationMs ?? 0,
      live: track?.source === 'stream',
      shuffle: Boolean(this.q.original),
    });
    this.notify(false, { webOnly: true });
  }

  // ------------------------------------------------------------------------------------------------ internals

  private set(patch: Partial<PlayerState>) {
    this._state = { ...this._state, ...patch };
    this.emitter.emit('state', this._state);
  }

  /** Lock screen + native notification for the current track (none = take it down). */
  private notify(playing: boolean, extra: { webOnly?: boolean; dismiss?: boolean } = {}) {
    const s = this._state;
    const n = this.q.items.length;
    void updateMediaSession(s.track, playing, {
      positionMs: s.positionMs,
      live: Boolean(s.live),
      canPrev: n > 0,
      canNext: Q.nextIndex(n, this.q.index, this.repeat, false) >= 0 || this.holds.pending,
      ...(s.waiting === 'screen' ? { note: SCREEN_NOTE } : {}),
      ...extra,
    });
  }

  private syncQueue(extra: Partial<PlayerState> = {}) {
    const track = this.q.items[this.q.index];
    this.set({ queue: this.q.items, index: this.q.index, track, shuffle: Boolean(this.q.original), ...extra });
    this.save();
  }

  private adapterFor(track: Track): PlayerAdapter | undefined {
    const service = this.services.find((a) => a.canPlay(track));
    if (service) return service;
    const deck = this.decks[this.deckIdx]!;
    return deck.canPlay(track) ? deck : undefined;
  }

  private isDeck(a: PlayerAdapter | undefined): boolean {
    return a !== undefined && this.decks.includes(a);
  }

  private wire(a: PlayerAdapter) {
    if (this.wired.has(a)) return;
    this.wired.add(a);
    a.on('time', (t) => a === this.active && this.onTime(t.positionMs, t.durationMs));
    a.on('ended', () => a === this.active && void this.advance(true));
    a.on('play', () => {
      if (a !== this.active || this._state.status !== 'paused') return;
      const t = this._state.track;
      if (t && this.mustWait(t)) a.pause(); // off screen: a YouTube song stays paused
      else this.set({ status: 'playing' });
    });
    a.on('pause', () => a === this.active && this._state.status === 'playing' && this.set({ status: 'paused' }));
    // during a start the adapter rejects play() instead (startTrack handles it once)
    a.on('error', (err) => {
      if (a !== this.active || this.startingToken === this.token) return;
      const track = this._state.track;
      if (track) this.failStart(track, err, true);
    });
  }

  /** `auto` = nobody asked for this song right now (it follows the last one): a failure moves on to the next. */
  private async startTrack(index: number, opts: { autoplay: boolean; seekMs?: number; auto?: boolean; wait?: boolean }): Promise<void> {
    const track = this.q.items[index];
    if (!track) return;
    this.clearWait();
    if (opts.autoplay && this.mustWait(track)) {
      // off screen: the next song that may play now goes first, the YouTube one waits right behind it
      const j = this.playableAfter(index);
      if (j >= 0) {
        this.q = Q.move(this.q, j, index);
        this.syncQueue();
        return this.startTrack(index, opts);
      }
      opts = { ...opts, autoplay: false, wait: true };
    }
    const token = ++this.token;
    this.q = { ...this.q, index };
    this.finishFade();
    const adapter = this.adapterFor(track);
    const prev = this.active;
    if (prev && prev !== adapter) {
      prev.pause();
      prev.unload?.();
      this.mixer.detach(prev);
    } else prev?.pause();
    this.active = adapter;
    this.loadedId = undefined;
    this.startedId = undefined;
    this.nearendFired = false;
    const live = track.source === 'stream';
    this.set({
      status: 'loading',
      track,
      index,
      queue: this.q.items,
      positionMs: opts.seekMs ?? 0,
      durationMs: live ? 0 : track.durationMs,
      live,
    });
    if (!adapter) return this.fail(new Error(`No player for ${track.source} songs is connected`), opts.autoplay);
    this.wire(adapter);
    this.startingToken = token;
    try {
      await adapter.load(track);
    } catch (err) {
      if (this.startingToken === token) this.startingToken = 0;
      if (token === this.token) this.failStart(track, err, opts.autoplay);
      return;
    }
    if (token !== this.token) return;
    this.loadedId = track.id;
    this.mixer.setDeck(adapter, 1);
    this.mixer.attach(adapter);
    if (opts.seekMs && !live) adapter.seek(opts.seekMs);
    if (!opts.autoplay) {
      if (this.startingToken === token) this.startingToken = 0;
      this.set({ status: 'paused' });
      if (opts.wait) this.holdForScreen(track);
      else this.notify(false);
      return;
    }
    try {
      await this.graph?.resume();
      await adapter.play();
    } catch (err) {
      if (token === this.token) this.failStart(track, err, Boolean(opts.auto));
      return;
    } finally {
      if (this.startingToken === token) this.startingToken = 0;
    }
    if (token !== this.token) return;
    this.errorsInRow = 0;
    this.failedStarts = 0;
    if (this.mustWait(track)) {
      // the app left the screen while this YouTube song was starting: it waits, paused
      adapter.pause();
      this.set({ status: 'paused' });
      return this.holdForScreen(track);
    }
    this.set({ status: 'playing' });
    this.markStarted(track);
    this.notify(true);
  }

  private markStarted(track: Track) {
    if (this.startedId === track.id) return;
    this.startedId = track.id;
    // off screen: the song the hosts announce next must be one that may play now
    if (this.offScreen) this.deferScreenOnly(this.q.index + 1);
    // check the next songs first: the radio's trackstart handler waits for this before it names the next song
    this.checkAhead();
    this.emitter.emit('trackstart', track);
    void db.tracks
      .where('id')
      .equals(track.id)
      .modify((t) => {
        t.playCount = (t.playCount ?? 0) + 1;
        t.lastPlayedAt = Date.now();
      })
      .catch(() => undefined);
    if (!this._state.live && track.durationMs > 0 && track.durationMs <= SHORT_TRACK_MS) this.fireNearEnd(track);
    this.save(true);
  }

  private fireNearEnd(track: Track) {
    if (this.nearendFired) return;
    this.nearendFired = true;
    this.emitter.emit('nearend', track);
  }

  private onTime(positionMs: number, durationMs: number) {
    const s = this._state;
    const track = s.track;
    if (!track || this.loadedId !== track.id) return;
    const dur = s.live ? 0 : durationMs || s.durationMs;
    this.set({ positionMs, durationMs: dur });
    const now = Date.now();
    if (now - this.lastPosSync > 4000) {
      this.lastPosSync = now;
      updatePositionState(positionMs, dur, Boolean(s.live));
    }
    if (s.status !== 'playing' || s.live || !(dur > 0)) return;
    const left = dur - positionMs;
    if (this.startedId === track.id && (dur <= SHORT_TRACK_MS || left <= NEAR_END_MS)) this.fireNearEnd(track);
    if (this.crossfadeMs > 0 && !this.fading && this.fadeTriedFor !== track.id && left <= this.crossfadeMs && dur > this.crossfadeMs * 2) {
      this.fadeTriedFor = track.id;
      void this.crossfadeToNext();
    }
    this.save();
  }

  /** The current track ended (auto) or the user pressed Next. Breaks run first. */
  private async advance(auto: boolean): Promise<void> {
    const ended = this._state.track;
    if (auto && ended) this.emitter.emit('trackend', ended);
    if (this.holds.pending) {
      const token = this.token;
      const result = await this.holds.run();
      if (this._state.ducked) this.unduck();
      if (result.intro || token !== this.token) return; // the next track already started (talk over intro / jump)
      if (result.reason === 'pause') {
        const i = Q.nextIndex(this.q.items.length, this.q.index, this.repeat, true);
        if (i >= 0) await this.startTrack(i, { autoplay: false });
        return;
      }
    }
    const i = Q.nextIndex(this.q.items.length, this.q.index, this.repeat, auto);
    if (i < 0) return this.endOfQueue();
    await this.startTrack(i, { autoplay: true, auto });
  }

  private async crossfadeToNext(): Promise<void> {
    if (this.holds.pending || this.repeat === 'one' || !this.isDeck(this.active)) return;
    const i = Q.nextIndex(this.q.items.length, this.q.index, this.repeat, true);
    const next = this.q.items[i];
    if (i < 0 || !next) return;
    const other = this.decks[1 - this.deckIdx]!;
    if (this.services.some((a) => a.canPlay(next)) || !other.canPlay(next)) return;
    const old = this.active!;
    const ended = this._state.track;
    const ms = this.crossfadeMs;
    const token = ++this.token;
    this.fading = old;
    this.wire(other);
    this.mixer.setDeck(other, 0);
    try {
      await other.load(next);
    } catch {
      this.fading = undefined; // let the current one end normally
      return;
    }
    if (token !== this.token) return;
    if (ended) this.emitter.emit('trackend', ended);
    this.deckIdx = 1 - this.deckIdx;
    this.active = other;
    this.loadedId = next.id;
    this.startedId = undefined;
    this.nearendFired = false;
    this.q = { ...this.q, index: i };
    this.set({ track: next, index: i, positionMs: 0, durationMs: next.durationMs, live: false });
    this.mixer.attach(other);
    this.mixer.setDeck(other, 0);
    await other.play().catch(() => undefined);
    this.mixer.rampDeck(other, 1, ms);
    this.mixer.rampDeck(old, 0, ms);
    this.markStarted(next);
    this.notify(true);
    setTimeout(() => {
      if (this.fading === old) this.finishFade();
    }, ms + 50);
  }

  private finishFade() {
    const old = this.fading;
    if (!old) return;
    this.fading = undefined;
    if (old === this.active) return;
    old.pause();
    old.unload?.();
    this.mixer.detach(old);
    this.mixer.setDeck(old, 1);
  }

  private endOfQueue() {
    this.active?.pause();
    this.loadedId = undefined;
    this.q = { ...this.q, index: 0 };
    const first = this.q.items[0];
    this.set({ status: first ? 'paused' : 'idle', index: first ? 0 : -1, track: first, positionMs: 0, durationMs: first?.durationMs ?? 0 });
    this.notify(false);
    this.save(true);
  }

  private stopAll() {
    this.token++;
    this.active?.pause();
    this.active?.unload?.();
    this.loadedId = undefined;
    this.set({ status: 'idle', track: undefined, index: -1, queue: this.q.items, positionMs: 0, durationMs: 0, live: false });
    this.notify(false);
    this.save(true);
  }

  /**
   * A song did not start (or broke off). Unplayable here (embedding off, removed ...): remembered, left out, and the
   * next one plays, whoever started it. Needs a tap (autoplay rules): pause and say so, skipping cannot help.
   * Anything else: play on when the start was automatic, else pause with the reason.
   */
  private failStart(track: Track, err: unknown, auto: boolean) {
    const kind: PlaybackErrorKind = playbackErrorKind(err);
    const error = err instanceof Error ? err : new Error(String(err));
    if (kind === 'unplayable') {
      const code = (err as { code?: unknown }).code;
      void markUnplayable([track], error.message, typeof code === 'number' ? code : undefined);
      this.emitter.emit('skipped', { track, reason: error.message });
      this.fail(error, true, { silent: true });
      return;
    }
    if (kind === 'needs-gesture') {
      this.errorsInRow = 0;
      this.fail(error, false);
      return;
    }
    this.failedStarts++;
    this.fail(error, auto && this.failedStarts < MAX_FAILED_STARTS);
  }

  /** Never leave silence: report, then skip ahead unless every track in the queue failed. */
  private fail(err: unknown, skip: boolean, opts: { silent?: boolean } = {}) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!opts.silent) this.emitter.emit('error', error);
    this.errorsInRow++;
    if (skip && this.errorsInRow < this.q.items.length) {
      const token = this.token;
      setTimeout(() => token === this.token && void this.advance(false), 150);
      return;
    }
    this.errorsInRow = 0;
    this.failedStarts = 0;
    this.set({ status: 'paused' });
    this.notify(false);
  }

  /** this song may not play right now (off screen, and it may play only on screen) */
  private mustWait(track: Track): boolean {
    return this.offScreen && Boolean(this.screenOnly?.(track));
  }

  /** the first song after `index` that may play now, or -1 */
  private playableAfter(index: number): number {
    for (let k = index + 1; k < this.q.items.length; k++) if (!this.mustWait(this.q.items[k]!)) return k;
    return -1;
  }

  /** Off screen: when the song at `at` has to wait, the next one that may play moves in front of it. */
  private deferScreenOnly(at: number) {
    const t = this.q.items[at];
    if (!t || !this.mustWait(t)) return;
    const j = this.playableAfter(at);
    if (j < 0) return;
    this.q = Q.move(this.q, j, at);
    this.syncQueue();
  }

  /** Pauses the current (on screen only) song until the app is back on screen. */
  private waitOffScreen(track: Track) {
    const starting = this._state.status === 'loading';
    this.pause();
    if (starting) {
      // a start in flight would go on by itself (YouTube's start watchdog sends it again): drop it, start over later
      this.token++;
      this.active?.unload?.();
      this.loadedId = undefined;
    }
    this.holdForScreen(track);
  }

  private holdForScreen(track: Track) {
    this.heldOffScreen = { id: track.id, at: Date.now() };
    this.set({ waiting: 'screen' });
    this.notify(false);
  }

  private clearWait() {
    this.heldOffScreen = undefined;
    if (this._state.waiting) this.set({ waiting: undefined });
  }

  /**
   * Checks the next songs while this one plays (adapters with probe(): YouTube asks a hidden player). A song that
   * cannot play here leaves the queue before anyone announces it.
   */
  private checkAhead() {
    const run = async () => {
      let checked = 0;
      for (let k = 1; k <= AHEAD && checked < AHEAD * 3; k++) {
        const t = this.q.items[this.q.index + k];
        if (!t) break;
        const adapter = this.services.find((a) => a.canPlay(t));
        if (!adapter?.probe) continue;
        checked++;
        let check = this.probed.get(t.id);
        if (!check) {
          check = adapter.probe(t);
          this.probed.set(t.id, check);
          check.catch(() => undefined);
        }
        const verdict = await Promise.race([
          check.then(
            () => undefined,
            (err: unknown) => err,
          ),
          new Promise<undefined>((r) => setTimeout(r, PROBE_MAX_MS)),
        ]);
        if (verdict === undefined) {
          void clearUnplayable(t.id);
          continue;
        }
        if (playbackErrorKind(verdict) !== 'unplayable') continue;
        const reason = verdict instanceof Error ? verdict.message : String(verdict);
        const code = (verdict as { code?: unknown }).code;
        void markUnplayable([t], reason, typeof code === 'number' ? code : undefined);
        // (a check still running from the last song may have dropped it already: one note per song)
        if (this.dropUpcoming(t)) this.emitter.emit('skipped', { track: t, reason });
        k--; // the next song moved up into this place
      }
    };
    this.ahead = run().catch(() => undefined);
  }

  /** Leaves `track` out of the rest of the queue (it stays where it already played). False: it was not there. */
  private dropUpcoming(track: Track): boolean {
    const items = this.q.items;
    const keep = items.filter((t, k) => k <= this.q.index || t.id !== track.id);
    if (keep.length === items.length) return false;
    this.q = { ...this.q, items: keep, original: this.q.original?.filter((t) => t.id !== track.id) };
    this.syncQueue();
    return true;
  }

  private applyPrefs(p: PlayerPrefs) {
    this.mixer.setVolume(p.volume, p.muted, 0);
    this.repeat = p.repeat;
    this.crossfadeMs = p.crossfadeMs;
    if (p.shuffle && !this.q.items.length) this.q = { ...this.q, original: [] };
    this.set({ volume: p.volume, muted: p.muted, repeat: p.repeat, shuffle: p.shuffle });
  }

  private savePrefs() {
    if (!this.persist) return;
    const s = this._state;
    void savePrefs({
      volume: this.mixer.volume,
      muted: this.mixer.muted,
      shuffle: Boolean(s.shuffle),
      repeat: this.repeat,
      crossfadeMs: this.crossfadeMs,
    }).catch(() => undefined);
  }

  /** Debounced queue/position save (`now` = write right away). */
  private save(now = false) {
    if (!this.persist) return;
    clearTimeout(this.saveTimer);
    const write = () => {
      this.lastSave = Date.now();
      const s = this._state;
      void saveResume({
        items: this.q.items,
        original: this.q.original?.map((t) => t.id),
        index: this.q.index,
        positionMs: s.positionMs,
      }).catch(() => undefined);
    };
    if (now || Date.now() - this.lastSave > SAVE_EVERY_MS) write();
    else this.saveTimer = setTimeout(write, 1000);
  }

  private bindPlatform() {
    bindMediaSession({
      play: () => void this.play(),
      pause: () => this.pause(),
      stop: () => this.stop(),
      next: () => void this.next(),
      prev: () => void this.prev(),
      seek: (ms) => this.seek(ms),
      seekBy: (d) => this.seekBy(d),
    });
    const flush = () => this.save(true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  }
}

export const player = new Player();

if (typeof window !== 'undefined') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  (w.__hostcaster ??= {}).player = player;
}
