// YouTube IFrame Player adapter: plays 'youtube' tracks (ref = videoId) in YouTube's own embedded player.
// The video shows in Now Playing (ServiceVideoSlot); volume() / rampVolume() let the radio duck it under voices.
// A cue is applied by the player asynchronously and wins over commands sent right after it: cueVideoById followed at
// once by playVideo() or loadVideoById() leaves the video cued forever (measured). So a new video always starts with
// loadVideoById and no cue in flight: load() cues only when no play() follows (a paused load shows the picture).
// https://developers.google.com/youtube/iframe_api_reference
import { PlaybackError } from '../../player/errors';
import type { AdapterEvents, PlayerAdapter, Track } from '../../types';
import { adapterEmitter, clamp01, rampSteps } from '../adapterkit';
import { playerMount, setYouTubeActive } from './host';
import { youTubeNeedsScreen } from './screenRule';
import { YT_STATE, loadRealApi, youTubeError, type YtPlayer, type YtPlayerCtor } from './iframe';
import { YouTubeScout } from './scout';

export { YT_STATE, youTubeError, youTubeErrorMessage, type YtPlayer, type YtPlayerCtor, type YtPlayerOptions } from './iframe';

/** a paused load cues the picture after this long, unless play() came first */
const CUE_DELAY_MS = 300;
/** longest wait for a cue in flight to land before a start */
const CUE_LAND_MS = 1500;

export interface YouTubeAdapterOptions {
  /** returns the YT.Player constructor (tests pass a fake) */
  loadApi?: () => Promise<YtPlayerCtor>;
  /** element to mount into (tests); default = the shared fixed host */
  mount?: () => HTMLElement;
  /** element for the hidden check player (tests) */
  scoutMount?: () => HTMLElement;
  /** no sign of loading after this long: the video is not coming (ms) */
  startTimeoutMs?: number;
  /** still buffering after this long: give up (slow network) (ms) */
  slowStartTimeoutMs?: number;
  /** nothing happened after this long: send the start again once (ms) */
  retryMs?: number;
}

interface PendingStart {
  ref: string;
  resolve: () => void;
  reject: (e: Error) => void;
  begun: number;
  retried: boolean;
  buffering: boolean;
}

export class YouTubeAdapter implements PlayerAdapter {
  readonly id = 'youtube';
  private em = adapterEmitter();
  private yt?: YtPlayer;
  private creating?: Promise<YtPlayer>;
  private track?: Track;
  private cuedId?: string;
  /** the video that reached "playing" since it was loaded (play() then resumes instead of reloading) */
  private startedId?: string;
  private vol = 1;
  private cancelRamp: () => void = () => {};
  private ticker?: ReturnType<typeof setInterval>;
  private watch?: ReturnType<typeof setInterval>;
  private pending?: PendingStart;
  private pendingSeekMs = 0;
  private lastState: number = YT_STATE.unstarted;
  /** a deferred cue (paused load) and one sent but not landed yet (state 5 not seen) */
  private cueTimer?: ReturnType<typeof setTimeout>;
  private cueSent?: { ref: string; at: number };
  /** an IFrame error for this video before play() asked for it (e.g. while the player was being created) */
  private earlyError?: { ref: string; err: PlaybackError };
  private endWatch = { pos: -1, at: 0, fired: '', last: -1 };
  private scout?: YouTubeScout;

  constructor(private opts: YouTubeAdapterOptions = {}) {}

  canPlay(track: Track): boolean {
    return track.source === 'youtube';
  }

  on<E extends keyof AdapterEvents>(event: E, cb: (payload: AdapterEvents[E]) => void): () => void {
    return this.em.on(event, cb);
  }

