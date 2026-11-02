// One live call with the station: ring -> the lead host picks up -> listen -> think -> speak -> listen ... until the
// listener hangs up (or says "bye"), goes quiet for good, or the call reaches its length cap. The music is held for
// the whole call and comes back where it was. Everything outside (ears, voice, brain, music, clock) comes in as
// dependencies, so the whole state machine runs in unit tests with fakes.
import { createEmitter } from '../util/emitter';
import { isGoodbye } from './phrases';

export type CallStatus = 'ringing' | 'listening' | 'thinking' | 'speaking' | 'ending' | 'ended';
/** on = listening when it is the listener's turn; muted = by the listener; blocked = permission refused; none = no speech to text here */
export type MicState = 'on' | 'muted' | 'blocked' | 'none';
export type EndReason = 'you' | 'goodbye' | 'silence' | 'limit' | 'error';

export interface HostLine {
  hostId: string;
  text: string;
}

export interface CallLine {
  id: number;
  who: 'you' | 'host';
  hostId?: string;
  text: string;
  at: number;
}

export interface TurnReply {
  lines: HostLine[];
  /** a question that waits for a yes or a no (core/actions): the call screen shows its card */
  actionId?: string;
  /** why the hosts could not answer properly (shown on the call screen) */
  notice?: string;
  /** "remember that ...": what the hosts now remember */
  remembered?: string;
}

export interface CallBrain {
  lead: { id: string; name: string };
  greeting(): HostLine[];
  reply(said: string, history: CallLine[], opts: { signal: AbortSignal; onLookup: () => void }): Promise<TurnReply>;
  holdLine(): HostLine;
  stillThere(): HostLine;
  wrapUp(): HostLine;
  signOff(): HostLine;
  limitWarning(minutesLeft: number): HostLine;
  limit(): HostLine;
}

export interface ListenOptions {
  /** aborted: stop and throw away what was heard (hang up, mute) */
  signal: AbortSignal;
  /** aborted: stop now and resolve with what was heard so far (the listener tapped Done) */
  finish: AbortSignal;
  onPartial: (text: string) => void;
  /** give up after this long with what was heard ('' for nothing) */
  maxMs: number;
}

export interface Ears {
  /** what the microphone is: none = this device cannot turn speech into text (typing still works) */
  kind: 'native' | 'web' | 'fake' | 'none';
  /** it can listen while a host speaks (talking over a host stops them) */
  overlap: boolean;
  /** One utterance: resolves at its end with the words ('' = nothing said). Rejects with MicBlocked. */
  listen(opts: ListenOptions): Promise<string>;
}

export class MicBlocked extends Error {
  override name = 'MicBlocked';
}

/** Speech to text can not work here (no speech service behind the recognizer, no microphone): the call is typed. */
export class NoSpeech extends Error {
  override name = 'NoSpeech';
}

const NO_SPEECH_NOTE = 'Talking is not available here, so type your side of the call.';

export interface Mouth {
  /** voice lines ahead of time (the greeting while the phone rings) */
  prime?(lines: HostLine[]): void;
  /** speaks the lines in order, sentence by sentence; resolves when done or aborted */
  say(lines: HostLine[], opts: { signal: AbortSignal; onLine: (line: HostLine) => void }): Promise<void>;
  stop(): void;
}

export interface Music {
  hold(): Promise<void>;
  resume(): Promise<void>;
}

export interface CallLimits {
  /** "still there?" after this long without a word */
  stillThereMs: number;
  /** then the host wraps up after this long more */
  wrapUpMs: number;
  /** the call's length cap, and the heads-up before it */
  maxMs: number;
  warnMs: number;
  /** a lookup that is not done this long after it started: the host holds the line */
  holdAfterMs: number;
}

export const DEFAULT_LIMITS: CallLimits = { stillThereMs: 12_000, wrapUpMs: 30_000, maxMs: 20 * 60_000, warnMs: 18 * 60_000, holdAfterMs: 2500 };

