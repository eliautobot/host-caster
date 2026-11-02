// core/radio: drives a station on top of `player`. Decides breaks, prepares them before the song ends (context,
// script, voice), airs them between songs. Never leaves silence: anything late or failed is skipped.
import { reportNowPlaying } from '../api';
import { addBreak, getSettings, getStation, saveSettings } from '../db';
import { markInboxUsed } from '../context/sources';
import { anyApp, mediaNotification, type AnyAppNowPlaying } from '../native';
import { player } from '../player';
import type { Break, BreakLine, HeadsUp, RadioEventName, RadioEvents, RadioState, Station, Track, TrackSummary, VoiceClip } from '../types';
import { claim, headsUpWatch, listHeadsUps, markAired, pendingHeadsUps, release, snoozeLast } from '../agent/headsup';
import { deliveryFor, isAcknowledgement, scriptedSay } from '../agent/changes';
import { createEmitter } from '../util/emitter';
import { airBreak, type AirMode } from './air';
import { planTopicKeys, shouldBreakAfter, type BreakKind } from './planner';
import { skippedNotice, standInNotice } from './notice';
import { deviceStandIn, loadLineup, prepareBreak, warmUpBrains, type PreparedBreak } from './prepare';
import { speak } from '../voice/voice';
import { extendQueue, stationQueue } from './queue';
import { isMood, isSongRequest, nextInboxRequest, queueRequest, requestQuery, type SongRequest } from './requests';
import type { NotionWrite } from './notionAsk';
import { learnFromWords, memoryOnPlay, noteBreak, noteGotIt, noteHeadsUp, noteRequested, noteSaid, startMemory, takeMemoryCommand, type MemoryChange } from '../memory';
import { maybeNotionRecap, nextInboxNotionWrite, stationBrain, takeNotionWrite } from './notionWrite';
import { takeActionTurn, type ActionTurn } from '../actions/callin';
import { addItem } from '../tracker/store';
import { markListAired } from '../tracker/brief';
import { nextInboxAction } from '../actions/inbox';

/** start writing this long before the song ends (slow local models need the head start) ... */
const PREP_LEAD_MS = 80_000;
/** ... or earlier when recent breaks took long to get ready (a slow cloud voice): twice the slowest, plus this */
const PREP_MARGIN_MS = 20_000;
const PREP_LEAD_MAX_MS = 240_000;
/** a break that is not ready when its song ends gets this long, then the next song starts */
const HOLD_GRACE_MS = 2500;
/** a late break may still air over the first seconds of the next song */
const LATE_AIR_MS = 20_000;
/** a call-in on air with less than this left in the song stands in for that song's break (no second break after it) */
const CALLIN_COVERS_MS = 60_000;
const PREP_TIMEOUT_MS = 120_000;
/** a call-in answer that needs a live lookup and is not ready this long after it started: a host holds the line */
const HOLD_LINE_AFTER_MS = 2500;
const HOLD_LINES = [
  'One sec, let me pull that up.',
  'Good question. Give me a second to check.',
  "Hang on, I'm looking that up right now.",
  'Let me check that for you, one moment.',
];

interface Pending {
  trackId: string;
  promise: Promise<PreparedBreak | undefined>;
  ready?: PreparedBreak;
  done: boolean;
  late: boolean;
  controller: AbortController;
}

