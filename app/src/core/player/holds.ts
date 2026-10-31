// Breaks between tracks (holdAfterCurrent). A break may talk as long as it likes while a voice is playing; it is
// cut when nothing has happened for `idleTimeoutMs` (stuck generation, lost network) or after `maxMs` in total.

export type HoldFn = (signal: AbortSignal) => Promise<void> | void;

export interface HoldOptions {
  /** cut the break after this long in total (default HOLD_MAX_MS, at most 10 min) */
  maxMs?: number;
  /** cut it after this long without voice activity (default: the runner's idle timeout) */
  idleMs?: number;
}

interface HoldEntry {
  fn: HoldFn;
  maxMs: number;
  idleMs: number;
}

export type HoldEnd = 'done' | 'error' | 'timeout' | 'skip' | 'pause';

export interface HoldResult {
  /** how the last break ended */
  reason: HoldEnd;
  /** the break started the next track itself (talk over intro) */
  intro: boolean;
}

export interface HoldRunnerOptions {
  idleTimeoutMs?: number;
  maxMs?: number;
  voiceBusy: () => boolean;
  stopVoice: () => void;
  onChange: (holding: boolean) => void;
}

export const HOLD_IDLE_TIMEOUT_MS = 25_000;
export const HOLD_MAX_MS = 180_000;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export class HoldRunner {
  private queue: HoldEntry[] = [];
  private current?: { controller: AbortController; lastActivity: number; intro: boolean; reason?: HoldEnd };
  private readonly idleMs: number;
  private readonly maxMs: number;

  constructor(private o: HoldRunnerOptions) {
    this.idleMs = o.idleTimeoutMs ?? HOLD_IDLE_TIMEOUT_MS;
    this.maxMs = o.maxMs ?? HOLD_MAX_MS;
  }

  get pending(): boolean {
    return this.queue.length > 0;
  }

  get running(): boolean {
    return Boolean(this.current);
  }

  add(fn: HoldFn, opts: HoldOptions = {}): void {
    const maxMs = opts.maxMs && opts.maxMs > 0 ? clamp(opts.maxMs, 50, 600_000) : this.maxMs;
    const idleMs = opts.idleMs && opts.idleMs > 0 ? clamp(opts.idleMs, 20, maxMs) : Math.min(this.idleMs, maxMs);
    this.queue.push({ fn, maxMs, idleMs });
  }

  /** drop breaks that have not started */
  clear(): void {
    this.queue = [];
  }

  activity(): void {
    if (this.current) this.current.lastActivity = Date.now();
  }

  markIntro(): void {
    if (this.current) this.current.intro = true;
  }

  /** a break is on air between two songs (the next one has not started under it yet) */
  get between(): boolean {
    return Boolean(this.current && !this.current.intro);
  }

  /**
   * Stops the running break (Next, pause). Breaks queued for the same gap are dropped too; once the break started
   * the next song (talk over intro), queued breaks belong to that song's end and stay.
   */
  abort(reason: 'skip' | 'pause'): void {
    if (!this.current) return;
    if (!this.current.intro) this.queue = [];
    this.current.reason = reason;
    this.current.controller.abort(reason);
    this.o.stopVoice();
  }

  async run(): Promise<HoldResult> {
    const result: HoldResult = { reason: 'done', intro: false };
    if (!this.queue.length) return result;
    this.o.onChange(true);
    try {
      while (this.queue.length) {
        const entry = this.queue.shift()!;
        const cur = { controller: new AbortController(), lastActivity: Date.now(), intro: false } as NonNullable<
          HoldRunner['current']
        >;
        this.current = cur;
        result.reason = await this.runOne(entry, cur);
        result.intro ||= cur.intro;
        if (result.reason === 'skip' || result.reason === 'pause') break;
        // the next song is already playing (talk over intro): the rest waits for that song to end
        if (cur.intro) break;
      }
    } finally {
      this.current = undefined;
      this.o.onChange(false);
    }
    return result;
  }

  private runOne({ fn, maxMs, idleMs }: HoldEntry, cur: NonNullable<HoldRunner['current']>): Promise<HoldEnd> {
    const started = Date.now();
    return new Promise<HoldEnd>((resolve) => {
      let settled = false;
      const finish = (reason: HoldEnd) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        cur.controller.signal.removeEventListener('abort', onAbort);
        resolve(reason);
      };
      const onAbort = () => finish(cur.reason ?? 'skip');
      cur.controller.signal.addEventListener('abort', onAbort);
      const watch = setInterval(() => {
        const now = Date.now();
        const idle = !this.o.voiceBusy() && now - cur.lastActivity > idleMs;
        if (idle || now - started > maxMs) {
          cur.reason = 'timeout';
          cur.controller.abort('timeout');
          this.o.stopVoice();
        }
      }, Math.min(500, Math.max(20, idleMs / 4)));
      Promise.resolve()
        .then(() => fn(cur.controller.signal))
        .then(
          () => finish('done'),
          (err: unknown) => {
            if (!cur.controller.signal.aborted) console.warn('[hostcaster] break failed, playing on', err);
            finish(cur.reason ?? 'error');
          },
        );
    });
  }
}
