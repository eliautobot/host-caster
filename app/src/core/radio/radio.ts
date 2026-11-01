// core/radio: drives a station on top of `player`. Decides breaks, prepares them before the song ends (context,
// script, voice), airs them between songs. Never leaves silence: anything late or failed is skipped.
import { reportNowPlaying } from '../api';
import { addBreak, getSettings, getStation, saveSettings } from '../db';
import { markInboxUsed } from '../context/sources';
import { anyApp, mediaNotification, type AnyAppNowPlaying } from '../native';
import { player } from '../player';
import type { Break, BreakLine, RadioEventName, RadioEvents, RadioState, Station, Track, TrackSummary } from '../types';
import { createEmitter } from '../util/emitter';
import { airBreak, type AirMode } from './air';
import { planTopicKeys, shouldBreakAfter, type BreakKind } from './planner';
import { skippedNotice, standInNotice } from './notice';
import { loadLineup, prepareBreak, warmUpBrains, type PreparedBreak } from './prepare';
import { extendQueue, stationQueue } from './queue';
import { isMood, isSongRequest, nextInboxRequest, queueRequest, requestQuery, type SongRequest } from './requests';
import type { NotionWrite } from './notionAsk';
import { maybeNotionRecap, nextInboxNotionWrite, takeNotionWrite } from './notionWrite';

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
  private hostNames = new Map<string, string>();
  /** how long the last breaks took to get ready (ms), newest last */
  private prepTimes: number[] = [];

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
    this.set({ phase: 'preparing', speakingHostId: undefined, caption: undefined, notice: undefined, noticeLink: undefined });
    // the song under the call-in, so the hosts can name what is playing
    const under = this.anyAppMode ? this.anyAppPrev : this.current;
    const request = await this.takeRequest(said);
    // "add oat milk to my list": added to Notion now, so the answer can confirm it
    const notion = await takeNotionWrite(said, station).catch(() => undefined);
    const ready = await this.prepare(station, 'callin', said, new AbortController(), under, undefined, undefined, request, undefined, notion);
    if (!ready || session !== this.session) {
      if (session === this.session) this.set({ phase: 'music' });
      if (!ready) throw new Error('Your hosts could not pick up right now. Check the Brains page.');
      return;
    }
    await this.air(ready, this.anyAppMode ? 'anyapp' : 'over');
  }

  /** Skips the break on air (or the one being prepared). */
  skipBreak(): void {
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
      // songs that cannot play here (checked ahead by the player) leave the queue before the host names one
      await player.aheadReady(4000);
      const q = player.state;
      return this.prepare(station, kind, undefined, controller, track, this.nextTrack(), q.queue.slice(q.index + 1, q.index + 4), request, deadline, notion);
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
  ): Promise<PreparedBreak | undefined> {
    const session = this.session;
    const showPrep = kind === 'callin';
    if (showPrep) this.set({ phase: 'preparing' });
    const timer = setTimeout(() => controller.abort(new Error('The break took too long to write')), PREP_TIMEOUT_MS);
    try {
      const b = await prepareBreak({ station, kind, callIn, songBefore, songAfter, upcoming, request, notion, deadline, signal: controller.signal, onAir: this.onAirBreak });
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
  private air(b: PreparedBreak, mode: AirMode, signal?: AbortSignal): Promise<void> {
    const run = async () => {
      const session = this.session;
      if (session !== this.session || !this._state.onAir) return;
      this.set({ phase: 'talking', script: b.lines, lineIndex: undefined, notice: undefined, noticeLink: undefined });
      if (b.plan.kind !== 'callin') this.countBreak(b);
      else this.coverBreak(b);
      const now = Date.now();
      this.onAirBreak = { id: `on-air-${now}`, createdAt: now, updatedAt: now, stationId: b.station.id, at: now, lines: b.lines, topics: planTopicKeys(b.plan), songBefore: b.songBefore, songAfter: b.songAfter };
      try {
        await airBreak(b, mode, {
          signal,
          chime: true,
          onLine: (line: BreakLine, i: number) => {
            if (session !== this.session) return;
            this.set({ speakingHostId: line.hostId, caption: line.text, lineIndex: i });
            this.emitter.emit('line', line);
            if (i === 0) this.report(line.hostId);
          },
        });
        if (session !== this.session || signal?.aborted) return;
        await this.record(b);
        void maybeNotionRecap(b.station).catch(() => undefined);
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

  private async record(b: PreparedBreak) {
    const station = b.station;
    const brk: Break = await addBreak({
      stationId: station.id,
      at: Date.now(),
      lines: b.lines,
      topics: planTopicKeys(b.plan),
      songBefore: b.songBefore,
      songAfter: b.songAfter,
    });
    await markInboxUsed(b.plan.items.filter((i) => i.segment === 'inbox').map((i) => i.key.slice('inbox:'.length)));
    this.set({ lastBreak: brk });
    this.emitter.emit('break', brk);
  }
}

export type { Radio };
export const radio = new Radio();

if (typeof window !== 'undefined') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  w.__hostcaster = { ...(w.__hostcaster ?? {}), radio };
}