  private ensure(videoId: string): Promise<YtPlayer> {
    if (this.yt) return Promise.resolve(this.yt);
    this.creating ??= (async () => {
      const Ctor = await (this.opts.loadApi ?? loadRealApi)();
      const mount = (this.opts.mount ?? playerMount)();
      return new Promise<YtPlayer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new PlaybackError('YouTube player did not start. Check your connection.', 'failed')), 20000);
        new Ctor(mount, {
          width: '100%',
          height: '100%',
          videoId,
          playerVars: {
            autoplay: 0,
            // phone apps: YouTube's own controls in the visible player; web: the app's controls only
            controls: youTubeNeedsScreen ? 1 : 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            playsinline: 1,
            rel: 0,
            ...(typeof location !== 'undefined' && location.origin.startsWith('http') ? { origin: location.origin } : {}),
          },
          events: {
            onReady: (e) => {
              clearTimeout(timer);
              this.yt = e.target;
              this.cuedId = videoId;
              e.target.setVolume(Math.round(this.vol * 100));
              const iframe = e.target.getIframe?.();
              if (iframe) {
                iframe.style.width = '100%';
                iframe.style.height = '100%';
                iframe.setAttribute('title', 'YouTube video player');
              }
              resolve(e.target);
            },
            onStateChange: (e) => this.onState(e.data),
            onError: (e) => this.onError(e.data),
            onAutoplayBlocked: () =>
              this.fail(new PlaybackError('The browser paused YouTube until you press play.', 'needs-gesture')),
          },
        });
      });
    })();
    this.creating.catch(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  async load(track: Track): Promise<void> {
    this.stopTicker();
    this.track = track;
    this.pendingSeekMs = 0;
    this.startedId = undefined;
    if (this.earlyError?.ref !== track.ref) this.earlyError = undefined;
    setYouTubeActive(true);
    this.em.emit('time', { positionMs: 0, durationMs: track.durationMs });
    const known = this.scout?.known(track.ref);
    if (known && known !== 'ok') throw known;
    const yt = await this.ensure(track.ref);
    // a paused load shows the video's picture; a play() right after cancels this (it would race the start)
    this.cancelCue();
    if (this.track === track && this.cuedId !== track.ref) {
      this.cueTimer = setTimeout(() => {
        this.cueTimer = undefined;
        if (this.track !== track || this.pending || this.startedId === track.ref) return;
        yt.cueVideoById({ videoId: track.ref });
        this.cuedId = track.ref;
        this.cueSent = { ref: track.ref, at: Date.now() };
      }, CUE_DELAY_MS);
    }
  }

  private cancelCue() {
    if (this.cueTimer) clearTimeout(this.cueTimer);
    this.cueTimer = undefined;
  }

  play(): Promise<void> {
    const track = this.track;
    if (!track) return Promise.resolve();
    this.cancelCue();
    // start synchronously when the player exists (keeps the user's click gesture for autoplay rules)
    if (this.yt) return this.start(this.yt, track);
    return this.ensure(track.ref).then((yt) => (this.track === track ? this.start(yt, track) : undefined));
  }

  /** Checks ahead that `track` can play here (hidden second player, cue only). */
  probe(track: Track): Promise<void> {
    if (track.source !== 'youtube') return Promise.resolve();
    this.scout ??= new YouTubeScout({ loadApi: this.opts.loadApi ?? loadRealApi, mount: this.opts.scoutMount });
    return this.scout.check(track.ref);
  }

  private start(yt: YtPlayer, track: Track): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.settlePending();
      if (this.earlyError?.ref === track.ref) {
        reject(this.earlyError.err);
        return;
      }
      this.pending = { ref: track.ref, resolve, reject, begun: Date.now(), retried: false, buffering: false };
      yt.unMute();
      yt.setVolume(Math.round(this.vol * 100));
      const seekS = this.pendingSeekMs / 1000;
      this.pendingSeekMs = 0;
      if (this.startedId === track.ref) {
        // resume after a pause
        if (seekS) yt.seekTo(seekS, true);
        yt.playVideo();
        if (yt.getPlayerState() === YT_STATE.playing) this.onState(YT_STATE.playing);
      } else {
        const go = () => {
          if (this.pending?.ref !== track.ref) return;
          this.cuedId = track.ref;
          this.cueSent = undefined;
          yt.loadVideoById(seekS ? { videoId: track.ref, startSeconds: seekS } : { videoId: track.ref });
        };
        // a cue still on its way would win over this start: let it land first (it lands within ~100 ms)
        const c = this.cueSent;
        const inFlight = c && Date.now() - c.at < CUE_LAND_MS && yt.getPlayerState() !== YT_STATE.cued;
        if (inFlight) this.afterCue(yt, go);
        else go();
      }
      this.startWatch(yt);
    });
  }

  private afterCue(yt: YtPlayer, go: () => void) {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (yt.getPlayerState() === YT_STATE.cued || Date.now() - t0 >= CUE_LAND_MS) {
        clearInterval(poll);
        go();
      }
    }, 25);
  }

  /**
   * A start that shows no sign of life is sent once more; one that never even buffers is given up quickly (the
   * video is not coming); one that buffers gets longer (slow network) before the player moves on.
   */
  private startWatch(yt: YtPlayer) {
    this.stopWatch();
    this.watch = setInterval(() => {
      const p = this.pending;
      if (!p) return this.stopWatch();
      const waited = Date.now() - p.begun;
      const state = yt.getPlayerState();
      const loading = state === YT_STATE.buffering;
      if (loading) p.buffering = true;
      // idle (cued / unstarted) this long: the start was lost (e.g. behind a cue), send it again once
      if (!p.retried && !loading && state !== YT_STATE.playing && waited >= (this.opts.retryMs ?? 3500)) {
        p.retried = true;
        p.begun = Date.now() - Math.min(waited, 3000);
        yt.loadVideoById({ videoId: p.ref });
        return;
      }
      if (waited >= (loading ? (this.opts.slowStartTimeoutMs ?? 20_000) : (this.opts.startTimeoutMs ?? 9000))) {
        this.fail(
          loading
            ? new PlaybackError('YouTube is taking too long to load this video. Check your connection.', 'failed')
            : new PlaybackError('YouTube did not start playing. Check your connection and try again.', 'failed'),
        );
      }
    }, 250);
  }

  private stopWatch() {
    if (this.watch) clearInterval(this.watch);
    this.watch = undefined;
  }

  pause(): void {
    this.yt?.pauseVideo();
  }

  seek(ms: number): void {
    if (!this.yt || this.startedId !== this.track?.ref) {
      this.pendingSeekMs = Math.max(0, ms);
      return;
    }
    this.yt.seekTo(Math.max(0, ms) / 1000, true);
    this.emitTime();
  }

  volume(level: number): void {
    this.cancelRamp();
    this.setVol(level);
  }

  rampVolume(level: number, ms: number): void {
    this.cancelRamp();
    this.cancelRamp = rampSteps(this.vol, clamp01(level), ms, (v) => this.setVol(v));
  }

  /** 0..100 as the YouTube player reports it (tests and debugging); undefined before the player exists. */
  playerVolume(): number | undefined {
    return this.yt?.getVolume?.();
  }

  private setVol(v: number) {
    this.vol = clamp01(v);
    this.yt?.setVolume(Math.round(this.vol * 100));
  }

  unload(): void {
    this.cancelCue();
    this.stopTicker();
    this.stopWatch();
    this.cancelRamp();
    this.settlePending();
    this.yt?.stopVideo();
    this.track = undefined;
    this.startedId = undefined;
    setYouTubeActive(false);
  }

  private settlePending() {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    this.stopWatch();
    p.resolve();
  }

  private onError(code: number) {
    const err = youTubeError(code);
    const ref = this.pending?.ref ?? this.track?.ref ?? this.cuedId;
    if (ref && !this.pending) this.earlyError = { ref, err };
    this.fail(err);
  }

  /** A start in flight is rejected (the player handles it); otherwise the error is an event (mid-song). */
  private fail(err: Error) {
    const p = this.pending;
    if (p) {
      this.pending = undefined;
      this.stopWatch();
      p.reject(err);
      return;
    }
    if (this.startedId && this.startedId === this.track?.ref) this.em.emit('error', err);
  }

  private emitTime() {
    if (!this.yt || !this.track) return;
    const durationMs = Math.round((this.yt.getDuration() || 0) * 1000) || this.track.durationMs;
    const positionMs = Math.round((this.yt.getCurrentTime() || 0) * 1000);
    this.em.emit('time', { positionMs, durationMs });
    this.watchEnd(positionMs, durationMs);
  }

  /**
   * Ends that YouTube does not report: a Short loops back to 0 without ENDED (measured), and now and then a video
   * stalls on its last frame. A jump from the last seconds back to the start, or 3 s stuck at the end, is the end.
   */
  private watchEnd(positionMs: number, durationMs: number) {
    const ref = this.track?.ref ?? '';
    const last = this.endWatch.last;
    this.endWatch.last = positionMs;
    if (this.startedId === ref && durationMs > 0 && last >= durationMs - 2500 && positionMs < last - 4000) {
      this.ended();
      this.yt?.pauseVideo(); // a looping Short would play on under the break
      return;
    }
    if (this.lastState !== YT_STATE.playing && this.lastState !== YT_STATE.buffering) return;
    if (!(durationMs > 0) || durationMs - positionMs > 1500 || this.endWatch.fired === ref) {
      this.endWatch.pos = -1;
      return;
    }
    const now = Date.now();
    if (positionMs !== this.endWatch.pos) {
      this.endWatch.pos = positionMs;
      this.endWatch.at = now;
      return;
    }
    if (now - this.endWatch.at >= 3000) this.ended();
  }

  private ended() {
    const ref = this.track?.ref ?? '';
    if (this.endWatch.fired === ref) return;
    this.endWatch.fired = ref;
    this.stopTicker();
    this.em.emit('ended', undefined);
  }

  private startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => this.emitTime(), 250);
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** IFrame API state -> adapter events. Public for tests. */
  onState(state: number): void {
    const prev = this.lastState;
    this.lastState = state;
    if (!this.track) return;
    switch (state) {
      case YT_STATE.playing: {
        const p = this.pending;
        const fresh = this.startedId !== this.track.ref;
        this.startedId = this.track.ref;
        if (fresh) this.endWatch = { pos: -1, at: 0, fired: '', last: -1 };
        if (p) {
          this.pending = undefined;
          this.stopWatch();
          p.resolve();
        }
        this.startTicker();
        if (prev !== YT_STATE.playing) this.em.emit('play', undefined);
        this.emitTime();
        break;
      }
      case YT_STATE.buffering:
        if (this.pending) this.pending.buffering = true;
        break;
      case YT_STATE.cued:
        this.cueSent = undefined;
        break;
      case YT_STATE.paused:
        // the old video pausing while the next one loads, or a looping Short stopped at its end
        if (this.startedId !== this.track.ref || this.endWatch.fired === this.track.ref) break;
        this.stopTicker();
        this.emitTime();
        if (prev !== YT_STATE.paused) this.em.emit('pause', undefined);
        break;
      case YT_STATE.ended:
        if (this.startedId !== this.track.ref) break;
        this.emitTime();
        this.ended();
        break;
    }
  }
}