export interface CallMetrics {
  /** tap -> the first word of the pickup line */
  pickupMs?: number;
  /** per turn: end of the listener's words -> the host's first words */
  turns: { said: string; replyMs: number }[];
}

export interface CallState {
  status: CallStatus;
  mic: MicState;
  lines: CallLine[];
  /** the listener's words so far (live captions) */
  partial?: string;
  speakingHostId?: string;
  /** the line being spoken */
  caption?: string;
  /** when the host picked up (the call timer) */
  startedAt?: number;
  /** a question waiting for yes or no */
  actionId?: string;
  notice?: string;
  /** the call is close to its cap */
  warned?: boolean;
  endedReason?: EndReason;
  /** a lookup is running for this turn */
  lookingUp?: boolean;
  metrics: CallMetrics;
}

export interface CallDeps {
  brain: CallBrain;
  ears: Ears;
  mouth: Mouth;
  music: Music;
  ring(signal: AbortSignal): Promise<void>;
  limits?: Partial<CallLimits>;
  now?: () => number;
  /** the call is over (journal, history) */
  onEnd?: (state: CallState) => void | Promise<void>;
}

/** Is `heard` only the host's own words picked up by the microphone (a phone on speaker)? */
export function isEcho(heard: string, spoken: string): boolean {
  const w = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, ' ')
      .split(/\s+/)
      .filter((x) => x.length > 2);
  const h = w(heard);
  if (!h.length) return true;
  const said = new Set(w(spoken));
  return h.filter((x) => said.has(x)).length / h.length >= 0.6;
}

const aborted = (s: AbortSignal) => s.aborted;

export class CallSession {
  private emitter = createEmitter<{ state: CallState }>();
  private _state: CallState = { status: 'ringing', mic: 'on', lines: [], metrics: { turns: [] } };
  private readonly limits: CallLimits;
  private readonly now: () => number;
  /** hang up: everything stops */
  private life = new AbortController();
  /** the phase running now (listen / think / speak): aborted by a barge-in, mute or typed words */
  private phase?: AbortController;
  private finishListen?: AbortController;
  /** words that arrived while the host spoke or thought (typed, or said over the host) */
  private queued: string[] = [];
  private wake?: () => void;
  private seq = 0;
  private startAt = 0;
  private limitTimers: ReturnType<typeof setTimeout>[] = [];
  private limitHit = false;
  private warnDue = false;
  private ended?: Promise<void>;
  private spokenNow = '';

  constructor(private deps: CallDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    if (deps.ears.kind === 'none') {
      this._state.mic = 'none';
      this._state.notice = NO_SPEECH_NOTE;
    }
  }

  get state(): CallState {
    return this._state;
  }

  on(cb: (s: CallState) => void): () => void {
    return this.emitter.on('state', cb);
  }

  private set(patch: Partial<CallState>) {
    this._state = { ...this._state, ...patch };
    this.emitter.emit('state', this._state);
  }

  private add(who: 'you' | 'host', text: string, hostId?: string) {
    this.set({ lines: [...this._state.lines, { id: ++this.seq, who, hostId, text, at: this.now() }] });
  }

  private get live() {
    return !this.life.signal.aborted && this._state.status !== 'ending' && this._state.status !== 'ended';
  }

  // ---------------------------------------------------------------------------------------------- listener controls

  /** Starts the call: the music fades out, the phone rings, the lead host picks up. Resolves when the call is over. */
  async start(): Promise<void> {
    this.startAt = this.now();
    const { brain, mouth, music } = this.deps;
    const greeting = brain.greeting();
    mouth.prime?.(greeting);
    await Promise.all([music.hold().catch(() => undefined), this.deps.ring(this.life.signal).catch(() => undefined)]);
    if (!this.live) return this.ended;
    this.set({ startedAt: this.now() });
    this.limitTimers.push(
      setTimeout(() => {
        this.warnDue = true;
      }, this.limits.warnMs),
      setTimeout(() => {
        this.limitHit = true;
        if (this._state.status === 'listening') this.phase?.abort();
      }, this.limits.maxMs),
    );
    await this.speak(greeting, { pickup: true });
    await this.loop();
    return this.ended;
  }