class Radio {
  private emitter = createEmitter<RadioEvents>();
  private _state: RadioState = { onAir: false, nextBreakIn: 0, phase: 'off' };
  private station?: Station;
  private offs: (() => void)[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pending?: Pending;
  private songsSinceBreak = 0;
  private airedSinceTrack = false;
  private openingDone = false;
  private current?: Track;
  /** the song whose break a call-in already took (see coverBreak) */
  private coveredTrackId?: string;
  private airLock: Promise<void> = Promise.resolve();
  private session = 0;
  private live = false;
  private anyAppMode = false;
  private anyAppPrev?: TrackSummary;
  private anyAppKey = '';
  private nextStartAt = 0;
  /** the break on air (not in the log until it ends): the next break's writer must know what was just said */
  private onAirBreak?: Break;
  /** the segments of the break on air, and the last one a skip was noted for (core/memory journal) */
  private onAirSegments: string[] = [];
  private skipNoted?: string;
  private hostNames = new Map<string, string>();
  /** how long the last breaks took to get ready (ms), newest last */
  private prepTimes: number[] = [];
  /** heads-up lines voiced ahead for the break after this song (it was written before they came in) */
  private headsUpLines = new Map<string, { text: string; clip: Promise<VoiceClip> }>();
  /** a live call is on (core/call): nothing airs, the break on air stops */
  private inCall = false;
  private airing?: AbortController;

  get state(): RadioState {
    return this._state;
  }

  on<E extends RadioEventName>(event: E, cb: (payload: RadioEvents[E]) => void): () => void {
    return this.emitter.on(event, cb);
  }

  private set(patch: Partial<RadioState>) {
    this._state = { ...this._state, ...patch };
    this.emitter.emit('state', this._state);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Tells the server what is on air (AI apps can ask over MCP). Best effort. */
  private report(speakingId?: string) {
    const t = this.current;
    void reportNowPlaying({
      playing: this._state.onAir,
      onAir: this._state.onAir,
      station: this.station?.name,
      track: t ? { title: t.title, artist: t.artist, album: t.album } : undefined,
      hosts: this.station?.hostIds.map((id) => this.hostNames.get(id) ?? '').filter(Boolean),
      speaking: speakingId ? this.hostNames.get(speakingId) : undefined,
    });
  }

  // ------------------------------------------------------------------------------------------------ start / stop

  async start(stationId: string, opts: { restart?: boolean } = {}): Promise<void> {
    if (this._state.onAir && this._state.stationId === stationId && !opts.restart) {
      if (player.state.status !== 'playing') await player.play();
      return;
    }
    this.stop();
    const station = await getStation(stationId);
    if (!station) throw new Error('That station was deleted');
    startMemory();
    const q = await stationQueue(station);
    if (q.anyApp) {
      if (!anyApp.available) throw new Error('Any music app mode needs the Host-Caster Android app');
      if (!(await anyApp.hasPermission()) && !(await anyApp.requestPermission())) {
        throw new Error('Allow notification access so Host-Caster can see what your music app is playing');
      }
    } else if (!q.tracks.length) {
      throw new Error('This station has no songs yet. Add music in your Library, or pick other sources for it.');
    }
    const session = ++this.session;
    this.station = station;
    this.songsSinceBreak = 0;
    this.openingDone = false;
    this.airedSinceTrack = false;
    this.coveredTrackId = undefined;
    this.live = q.live;
    this.anyAppMode = q.anyApp;
    if ((await getSettings()).activeStationId !== station.id) await saveSettings({ activeStationId: station.id });
    this.hostNames = new Map((await loadLineup(station)).map((h) => [h.id, h.name]));
    void warmUpBrains(station);
    this.set({ stationId: station.id, onAir: true, phase: 'music', speakingHostId: undefined, caption: undefined, script: undefined, notice: undefined, noticeLink: undefined, nextBreakIn: 1 });
    this.subscribe(session);
    // heads-ups: the calendar and mail are checked every few minutes while the radio plays
    headsUpWatch.start(station, { playing: () => this.isPlaying(), deliver: (h) => this.deliverHeadsUp(h) });
    if (q.anyApp) {
      this.anyAppKey = '';
      this.anyAppPrev = undefined;
      // keeps the radio alive in the background while the other app plays
      void mediaNotification.update({ title: station.name, artist: 'Your hosts are on air' }, true, { ownAudio: false });
      const now = await anyApp.start();
      if (now?.playing) void this.onAnyAppTrack(now);
      return;
    }
    const queue = q.live ? q.tracks : extendQueue(q.tracks, station.shuffle);
    await player.load(queue, 0);
    await player.play();
  }

  stop(): void {
    this.session++;
    this.offs.forEach((off) => off());
    this.offs = [];
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.pending?.controller.abort();
    this.pending = undefined;
    headsUpWatch.stop();
    this.headsUpLines.clear();
    if (this._state.onAir && !this.anyAppMode) player.pause();
    if (this.anyAppMode) {
      void anyApp.stop();
      void mediaNotification.clear();
    }
    this.anyAppMode = false;
    player.stopVoice();
    if (this.station) void reportNowPlaying({ playing: false, onAir: false });
    this.station = undefined;
    this.current = undefined;
    this.set({ onAir: false, phase: 'off', speakingHostId: undefined, caption: undefined, script: undefined, lineIndex: undefined, nextBreakIn: 0 });
  }

  /**
   * Picks up edits to the station on air (hosts, talk settings, segments) from the next break on, without
   * restarting the music. A change of music source needs a restart, so that is left to the caller.
   */
  async reload(): Promise<void> {
    const id = this.station?.id;
    if (!id || !this._state.onAir) return;
    const fresh = await getStation(id);
    if (!fresh || this.station?.id !== id) return;
    this.station = fresh;
    this.hostNames = new Map((await loadLineup(fresh)).map((h) => [h.id, h.name]));
  }

  /** "Talk to the host": a call-in that breaks in right away (starts the tuned station when off air). */
  async talkNow(prompt?: string): Promise<void> {
    if (!this._state.onAir) {
      const id = this._state.stationId ?? (await getSettings()).activeStationId;
      if (!id) throw new Error('Pick a station first');
      await this.start(id);
    }
    const station = this.station;
    if (!station) return;
    const session = this.session;
    const said = prompt?.trim() || 'Just checking in. What is going on?';
    // "got it, thanks" after a heads-up: that item is not told again (no reminder on top of it)
    if (isAcknowledgement(said)) {
      await snoozeLast().catch(() => undefined);
      void noteGotIt(said);
    }
    // what they said goes in the journal; "remember that ..." / "forget that ..." is done now, so the answer confirms it
    if (prompt?.trim()) void noteSaid(said);
    const memory = prompt?.trim() ? await takeMemoryCommand(said, 'call').catch(() => undefined) : undefined;
    this.set({ phase: 'preparing', speakingHostId: undefined, caption: undefined, notice: undefined, noticeLink: undefined });
    // the song under the call-in, so the hosts can name what is playing
    const under = this.anyAppMode ? this.anyAppPrev : this.current;
    const request = await this.takeRequest(said);
    // "add oat milk to my list": added to Notion now, so the answer can confirm it
    // words about the calendar, Google Tasks or an invitation are for the actions engine, never a Notion note
    const forActions = /\b(calendar|google tasks?|invite|invitation|rsvp)\b/i.test(said) && !/\bnotion\b/i.test(said);
    const notion = forActions ? undefined : await takeNotionWrite(said, station).catch(() => undefined);
    // a Notion to-do is also on Your list (the listener's own words)
    if (notion?.ok && notion.kind === 'todo') void addItem({ what: notion.text, kind: 'todo', source: { type: 'you', label: 'You said it on a call-in (also in Notion)' } }).catch(() => undefined);
    // Your list ("remind me to ...", "I sent the quotes") and things the hosts can do once the listener says yes
    const action =
      prompt?.trim() && !request && !notion
        ? await takeActionTurn({ said, origin: 'call-in', brain: await stationBrain(station).catch(() => undefined) }).catch(() => undefined)
        : undefined;
    // a question that needs a live lookup: if the answer is not ready in a moment, a host says so first
    let hold: Promise<void> | undefined;
    let settled = false;
    const onLookup = () =>
      this.later(() => {
        if (!settled && !hold && session === this.session) hold = this.sayHoldLine(station).catch(() => undefined);
      }, HOLD_LINE_AFTER_MS);
    const ready = await this.prepare(station, 'callin', said, new AbortController(), under, undefined, undefined, request, undefined, notion, onLookup, memory, action);
    settled = true;
    // anything else worth remembering: learned while the answer airs (never in the way of it)
    if (prompt?.trim() && !memory) void learnFromWords(said, 'call', { stationId: station.id });
    if (hold) await hold;
    if (!ready || session !== this.session) {
      if (session === this.session) this.set({ phase: 'music' });
      if (!ready) throw new Error('Your hosts could not pick up right now. Check the Brains page.');
      return;
    }
    await this.air(ready, this.anyAppMode ? 'anyapp' : 'over', undefined, { chime: !hold });
  }

  /**
   * A live call (core/call) starts or ends. While it is on, no break, call-in answer or heads-up airs (a break
   * that is on air stops now); breaks are prepared as usual and the music is held by the call.
   */
  setCall(on: boolean): void {
    this.inCall = on;
    if (!on) return;
    this.airing?.abort();
    player.stopVoice();
    if (this._state.phase === 'talking') this.set({ phase: 'music', speakingHostId: undefined, caption: undefined, script: undefined, lineIndex: undefined });
  }

  /** The radio follows another music app (Android any-app mode). */
  get anyAppActive(): boolean {
    return this.anyAppMode;
  }

  /** The song under the hosts right now (the other app's in any-app mode). */
  get nowPlaying(): Track | TrackSummary | undefined {
    return this.anyAppMode ? this.anyAppPrev : this.current;
  }

  /** A song request from a live call or chat: queued to play next (after the call), or not found. */
  requestSong(said: string): Promise<SongRequest | undefined> {
    return this.takeRequest(said);
  }

  /** "One sec, let me pull that up": the lead host holds the line over the music while an answer is looked up. */
  private async sayHoldLine(station: Station): Promise<void> {
    const host = (await loadLineup(station))[0];
    if (!host) return;
    const text = HOLD_LINES[Math.floor(Math.random() * HOLD_LINES.length)]!;
    const clip = await speak(host, text, { timeoutMs: 6000 }).catch(() => speak(deviceStandIn(host), text));
    const session = this.session;
    const mini = {
      station,
      hosts: [host],
      plan: { kind: 'callin', topics: [], items: [], lines: 1, outro: false, intro: false, mix: 0 },
      packet: {} as PreparedBreak['packet'],
      lines: [{ hostId: host.id, text }],
      clips: [clip],
      mode: 'builtin',
      tookMs: 0,
    } satisfies PreparedBreak;
    const run = async () => {
      if (session !== this.session || this.inCall) return;
      this.set({ phase: 'talking', speakingHostId: host.id, caption: text });
      try {
        await airBreak(mini, this.anyAppMode ? 'anyapp' : 'over', { chime: true, onLine: () => undefined });
      } finally {
        if (session === this.session) this.set({ phase: 'preparing', speakingHostId: undefined, caption: undefined });
      }
    };
    const next = this.airLock.then(run, run);
    this.airLock = next.catch(() => undefined);
    await next;
  }

  /** Skips the break on air (or the one being prepared). */
  skipBreak(): void {
    this.noteSkippedBreak();
    this.pending?.controller.abort();
    this.pending = undefined;
    player.stopVoice();
  }

  // ------------------------------------------------------------------------------------------------ events

  private subscribe(session: number) {
    const live = () => session === this.session;
    if (this.anyAppMode) {
      this.offs.push(anyApp.on('trackchange', (t) => live() && void this.onAnyAppTrack(t)));
      return;
    }
    this.offs.push(
      player.on('trackstart', (t) => live() && this.onTrackStart(t)),
      player.on('nearend', (t) => live() && this.onNearEnd(t)),
      player.on('breakskip', () => live() && this.noteSkippedBreak()),
    );
  }

  private onTrackStart(track: Track) {
    const station = this.station;
    if (!station) return;
    const first = !this.current;
    if (!first && !this.airedSinceTrack) this.songsSinceBreak++;
    this.airedSinceTrack = false;
    this.coveredTrackId = undefined;
    this.current = track;
    this.nextStartAt = Date.now();
    this.report();
    memoryOnPlay(station);
    if (this.live || track.source === 'stream' || player.state.live) return this.scheduleStreamBreak(station);
    const due = !this.openingDone || shouldBreakAfter(station, this.songsSinceBreak);
    this.set({ nextBreakIn: due ? 1 : Math.max(1, station.talkEvery - this.songsSinceBreak) });
    if (!due || !station.hostIds.length) return;
    const dur = track.durationMs || player.state.durationMs;
    const wait = dur > 0 ? Math.max(0, dur - this.prepLead()) : 0;
    const id = track.id;
    this.later(() => this.current?.id === id && this.startPrep(track), wait);
  }

  private onNearEnd(track: Track) {
    if (this.current?.id === track.id && this._state.nextBreakIn <= 1) this.startPrep(track);
  }

  /** How long before a song's end its break starts getting ready: longer when recent breaks were slow. */
  prepLead(): number {
    const slowest = Math.max(0, ...this.prepTimes);
    return Math.min(PREP_LEAD_MAX_MS, Math.max(PREP_LEAD_MS, slowest * 2 + PREP_MARGIN_MS));
  }

  private notePrep(ms: number) {
    this.prepTimes = [...this.prepTimes, ms].slice(-5);
  }

  private nextTrack(): Track | undefined {
    const s = player.state;
    return s.queue[s.index + 1];
  }

  /** Starts writing the break that follows `track` and books its slot after the song. */
  private startPrep(track: Track) {
    const station = this.station;
    if (!station || this.pending?.trackId === track.id || this.coveredTrackId === track.id) return;
    const kind: BreakKind = this.openingDone ? 'regular' : 'opening';
    const controller = new AbortController();
    const entry: Pending = { trackId: track.id, done: false, late: false, controller, promise: Promise.resolve(undefined) };
    const s0 = player.state;
    const left = s0.track?.id === track.id ? (s0.durationMs || track.durationMs) - s0.positionMs : track.durationMs;
    const deadline = left > 0 ? Date.now() + left : undefined;
    entry.promise = (async () => {
      // a song an AI app asked for (request_song over MCP) is queued next and announced in this break
      const request = await this.inboxRequest().catch(() => undefined);
      // an AI app asked to add something to Notion: added now, confirmed in this break
      const notion = await nextInboxNotionWrite(station).catch(() => undefined);
      // an AI app asked the hosts to do something: Your list now, anything else asked in this break (yes = the listener)
      const action = notion ? undefined : await nextInboxAction(station).catch(() => undefined);
      // songs that cannot play here (checked ahead by the player) leave the queue before the host names one
      await player.aheadReady(4000);
      const q = player.state;
      return this.prepare(station, kind, undefined, controller, track, this.nextTrack(), q.queue.slice(q.index + 1, q.index + 4), request, deadline, notion, undefined, undefined, action);
    })().then((b) => {
      entry.done = true;
      entry.ready = b;
      if (b && entry.late) void this.airLate(entry, b);
      return b;
    });
    this.pending = entry;
    const book = () => this.pending === entry && player.holdAfterCurrent((signal) => this.hold(entry, signal));
    // talk over the intro: this song started while the last break is still on air. A hold booked now would run
    // right after that break (same boundary), so book it once the break is over.
    if (player.state.holding || this._state.phase === 'talking') void this.airLock.then(() => this.later(book, 0));
    else book();
  }

  private async hold(entry: Pending, signal: AbortSignal) {
    if (entry !== this.pending || !this._state.onAir) return;
    let ready = entry.ready;
    if (!entry.done) {
      ready = await Promise.race([entry.promise, new Promise<undefined>((r) => setTimeout(r, HOLD_GRACE_MS))]);
    }
    if (!ready) {
      // not ready: the next song starts now; the break may still air over its intro
      entry.late = !entry.done;
      return;
    }
    this.pending = undefined;
    await this.air(ready, 'hold', signal);
  }

  private async airLate(entry: Pending, b: PreparedBreak) {
    if (entry !== this.pending) return;
    this.pending = undefined;
    if (Date.now() - this.nextStartAt > LATE_AIR_MS || player.state.status !== 'playing') return;
    await this.air(b, 'over');
  }

  private scheduleStreamBreak(station: Station) {
    if (!station.hostIds.length) return;
    const every = Math.max(4, Math.min(40, station.talkEvery * 4)) * 60_000;
    const session = this.session;
    this.set({ nextBreakIn: 1 });
    const run = async () => {
      if (session !== this.session) return;
      const b = await this.prepare(station, this.openingDone ? 'stream' : 'opening', undefined, new AbortController());
      if (b && session === this.session && player.state.status === 'playing') await this.air(b, 'over');
      if (session === this.session) this.later(() => void run(), every);
    };
    this.later(() => void run(), this.openingDone ? every : 25_000);
  }

  private async onAnyAppTrack(t: AnyAppNowPlaying) {
    const station = this.station;
    // '' = nothing playing; the same key again = a metadata refresh of the same song
    if (!station || !t.key || !t.title || t.key === this.anyAppKey) return;
    this.anyAppKey = t.key;
    const ready = this.pending?.ready;
    this.pending = undefined;
    if (ready) await this.air(ready, 'anyapp');
    else if (this.anyAppPrev) this.songsSinceBreak++;
    const now: TrackSummary = { id: `anyapp:${t.key}`, title: t.title, artist: t.artist ?? '', album: t.album ?? '', durationMs: t.durationMs ?? 0, source: 'stream' };
    this.anyAppPrev = now;
    void mediaNotification.update({ title: station.name, artist: `${now.title}${now.artist ? ` · ${now.artist}` : ''}` }, true, { ownAudio: false });
    const due = !this.openingDone || shouldBreakAfter(station, this.songsSinceBreak);
    this.set({ nextBreakIn: due ? 1 : Math.max(1, station.talkEvery - this.songsSinceBreak) });
    if (!due) return;
    // written now, aired when the next song starts (over its intro); the next song is unknown, so no intro
    const controller = new AbortController();
    const entry: Pending = { trackId: now.id, done: false, late: false, controller, promise: Promise.resolve(undefined) };
    entry.promise = this.prepare(station, this.openingDone ? 'regular' : 'opening', undefined, controller, now).then((b) => {
      entry.done = true;
      entry.ready = b;
      return b;
    });
    this.pending = entry;
  }

  // ------------------------------------------------------------------------------------------------ heads-ups

  /** On air and the music playing (heads-ups stay quiet while paused). */
  private isPlaying(): boolean {
    return this._state.onAir && (this.anyAppMode || player.state.status === 'playing');
  }

  /** Something urgent just changed: over the music now, right after this song, or first in the next break. */
  private async deliverHeadsUp(h: HeadsUp): Promise<void> {
    const station = this.station;
    if (!station || !this.isPlaying()) return;
    const cfg = (await getSettings()).connections.headsUps;
    const s = player.state;
    const cur = this.current;
    const music = Boolean(cur && !this.anyAppMode && !this.live && !s.live);
    const left = music ? (s.durationMs || cur!.durationMs) - s.positionMs : 0;
    const now = Date.now();
    const breakIns = (await listHeadsUps()).filter((x) => x.via === 'breakin' && x.airedAt && now - x.airedAt < 3_600_000).length;
    const booked = Boolean(cur && this.pending?.trackId === cur.id);
    const how = deliveryFor(h, { breakIn: cfg?.breakIn ?? 'now', breakInsLastHour: breakIns, songLeftMs: music && left > 0 ? left : undefined, breakAfterSong: booked || this._state.nextBreakIn <= 1 });
    if (how === 'breakin') return this.breakIn(h);
    if (how !== 'afterSong' || !music) return;
    // the break after this song is already being written: its line is voiced now and goes first in it
    if (booked) this.voiceAhead(h, now + Math.max(0, left));
    else this.breakAfterSong();
  }

  private voiceAhead(h: HeadsUp, at: number) {
    const station = this.station;
    if (!station || this.headsUpLines.has(h.id)) return;
    const text = h.say ?? scriptedSay(h, at);
    const clip = loadLineup(station).then(([lead]) => {
      if (!lead) throw new Error('This station has no hosts');
      return speak(lead, text, { timeoutMs: 20_000 }).catch(() => speak(deviceStandIn(lead), text));
    });
    clip.catch(() => undefined);
    this.headsUpLines.set(h.id, { text, clip });
  }

  /** A break right after the song on now, even when the station would play another song first. */
  private breakAfterSong() {
    const cur = this.current;
    if (!cur || this.pending?.trackId === cur.id || this.coveredTrackId === cur.id) return;
    const s = player.state;
    const left = (s.durationMs || cur.durationMs) - s.positionMs;
    this.set({ nextBreakIn: 1 });
    this.later(() => this.current?.id === cur.id && this.startPrep(cur), Math.max(0, left - this.prepLead()));
  }

  /** "Quick heads-up: your 2 o'clock was just cancelled": the lead host over the ducked music, then the song goes on. */
  private async breakIn(h: HeadsUp): Promise<void> {
    const station = this.station;
    if (!station || !claim(h.id)) return;
    try {
      const host = (await loadLineup(station))[0];
      if (!host) return;
      const ahead = this.headsUpLines.get(h.id);
      const text = ahead?.text ?? h.say ?? scriptedSay(h, Date.now());
      const clip = await (ahead?.clip ?? speak(host, text, { timeoutMs: 15_000 })).catch(() => speak(deviceStandIn(host), text));
      // paused meanwhile: it waits for the music
      if (!this.isPlaying() || station !== this.station) return;
      const b: PreparedBreak = {
        station,
        hosts: [host],
        plan: { kind: 'headsup', topics: ['headsUp'], items: [{ segment: 'headsUp', key: `headsup:${h.id}` }], lines: 1, outro: false, intro: false, mix: 0 },
        packet: {} as PreparedBreak['packet'],
        lines: [{ hostId: host.id, text }],
        clips: [clip],
        mode: 'builtin',
        tookMs: 0,
      };
      await this.air(b, this.anyAppMode ? 'anyapp' : 'over');
    } finally {
      release(h.id);
    }
  }

  /** Heads-ups that came in after this break was written go first in it, said by the lead host. */
  private async addHeadsUpLines(b: PreparedBreak): Promise<void> {
    if (b.plan.kind === 'callin' || b.plan.kind === 'headsup') return;
    const planned = new Set(b.plan.items.map((i) => i.key));
    const seg = b.station.segments;
    const waiting = (await pendingHeadsUps().catch(() => [])).filter((h) => !planned.has(`headsup:${h.id}`) && (h.mailId ? seg.email : seg.calendar)).slice(0, 2);
    const lead = b.hosts[0];
    if (!waiting.length || !lead) return;
    const now = Date.now();
    const add = waiting.map((h) => {
      const ahead = this.headsUpLines.get(h.id);
      const text = ahead?.text ?? h.say ?? scriptedSay(h, now);
      const clip = ahead?.clip ?? speak(lead, text, { timeoutMs: 15_000 }).catch(() => speak(deviceStandIn(lead), text));
      return { h, text, clip };
    });
    const n = add.length;
    b.lines.unshift(...add.map((a) => ({ hostId: lead.id, text: a.text })));
    b.clips.unshift(...add.map((a) => a.clip));
    if (b.timeLine) b.timeLine = { ...b.timeLine, index: b.timeLine.index + n };
    if (b.relative) b.relative = Object.fromEntries(Object.entries(b.relative).map(([k, v]) => [Number(k) + n, v]));
    b.plan = { ...b.plan, items: [...add.map((a) => ({ segment: 'headsUp' as const, key: `headsup:${a.h.id}` })), ...b.plan.items] };
  }

  // ------------------------------------------------------------------------------------------------ song requests

  /**
   * A call-in that asks for a song: find it and play it next. A break already written for this song would
   * introduce the old next song, so it is written again. Live streams and other apps cannot take a request.
   */
  private async takeRequest(said: string): Promise<SongRequest | undefined> {
    if (this.anyAppMode || this.live || player.state.live || !isSongRequest(said)) return undefined;
    const query = requestQuery(said);
    if (isMood(query)) return undefined;
    const request = await queueRequest(query, this.current?.id);
    if (request.found) void noteRequested(request.found);
    const cur = this.current;
    if (request.found && cur && this.pending?.trackId === cur.id) {
      this.pending.controller.abort();
      this.pending = undefined;
      this.startPrep(cur);
    }
    return request;
  }

  /** The oldest song request from an AI app (MCP inbox), queued next. */
  private async inboxRequest(): Promise<SongRequest | undefined> {
    if (this.anyAppMode || this.live || player.state.live) return undefined;
    return nextInboxRequest(this.current?.id);
  }

  // ------------------------------------------------------------------------------------------------ prepare / air

  private async prepare(
    station: Station,
    kind: BreakKind,
    callIn: string | undefined,
    controller: AbortController,
    songBefore?: Track | TrackSummary,
    songAfter?: Track,
    upcoming?: Track[],
    request?: SongRequest,
    deadline?: number,
    notion?: NotionWrite,
    onLookup?: () => void,
    memory?: MemoryChange,
    action?: ActionTurn,
  ): Promise<PreparedBreak | undefined> {
    const session = this.session;
    const showPrep = kind === 'callin';
    if (showPrep) this.set({ phase: 'preparing' });
    const timer = setTimeout(() => controller.abort(new Error('The break took too long to write')), PREP_TIMEOUT_MS);
    try {
      const b = await prepareBreak({ station, kind, callIn, songBefore, songAfter, upcoming, request, notion, deadline, signal: controller.signal, onAir: this.onAirBreak, onLookup, memory, action });
      if (session === this.session && kind !== 'callin') this.notePrep(b.tookMs);
      return session === this.session && !controller.signal.aborted ? b : undefined;
    } catch (err) {
      if (session !== this.session || controller.signal.aborted) return undefined;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[hostcaster] break skipped:', msg);
      const code = (err as { code?: unknown }).code;
      this.set({ ...skippedNotice(msg, typeof code === 'string' ? code : undefined), phase: this._state.phase === 'preparing' ? 'music' : this._state.phase });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One break on air at a time. */
  private air(b: PreparedBreak, mode: AirMode, signal?: AbortSignal, opts: { chime?: boolean } = {}): Promise<void> {
    const run = async () => {
      const session = this.session;
      if (session !== this.session || !this._state.onAir || this.inCall) return;
      await this.addHeadsUpLines(b).catch(() => undefined);
      const airing = (this.airing = new AbortController());
      signal?.addEventListener('abort', () => airing.abort(), { once: true });
      this.set({ phase: 'talking', script: b.lines, lineIndex: undefined, notice: undefined, noticeLink: undefined });
      // a heads-up break-in is not a break: the station's song count goes on
      if (b.plan.kind === 'callin') this.coverBreak(b);
      else if (b.plan.kind !== 'headsup') this.countBreak(b);
      const now = Date.now();
      this.onAirSegments = b.plan.items.map((i) => i.segment);
      this.onAirBreak = { id: `on-air-${now}`, createdAt: now, updatedAt: now, stationId: b.station.id, at: now, lines: b.lines, topics: planTopicKeys(b.plan), songBefore: b.songBefore, songAfter: b.songAfter };
      try {
        await airBreak(b, mode, {
          signal: airing.signal,
          chime: opts.chime !== false,
          onLine: (line: BreakLine, i: number) => {
            if (session !== this.session) return;
            this.set({ speakingHostId: line.hostId, caption: line.text, lineIndex: i });
            this.emitter.emit('line', line);
            if (i === 0) this.report(line.hostId);
          },
        });
        if (session !== this.session || airing.signal.aborted) return;
        await this.record(b);
        this.journalBreak(b);
        if (b.plan.kind !== 'headsup') void maybeNotionRecap(b.station).catch(() => undefined);
      } catch (err) {
        console.warn('[hostcaster] break failed on air', err);
      } finally {
        this.onAirBreak = undefined;
        if (session === this.session) {
          const notice = standInNotice(b);
          this.set({ phase: 'music', speakingHostId: undefined, caption: undefined, script: undefined, lineIndex: undefined, ...notice });
        }
      }
    };
    const next = this.airLock.then(run, run);
    this.airLock = next.catch(() => undefined);
    return next;
  }

  /**
   * A regular break goes on air: reset the song count now, not after it aired. With talk over the intro the next
   * song starts while the hosts still talk, and its trackstart must already see this break (no second opening).
   */
  private countBreak(b: PreparedBreak) {
    this.songsSinceBreak = 0;
    this.airedSinceTrack = true;
    this.openingDone = true;
    this.set({ nextBreakIn: Math.max(1, b.station.talkEvery) });
    // a late break airs over the next song: a break already booked after that song would follow it too soon
    const p = this.pending;
    if (p && p.trackId === this.current?.id && (this.station?.talkEvery ?? 1) > 1) {
      p.controller.abort();
      this.pending = undefined;
    }
  }

  /**
   * A call-in near the end of a song is that song's break: the hosts already talked (and announced a requested
   * song), so the break booked after the song would only repeat them right after.
   */
  private coverBreak(b: PreparedBreak) {
    const cur = this.current;
    const s = player.state;
    if (!cur || this.anyAppMode || this.live || s.live) return;
    const left = (s.durationMs || cur.durationMs) - s.positionMs;
    if (!(left > 0 && left < CALLIN_COVERS_MS)) return;
    this.coveredTrackId = cur.id;
    if (this.pending?.trackId === cur.id) {
      this.pending.controller.abort();
      this.pending = undefined;
    }
    this.countBreak(b);
  }

  /** The listener pressed Next while the hosts talked: the journal keeps which segments (patterns: "skips the news"). */
  private noteSkippedBreak() {
    if (!this.onAirBreak || this.skipNoted === this.onAirBreak.id) return;
    this.skipNoted = this.onAirBreak.id;
    void noteBreak(this.onAirSegments, '', true, this.station?.id);
  }

  /** What a break covered, for the journal (headlines, events and emails by name). */
  private journalBreak(b: PreparedBreak) {
    if (b.plan.kind === 'headsup') {
      if (b.lines[0]?.text) void noteHeadsUp(b.lines[0].text);
      return;
    }
    const p = b.packet;
    const names = b.plan.items.flatMap((i) => {
      if (i.segment === 'calendar') return [p.calendar?.find((e) => `calendar:${e.id}` === i.key)?.title];
      if (i.segment === 'email') return [p.email?.find((m) => `email:${m.id}` === i.key)?.subject];
      if (i.segment === 'news') return [p.news?.find((h) => h.id === i.key)?.title];
      if (i.segment === 'headsUp') return [p.headsUps?.find((h) => `headsup:${h.id}` === i.key)?.fact];
      return [i.segment === 'time' ? undefined : i.segment];
    });
    const gist = names.filter(Boolean).join('; ');
    void noteBreak(b.plan.items.map((i) => i.segment), gist ? `Covered: ${gist}` : '', false, b.station.id);
  }

  private async record(b: PreparedBreak) {
    const station = b.station;
    const brk: Break = await addBreak({
      stationId: station.id,
      at: Date.now(),
      // a time-only line left out on air (its time was not ready) is not in the log either
      lines: b.lines.filter((l) => l.text),
      topics: planTopicKeys(b.plan),
      songBefore: b.songBefore,
      songAfter: b.songAfter,
    });
    await markInboxUsed(b.plan.items.filter((i) => i.segment === 'inbox').map((i) => i.key.slice('inbox:'.length)));
    if (b.packet.tracker?.ids.length) void markListAired(b.packet.tracker.ids, Date.now(), b.packet.tracker.asks).catch(() => undefined);
    // told on air: never again
    const told = b.plan.items.filter((i) => i.segment === 'headsUp').map((i) => i.key.slice('headsup:'.length));
    if (told.length) {
      await markAired(told, b.plan.kind === 'headsup' ? 'breakin' : 'break', b.lines[0]?.text).catch(() => undefined);
      told.forEach((id) => this.headsUpLines.delete(id));
    }
    this.set({ lastBreak: brk });
    this.emitter.emit('break', brk);
  }
}

export type { Radio };
export const radio = new Radio();

if (typeof window !== 'undefined') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  w.__hostcaster = { ...(w.__hostcaster ?? {}), radio };
  w.__hostcaster.agent = { ...((w.__hostcaster.agent as object) ?? {}), prepareBreak };
}
