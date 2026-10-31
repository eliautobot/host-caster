// Checks upcoming YouTube videos while another song plays: a second hidden player cues each one (no playback, no
// sound) and reports YouTube's verdict. A video whose owner turned embedding off, or that was removed, answers
// with an IFrame error within a second, so the station can leave it out before the host announces it.
import { PlaybackError } from '../../player/errors';
import { scoutMount } from './host';
import { YT_STATE, youTubeError, type YtPlayer, type YtPlayerCtor } from './iframe';

export interface ScoutOptions {
  loadApi: () => Promise<YtPlayerCtor>;
  mount?: () => HTMLElement;
  /** after the cue lands, wait this long for a late error (ms) */
  settleMs?: number;
  /** no verdict after this long = unknown (treated as playable) */
  timeoutMs?: number;
}

type Verdict = 'ok' | PlaybackError;

export class YouTubeScout {
  private yt?: YtPlayer;
  private creating?: Promise<YtPlayer>;
  private verdicts = new Map<string, Verdict>();
  private chain: Promise<unknown> = Promise.resolve();
  private current?: { ref: string; done: (v: Verdict | undefined) => void; cued: boolean };

  constructor(private o: ScoutOptions) {}

  /** Resolves when `videoId` can play (or YouTube gave no verdict in time); rejects with a PlaybackError when not. */
  check(videoId: string): Promise<void> {
    const known = this.verdicts.get(videoId);
    if (known === 'ok') return Promise.resolve();
    if (known) return Promise.reject(known);
    const run = this.chain.then(() => this.checkOne(videoId));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** What is already known about `videoId` (no network). */
  known(videoId: string): Verdict | undefined {
    return this.verdicts.get(videoId);
  }

  private async checkOne(ref: string): Promise<void> {
    const known = this.verdicts.get(ref);
    if (known === 'ok') return;
    if (known) throw known;
    const verdict = await new Promise<Verdict | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (v: Verdict | undefined) => {
        if (this.current?.ref !== ref) return;
        this.current = undefined;
        clearTimeout(timer);
        resolve(v);
      };
      this.current = { ref, done, cued: false };
      timer = setTimeout(() => done(undefined), this.o.timeoutMs ?? 8000);
      const fresh = !this.yt && !this.creating;
      this.ensure(ref).then(
        (yt) => {
          if (this.current?.ref !== ref) return;
          // a player made for this video already cued it; otherwise cue it now
          if (fresh) this.settle(ref);
          else yt.cueVideoById({ videoId: ref });
        },
        () => done(undefined),
      );
    });
    if (verdict === undefined) return; // no answer: let the real start decide
    this.verdicts.set(ref, verdict);
    if (verdict !== 'ok') throw verdict;
  }

  private settle(ref: string) {
    const cur = this.current;
    if (!cur || cur.ref !== ref || cur.cued) return;
    cur.cued = true;
    setTimeout(() => this.current?.ref === ref && this.current.done('ok'), this.o.settleMs ?? 1200);
  }

  private ensure(videoId: string): Promise<YtPlayer> {
    if (this.yt) return Promise.resolve(this.yt);
    this.creating ??= (async () => {
      const Ctor = await this.o.loadApi();
      return new Promise<YtPlayer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('YouTube check player did not start')), 20000);
        new Ctor((this.o.mount ?? scoutMount)(), {
          width: 200,
          height: 200,
          videoId,
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            playsinline: 1,
            ...(typeof location !== 'undefined' && location.origin.startsWith('http') ? { origin: location.origin } : {}),
          },
          events: {
            onReady: (e) => {
              clearTimeout(timer);
              this.yt = e.target;
              e.target.setVolume(0);
              resolve(e.target);
            },
            onStateChange: (e) => {
              const cur = this.current;
              if (cur && e.data === YT_STATE.cued) this.settle(cur.ref);
            },
            onError: (e) => this.current?.done(youTubeError(e.data)),
          },
        });
      });
    })();
    this.creating.catch(() => {
      this.creating = undefined;
    });
    return this.creating;
  }
}