  /** The listener hangs up. The host signs off in one line and the music comes back. */
  hangUp(): Promise<void> {
    return this.end('you');
  }

  /** Mic button: stop the host (barge-in) or end what they are saying now. */
  talk(): void {
    const s = this._state.status;
    if (!this.live) return;
    if (this._state.mic === 'muted') return this.setMuted(false);
    if (s === 'speaking' || s === 'thinking') {
      this.deps.mouth.stop();
      this.phase?.abort();
    } else if (s === 'listening') this.finishListen?.abort();
  }

  setMuted(muted: boolean): void {
    if (this._state.mic === 'none' || this._state.mic === 'blocked') return;
    this.set({ mic: muted ? 'muted' : 'on', partial: muted ? undefined : this._state.partial });
    if (muted && this._state.status === 'listening') this.phase?.abort();
    if (!muted) this.wake?.();
  }

  toggleMute(): void {
    this.setMuted(this._state.mic !== 'muted');
  }

  /** Typed into the call (no microphone, or the listener prefers to type): the host answers by voice. */
  type(text: string): void {
    const t = text.trim();
    if (!t || !this.live) return;
    this.queued.push(t);
    const s = this._state.status;
    if (s === 'listening') this.phase?.abort();
    else if (s === 'speaking') {
      this.deps.mouth.stop();
      this.phase?.abort();
    }
    this.wake?.();
  }

  // ---------------------------------------------------------------------------------------------- the loop

  private async loop(): Promise<void> {
    while (this.live) {
      if (this.limitHit) return void this.end('limit');
      const said = await this.hear();
      if (said === undefined && this.limitHit && this.live) return void this.end('limit');
      if (said === undefined || !this.live) return;
      if (this.limitHit) return void this.end('limit');
      this.add('you', said);
      if (isGoodbye(said)) return void this.end('goodbye');
      const t0 = this.now();
      const reply = await this.think(said);
      if (!this.live) return;
      if (!reply) continue;
      if (reply.actionId !== undefined || this._state.actionId) this.set({ actionId: reply.actionId });
      if (reply.notice) this.set({ notice: reply.notice });
      const lines = [...reply.lines];
      if (this.warnDue && !this._state.warned) {
        this.set({ warned: true });
        lines.push(this.deps.brain.limitWarning(Math.max(1, Math.round((this.limits.maxMs - this.limits.warnMs) / 60_000))));
      }
      let first = true;
      await this.speak(lines, {
        onFirst: () => {
          if (!first) return;
          first = false;
          this.set({ metrics: { ...this._state.metrics, turns: [...this._state.metrics.turns, { said, replyMs: this.now() - t0 }] } });
        },
      });
    }
  }

