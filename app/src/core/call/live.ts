// "Call the station": one live call at a time, for the whole app. The screen (ui/call) mirrors `liveCall.state`.
// The call holds the music and keeps the radio's breaks off the air; on hang up the hosts' side of the call goes in
// the On-air history (the next break knows about it) and the listener's words are in the journal (each turn).
import { addBreak, getSettings, getStation } from '../db';
import { radio } from '../radio';
import { summarize } from '../context/context';
import { createEmitter } from '../util/emitter';
import { hostsBrain } from './brain';
import { callEars } from './ears';
import { hostsMouth } from './mouth';
import { callMusic } from './music';
import { ring } from './ring';
import { CallSession, DEFAULT_LIMITS, type CallState } from './session';

export interface LiveCallState extends CallState {
  /** a call is open (ringing to ended-but-still-shown) */
  open: boolean;
  stationName?: string;
  hostIds: string[];
  leadId?: string;
  /** the station's hosts have no AI brain: requests and notes only */
  scripted?: boolean;
  /** it could not start (no station, no hosts) */
  error?: string;
  /** ms each sentence's voice took (the host's own voice engine; a stand-in device voice is not counted) */
  voicedMs: number[];
  maxMs: number;
  warnMs: number;
}

const closed: LiveCallState = { open: false, status: 'ended', mic: 'on', lines: [], metrics: { turns: [] }, hostIds: [], voicedMs: [], maxMs: DEFAULT_LIMITS.maxMs, warnMs: DEFAULT_LIMITS.warnMs };

class LiveCall {
  private emitter = createEmitter<{ state: LiveCallState }>();
  private _state: LiveCallState = closed;
  private session?: CallSession;
  private starting = false;
  /** hung up before the call was set up */
  private cancelled = false;
  private cancelRing?: AbortController;

  get state(): LiveCallState {
    return this._state;
  }

  get active(): boolean {
    return this._state.open && this._state.status !== 'ended';
  }

  on(cb: (s: LiveCallState) => void): () => void {
    return this.emitter.on('state', cb);
  }

  private set(patch: Partial<LiveCallState>) {
    this._state = { ...this._state, ...patch };
    this.emitter.emit('state', this._state);
  }

  /** Tap on Call: the music fades, the phone rings and the lead host picks up. Resolves when the call is over. */
  async start(): Promise<void> {
    if (this.active || this.starting) return;
    this.starting = true;
    this.cancelled = false;
    const t0 = Date.now();
    // the ring and the fade start right away; the hosts get ready meanwhile
    const cancel = (this.cancelRing = new AbortController());
    this.set({ ...closed, open: true, status: 'ringing', error: undefined });
    radio.setCall(true);
    const music = callMusic(() => ({ anyApp: radio.anyAppActive }));
    const held = music.hold().catch(() => undefined);
    const ringing = ring(cancel.signal);
    try {
      const id = radio.state.stationId ?? (await getSettings()).activeStationId;
      const station = id ? await getStation(id) : undefined;
      if (!station) throw new Error('Pick a station first, then call it.');
      const brain = await hostsBrain(station, 'voice', {
        requestSong: (said) => radio.requestSong(said),
        nowPlaying: () => summarize(radio.nowPlaying),
        music: radio.musicHooks(),
      });
      const ears = await callEars(brain.hosts[0]?.language);
      const session = new CallSession({
        brain,
        ears,
        mouth: hostsMouth(brain.hosts, { onVoiced: (ms) => this.set({ voicedMs: [...this._state.voicedMs, ms].slice(-200) }) }),
        music: { hold: () => held, resume: () => music.resume() },
        ring: () => ringing,
        now: () => Date.now(),
        onEnd: (s) => this.finish(s, station.id),
      });
      this.session = session;
      // the ring already started: the pickup counts from the tap
      let pickup: number | undefined;
      session.on((s) => {
        if (pickup === undefined && s.metrics.pickupMs !== undefined) pickup = Date.now() - t0;
        this.set({ ...s, metrics: { ...s.metrics, pickupMs: pickup } });
      });
      this.set({ stationName: station.name, hostIds: brain.hosts.map((h) => h.id), leadId: brain.lead.id, scripted: !brain.brain, mic: session.state.mic });
      this.starting = false;
      const run = session.start();
      if (this.cancelled) void session.hangUp();
      await run;
    } catch (err) {
      cancel.abort();
      this.starting = false;
      await held;
      await music.resume().catch(() => undefined);
      radio.setCall(false);
      this.set({ status: 'ended', error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.starting = false;
    }
  }

  private async finish(s: CallState, stationId: string): Promise<void> {
    radio.setCall(false);
    const hostLines = s.lines.filter((l) => l.who === 'host' && l.hostId).map((l) => ({ hostId: l.hostId!, text: l.text }));
    // the call in the On-air history (and the next break's "what was just said")
    if (hostLines.length > 1 || s.lines.some((l) => l.who === 'you')) await addBreak({ stationId, at: Date.now(), lines: hostLines, topics: ['call'] }).catch(() => undefined);
  }

  hangUp(): void {
    this.cancelled = true;
    if (this.session && this.active) void this.session.hangUp();
    // not set up yet: the ring stops now and the call ends as soon as it is
    else this.cancelRing?.abort();
  }

  talk(): void {
    this.session?.talk();
  }

  toggleMute(): void {
    this.session?.toggleMute();
  }

  type(text: string): void {
    this.session?.type(text);
  }

  /** The ended call's screen goes away. */
  close(): void {
    if (this.active) return;
    this.session = undefined;
    this.set({ open: false });
  }
}

export type { LiveCall };
export const liveCall = new LiveCall();