  /** The listener's next words; undefined when the call ended while waiting. */
  private async hear(): Promise<string | undefined> {
    let quietSince = this.now();
    let checked = false;
    while (this.live) {
      const q = this.queued.shift();
      if (q) return q;
      if (this.limitHit) return undefined;
      const mic = this._state.mic;
      // muted, no microphone or typing: a much longer wait before "still there?"
      const slow = mic === 'on' ? 1 : 5;
      // "still there?" after a quiet stretch, then the wrap-up a while after that check
      const due = checked ? quietSince + this.limits.wrapUpMs * slow : quietSince + this.limits.stillThereMs * slow;
      if (this.now() >= due - 50) {
        if (!checked) {
          checked = true;
          await this.speak([this.deps.brain.stillThere()]);
          quietSince = this.now();
          continue;
        }
        await this.end('silence');
        return undefined;
      }
      this.set({ status: 'listening', partial: undefined, speakingHostId: undefined, caption: undefined });
      const phase = (this.phase = new AbortController());
      const finish = (this.finishListen = new AbortController());
      const stop = () => phase.abort();
      this.life.signal.addEventListener('abort', stop, { once: true });
      try {
        if (mic !== 'on') {
          // muted, blocked or no speech to text: wait for typed words, unmute or the next silence check
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, Math.max(50, due - this.now()));
            this.wake = () => {
              clearTimeout(t);
              resolve();
            };
            phase.signal.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          });
          this.wake = undefined;
          if (this._state.mic === 'on' && mic === 'muted') quietSince = this.now();
          continue;
        }
        const t0 = this.now();
        let heardAny = false;
        const text = await this.deps.ears.listen({
          signal: phase.signal,
          finish: finish.signal,
          maxMs: Math.max(250, due - this.now()),
          onPartial: (p) => {
            if (aborted(phase.signal)) return;
            heardAny ||= Boolean(p.trim());
            this.set({ partial: p });
          },
        });
        if (!this.live) return undefined;
        if (aborted(phase.signal)) continue;
        const said = text.trim();
        if (said) return said;
        if (heardAny) quietSince = this.now();
        // a recognizer that ends at once (no speech yet): do not spin
        if (this.now() - t0 < 300) await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        if (!this.live) return undefined;
        if (err instanceof MicBlocked) {
          this.set({ mic: 'blocked', notice: 'Microphone access is off. Type below, or allow the microphone and call again.' });
          quietSince = this.now();
          continue;
        }
        if (err instanceof NoSpeech) {
          this.set({ mic: 'none', notice: NO_SPEECH_NOTE });
          quietSince = this.now();
          continue;
        }
        // the recognizer failed once: try again after a moment
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        this.life.signal.removeEventListener('abort', stop);
        this.set({ partial: undefined });
      }
    }
    return undefined;
  }

  /** The brain's reply to the listener's words; undefined when cut off (barge-in, typed words, hang up). */
  private async think(said: string): Promise<TurnReply | undefined> {
    this.set({ status: 'thinking', notice: undefined, lookingUp: false });
    const phase = (this.phase = new AbortController());
    const stop = () => phase.abort();
    this.life.signal.addEventListener('abort', stop, { once: true });
    let done = false;
    let held: Promise<void> | undefined;
    try {
      const reply = this.deps.brain.reply(said, this._state.lines, {
        signal: phase.signal,
        onLookup: () => {
          this.set({ lookingUp: true });
          setTimeout(() => {
            if (!done && !held && !aborted(phase.signal) && this._state.status === 'thinking') held = this.holdTheLine(phase.signal);
          }, this.limits.holdAfterMs);
        },
      });
      const r = await Promise.race([reply, new Promise<undefined>((resolve) => phase.signal.addEventListener('abort', () => resolve(undefined)))]);
      done = true;
      if (held) await held;
      return aborted(phase.signal) ? undefined : r;
    } catch {
      done = true;
      if (aborted(phase.signal) || !this.live) return undefined;
      return { lines: [{ hostId: this.deps.brain.lead.id, text: "Sorry, I lost my train of thought there. Can you say that again?" }] };
    } finally {
      this.life.signal.removeEventListener('abort', stop);
      if (this.live) this.set({ lookingUp: false });
    }
  }

  /** "One sec, let me pull that up" while a lookup runs; the status stays 'thinking' for the screen. */
  private async holdTheLine(signal: AbortSignal): Promise<void> {
    const line = this.deps.brain.holdLine();
    this.add('host', line.text, line.hostId);
    this.set({ speakingHostId: line.hostId, caption: line.text });
    await this.deps.mouth.say([line], { signal, onLine: () => undefined }).catch(() => undefined);
    if (this.live) this.set({ speakingHostId: undefined, caption: undefined });
  }

  /**
   * The host speaks. Talking over them (ears that can listen meanwhile) or the mic button stops them; what was said
   * over them is the listener's next turn.
   */
  private async speak(lines: HostLine[], opts: { pickup?: boolean; onFirst?: () => void; final?: boolean } = {}): Promise<void> {
    if (!lines.length) return;
    const phase = (this.phase = new AbortController());
    const signal = opts.final ? new AbortController().signal : phase.signal;
    const stop = () => phase.abort();
    if (!opts.final) this.life.signal.addEventListener('abort', stop, { once: true });
    if (!opts.final) this.set({ status: 'speaking' });
    const over = !opts.final && this.deps.ears.overlap && this._state.mic === 'on' ? this.overhear(phase) : undefined;
    try {
      await this.deps.mouth.say(lines, {
        signal,
        onLine: (l) => {
          if (opts.pickup && this._state.metrics.pickupMs === undefined) this.set({ metrics: { ...this._state.metrics, pickupMs: this.now() - this.startAt } });
          opts.onFirst?.();
          this.spokenNow = l.text;
          this.add('host', l.text, l.hostId);
          this.set({ speakingHostId: l.hostId, caption: l.text });
        },
      });
    } catch {
      // a voice that failed: the captions still said it
    } finally {
      if (!opts.final) this.life.signal.removeEventListener('abort', stop);
      this.spokenNow = '';
      if (this.live || opts.final) this.set({ speakingHostId: undefined, caption: undefined });
    }
    if (over) await over.settle(aborted(phase.signal));
  }

  /** Listens while the host speaks: real words (not the host's own voice) stop the host and become the next turn. */
  private overhear(speaking: AbortController): { settle: (cut: boolean) => Promise<void> } {
    const ctl = new AbortController();
    const finish = new AbortController();
    let spoke = false;
    const p = this.deps.ears
      .listen({
        signal: ctl.signal,
        finish: finish.signal,
        maxMs: 120_000,
        onPartial: (t) => {
          if (ctl.signal.aborted || isEcho(t, this.spokenNow) || t.trim().split(/\s+/).length < 2) return;
          if (!spoke) {
            spoke = true;
            this.deps.mouth.stop();
            speaking.abort();
          }
          // the host stopped: the screen listens to the listener now
          this.set({ status: 'listening', partial: t, speakingHostId: undefined, caption: undefined });
        },
      })
      .then(
        (t) => {
          const said = t.trim();
          if (!said || ctl.signal.aborted) return;
          // a short "yes" or "stop" over the host never had two words of partials: it still counts, unless it is
          // only the host's own voice
          if (!spoke) {
            if (isEcho(said, this.spokenNow)) return;
            spoke = true;
            this.deps.mouth.stop();
            speaking.abort();
          }
          this.queued.unshift(said);
        },
        () => undefined,
      );
    return {
      settle: async (cut) => {
        // the host finished and nobody talked over them: stop listening here, the turn's own listening starts now
        if (!spoke) {
          ctl.abort();
          return;
        }
        void cut;
        await p;
      },
    };
  }

  private end(reason: EndReason): Promise<void> {
    if (this.ended) return this.ended;
    this.ended = (async () => {
      const pickedUp = this._state.startedAt !== undefined;
      this.set({ status: 'ending', endedReason: reason, partial: undefined });
      this.life.abort();
      this.phase?.abort();
      this.deps.mouth.stop();
      this.limitTimers.forEach(clearTimeout);
      const b = this.deps.brain;
      const last = reason === 'silence' ? b.wrapUp() : reason === 'limit' ? b.limit() : reason === 'error' ? undefined : b.signOff();
      if (pickedUp && last) {
        // the last line has its own few seconds: a slow voice never keeps the music away
        await Promise.race([this.speak([last], { final: true }), new Promise((r) => setTimeout(r, 7000))]);
        this.deps.mouth.stop();
      }
      await this.deps.music.resume().catch(() => undefined);
      this.set({ status: 'ended', speakingHostId: undefined, caption: undefined });
      await Promise.resolve(this.deps.onEnd?.(this._state)).catch(() => undefined);
    })();
    return this.ended;
  }
}
