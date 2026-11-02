// What a break talks about: topic rotation with per-segment and per-item cooldowns, respecting station.segments,
// talkEvery, talkLength and the talk mix (music <-> the listener's day). Day first: every regular break carries one
// item from the listener's day when there is one, and the first break of a session and of each hour is a short
// rundown of the day. Pure and deterministic given `rand`, so it is easy to test.
import type { FollowUp } from '../agent/followup';
import type { NotionWrite } from './notionAsk';
import type { MemoryChange } from '../memory/commands';
import type { ActionTurn } from '../actions/callin';
import type { SongRequest } from './requests';
import type { Break, ContextPacket, SegmentKey, Station } from '../types';
import { FUN_FACTS } from './facts';

/** headsup = a short break-in over the music for something urgent that just changed (core/agent/headsup.ts) */
export type BreakKind = 'regular' | 'opening' | 'callin' | 'stream' | 'headsup';
export type TopicKey = SegmentKey | 'inbox' | 'headsUp';

export interface PlannedTopic {
  segment: TopicKey;
  /** cooldown key: 'weather', 'calendar:<id>', 'news:<id>' ... */
  key: string;
}

export interface BreakPlan {
  kind: BreakKind;
  /** chosen segments, in airing order */
  topics: TopicKey[];
  items: PlannedTopic[];
  /** total lines across all hosts */
  lines: number;
  /** back-announce the song that just played */
  outro: boolean;
  /** introduce the next song */
  intro: boolean;
  /** the station's talk mix, 0 (the music) .. 4 (the listener's day) */
  mix: number;
  /** the first break of a session or of an hour: a short rundown of the listener's day */
  rundown?: boolean;
  /** what the listener said (call-ins) */
  callIn?: string;
  /** a song the listener (or their AI app) asked for, queued next when found */
  request?: SongRequest;
  /** the request came from an AI app, not a call */
  requestFrom?: 'call' | 'app';
  /** something the listener (or their AI app) asked to add to Notion, already done or not */
  notion?: NotionWrite;
  /** the answer to a call-in question about something the hosts said (core/agent/followup.ts) */
  followUp?: FollowUp;
  /** "remember that ..." / "forget that ...", already done: the hosts confirm it (core/memory/commands.ts) */
  memory?: MemoryChange;
  /** Your list / an action the listener asked for (core/actions/callin.ts): its exact line closes the break */
  action?: ActionTurn;
}

export const TALK_LENGTH_LINES = { short: [1, 2], normal: [3, 4], long: [5, 8] } as const;
const TOPICS_PER_BREAK = { short: 1, normal: 2, long: 3 } as const;
/** a rundown is a little longer: lines and items */
const RUNDOWN_LINES = { short: [2, 3], normal: [5, 6], long: [7, 8] } as const;
const RUNDOWN_ITEMS = { short: 3, normal: 5, long: 7 } as const;

/** Talk mix steps: 0 = Music .. 4 = My day. */
export const TALK_MIX_STEPS = 5;
export const DEFAULT_TALK_MIX = 3;
/** a back-announce of the last song every N breaks: every break at Music, 1 in 3 at the default, 1 in 4 at My day */
export const OUTRO_EVERY = [1, 2, 2, 3, 4] as const;
/** score added to items from the listener's day at each mix step */
const DAY_BIAS = [-25, -10, 0, 10, 20] as const;

export function talkMixOf(station: Pick<Station, 'talkMix'>): number {
  const m = station.talkMix;
  return typeof m === 'number' && Number.isFinite(m) ? Math.max(0, Math.min(TALK_MIX_STEPS - 1, Math.round(m))) : DEFAULT_TALK_MIX;
}

/** Items from the listener's own day (weather, time and fun facts are not). */
export const DAY_SEGMENTS: ReadonlySet<TopicKey> = new Set<TopicKey>(['inbox', 'reminders', 'calendar', 'lifeEvents', 'email', 'news', 'notes']);

const MIN = 60_000;
/** a segment rests this long after it was on air */
export const SEGMENT_COOLDOWN: Record<TopicKey, number> = {
  songs: 0,
  time: 25 * MIN,
  weather: 40 * MIN,
  calendar: 15 * MIN,
  email: 25 * MIN,
  news: 15 * MIN,
  lifeEvents: 45 * MIN,
  notes: 30 * MIN,
  reminders: 10 * MIN,
  funFacts: 20 * MIN,
  inbox: 0,
  headsUp: 0,
};
/** the same item (one calendar event, one headline) rests this long */
export const ITEM_COOLDOWN: Partial<Record<TopicKey, number>> = {
  calendar: 90 * MIN,
  email: 6 * 60 * MIN,
  news: 12 * 60 * MIN,
  lifeEvents: 3 * 60 * MIN,
  notes: 2 * 60 * MIN,
  reminders: 75 * MIN,
  inbox: Infinity,
};
/** an event or reminder comes back once when it is this close, if it was last mentioned before that */
const SOON_AGAIN = 30 * MIN;

/** Should a break follow the track that just started? `songsSinceBreak` counts finished songs. */
export function shouldBreakAfter(station: Station, songsSinceBreak: number): boolean {
  return songsSinceBreak + 1 >= Math.max(1, Math.min(10, station.talkEvery));
}

export function lastUsed(key: string, recent: Break[]): number {
  let at = -Infinity;
  for (const b of recent) if (b.topics.includes(key) && b.at > at) at = b.at;
  return at;
}

function hashText(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const noteKey = (text: string) => `notes:${hashText(text)}`;

interface Candidate extends PlannedTopic {
  score: number;
}

export interface CandidateOptions {
  /** how much of each segment's cooldown applies (1 = all of it, 0 = none) */
  rest?: number;
}

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

/**
 * Every topic the packet can support right now, with a score (higher = sooner on air). Ranked day first: reminders
 * and events starting soon, then today's events, important email, news, then weather and time, then fun facts.
 */
export function candidates(station: Station, packet: ContextPacket, recent: Break[], now: number, opts: CandidateOptions = {}): Candidate[] {
  const seg = station.segments;
  const restFactor = opts.rest ?? 1;
  const out: Candidate[] = [];
  const free = (key: string, segment: TopicKey, due?: number) => {
    const last = lastUsed(key, recent);
    if (now - last >= (ITEM_COOLDOWN[segment] ?? 0)) return true;
    // "the dentist in half an hour": said once more when it is close, never twice in a quarter of an hour
    return due !== undefined && due - now <= SOON_AGAIN && due > now - 15 * MIN && last < due - SOON_AGAIN && now - last >= 15 * MIN;
  };
  const rest = (segment: TopicKey) => now - lastUsed(segment, recent) >= SEGMENT_COOLDOWN[segment] * restFactor;
  const stale = (segment: TopicKey) => Math.min(20, (now - lastUsed(segment, recent)) / (4 * MIN));
  const add = (segment: TopicKey, key: string, base: number, due?: number) => {
    if (!rest(segment) || !free(key, segment, due)) return false;
    out.push({ segment, key, score: base + stale(segment) });
    return true;
  };

  for (const item of packet.inbox ?? []) if (add('inbox', `inbox:${item.id}`, item.kind === 'segment' ? 95 : 85)) break;
  if (seg.reminders) {
    for (const r of packet.reminders ?? []) {
      const soon = r.at - now < 30 * MIN;
      if (add('reminders', `reminders:${r.id}`, soon ? 100 : 70, r.at)) break;
    }
  }
  if (seg.time) add('time', 'time', 30);
  if (seg.weather && packet.weather) add('weather', 'weather', 40);
  if (seg.calendar) {
    for (const e of packet.calendar ?? []) {
      const soon = e.start - now < 2 * 60 * MIN && e.start > now - 15 * MIN;
      const today = sameDay(e.start, now) || (e.start <= now && (e.end ?? e.start) > now);
      if (add('calendar', `calendar:${e.id}`, soon && !e.allDay ? 90 : today ? 66 : 40, e.allDay ? undefined : e.start)) break;
    }
  }
  if (seg.email) for (const m of packet.email ?? []) if (add('email', `email:${m.id}`, m.important ? 58 : 42)) break;
  if (seg.news) for (const h of packet.news ?? []) if (add('news', h.id, 50)) break;
  if (seg.lifeEvents) {
    for (const e of packet.lifeEvents ?? []) {
      const today = isToday(e.date, now, e.yearly);
      if (add('lifeEvents', `lifeEvents:${e.id}`, today ? 82 : 46)) break;
    }
  }
  // the listener's own notes (and the note-app pages they chose) come before public news
  if (seg.notes) for (const n of packet.notes ?? []) if (add('notes', noteKey(n), 53)) break;
  if (seg.funFacts) add('funFacts', 'funFacts', 16);
  return out;
}

function isToday(date: string, now: number, yearly: boolean): boolean {
  const d = new Date(now);
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return yearly ? date.slice(5) === md : date === `${d.getFullYear()}-${md}`;
}

/** A fun fact that has not aired in the recent breaks: key 'fact:<index>'. */
function pickFact(recent: Break[], rand: () => number): string {
  const used = new Set(recent.flatMap((b) => b.topics.filter((t) => t.startsWith('fact:'))));
  const fresh = FUN_FACTS.map((_, i) => `fact:${i}`).filter((k) => !used.has(k));
  const pool = fresh.length ? fresh : FUN_FACTS.map((_, i) => `fact:${i}`);
  return pool[Math.floor(rand() * pool.length)]!;
}

export function factFor(plan: BreakPlan): string | undefined {
  const key = plan.items.find((i) => i.segment === 'funFacts')?.key;
  const idx = key?.startsWith('fact:') ? Number(key.slice(5)) : NaN;
  return Number.isInteger(idx) ? FUN_FACTS[idx] : undefined;
}

/** Breaks (call-ins aside) since the last one that back-announced a song; older logs said only 'songs'. */
export function breaksSinceOutro(recent: Break[]): number {
  let n = 0;
  for (const b of [...recent].sort((a, c) => c.at - a.at)) {
    if (b.topics.includes('callin')) continue;
    if (b.topics.includes('outro') || (b.topics.includes('songs') && !b.topics.includes('intro'))) return n;
    n++;
  }
  return n;
}

/**
 * The first break of a session and the first after the top of each hour is a rundown. A rundown in the last ten
 * minutes of the hour before counts for this hour (no second rundown a few minutes later).
 */
export function rundownDue(kind: BreakKind, recent: Break[], now: number): boolean {
  if (kind === 'opening') return true;
  if (kind !== 'regular' && kind !== 'stream') return false;
  const hour = new Date(now).setMinutes(0, 0, 0);
  return !recent.some((b) => b.topics.includes('rundown') && b.at >= hour - 10 * MIN && b.at <= now);
}

/**
 * The rundown's items, in airing order: the time (at the top of the hour), next events today, due reminders, a
 * birthday or anniversary today, the weather, one or two headlines. Only what exists; segment cooldowns do not apply
 * (it is a summary), the same item is still not repeated within 20 minutes.
 */
function rundownItems(station: Station, packet: ContextPacket, recent: Break[], now: number, max: number, headlines: number): PlannedTopic[] {
  const seg = station.segments;
  const fresh = (key: string, ms = 20 * MIN) => now - lastUsed(key, recent) >= ms;
  const out: PlannedTopic[] = [];
  if (seg.time && fresh('time', 10 * MIN)) out.push({ segment: 'time', key: 'time' });
  if (seg.calendar) {
    const ahead = (packet.calendar ?? []).filter((e) => (e.end ?? e.start + 3600_000) > now && e.start > now - 15 * MIN);
    const today = ahead.filter((e) => sameDay(e.start, now));
    // late in the day, tomorrow's first event is the next thing on the list
    const list = today.length ? today : ahead.filter((e) => e.start - now < 16 * 60 * MIN).slice(0, 1);
    for (const e of list.filter((x) => fresh(`calendar:${x.id}`)).slice(0, 2)) out.push({ segment: 'calendar', key: `calendar:${e.id}` });
  }
  if (seg.reminders) {
    for (const r of (packet.reminders ?? []).filter((x) => fresh(`reminders:${x.id}`)).slice(0, 2)) out.push({ segment: 'reminders', key: `reminders:${r.id}` });
  }
  if (seg.lifeEvents) {
    const e = (packet.lifeEvents ?? []).find((x) => isToday(x.date, now, x.yearly) && fresh(`lifeEvents:${x.id}`, 60 * MIN));
    if (e) out.push({ segment: 'lifeEvents', key: `lifeEvents:${e.id}` });
  }
  const note = (packet.inbox ?? []).find((i) => fresh(`inbox:${i.id}`, Infinity));
  if (note) out.push({ segment: 'inbox', key: `inbox:${note.id}` });
  if (seg.weather && packet.weather && fresh('weather')) out.push({ segment: 'weather', key: 'weather' });
  if (seg.news) for (const h of (packet.news ?? []).filter((x) => fresh(x.id, ITEM_COOLDOWN.news!)).slice(0, headlines)) out.push({ segment: 'news', key: h.id });
  // over the limit: the second headline, event or reminder goes first, then the time, the weather ...
  const second = (segment: TopicKey) => out.findLastIndex((i, n) => i.segment === segment && out.findIndex((x) => x.segment === segment) !== n);
  while (out.length > max) {
    const order = [second('news'), second('calendar'), second('reminders'), ...(['time', 'lifeEvents', 'weather', 'inbox'] as const).map((g) => out.findIndex((i) => i.segment === g))];
    const drop = order.find((i) => i >= 0) ?? out.length - 1;
    out.splice(drop, 1);
  }
  return out;
}

export interface PlanOptions {
  kind?: BreakKind;
  callIn?: string;
  request?: SongRequest;
  requestFrom?: 'call' | 'app';
  notion?: NotionWrite;
  followUp?: FollowUp;
  memory?: MemoryChange;
  action?: ActionTurn;
  hostCount?: number;
  now?: number;
  rand?: () => number;
}

export function planBreak(station: Station, packet: ContextPacket, recent: Break[], opts: PlanOptions = {}): BreakPlan {
  const kind = opts.kind ?? 'regular';
  const now = opts.now ?? Date.now();
  const rand = opts.rand ?? Math.random;
  const hosts = Math.max(1, opts.hostCount ?? station.hostIds.length);
  const len = station.talkLength in TALK_LENGTH_LINES ? station.talkLength : 'normal';
  const mix = talkMixOf(station);
  let want: number = TOPICS_PER_BREAK[len];
  if (kind === 'callin') want = len === 'short' ? 0 : 1;

  // the rundown: only when there is something to run down (a lone time check is a regular break)
  const rundownList = rundownDue(kind, recent, now) ? rundownItems(station, packet, recent, now, RUNDOWN_ITEMS[len], len === 'short' ? 1 : 2) : [];
  // the listener's patterns play some things down right now ("Skips the news before 9 AM")
  const quiet = new Set(packet.memory?.quieter ?? []);
  if (quiet.size) for (let i = rundownList.length - 1; i >= 0; i--) if (quiet.has(rundownList[i]!.segment)) rundownList.splice(i, 1);
  const rundown = rundownList.some((i) => i.segment !== 'time');

  let items: PlannedTopic[];
  if (rundown) items = rundownList;
  else {
    const bias = (c: Candidate) => (DAY_SEGMENTS.has(c.segment) ? DAY_BIAS[mix]! : 0) - (quiet.has(c.segment) ? 60 : 0);
    const pool = candidates(station, packet, recent, now).map((c) => ({ ...c, score: c.score + bias(c) + rand() * 10 }));
    if (kind === 'opening') {
      for (const c of pool) if (c.segment === 'time' || c.segment === 'weather') c.score += 60;
    }
    pool.sort((a, b) => b.score - a.score);
    const chosen: Candidate[] = [];
    // one item from the listener's day in every regular break (any mix but Music), when there is one; a segment
    // that aired a few minutes ago may come back with another item (a different headline, the next event)
    if (want > 0 && mix > 0 && kind !== 'callin') {
      const day =
        pool.find((c) => DAY_SEGMENTS.has(c.segment) && !quiet.has(c.segment)) ??
        candidates(station, packet, recent, now, { rest: 0.5 })
          .filter((c) => DAY_SEGMENTS.has(c.segment) && !quiet.has(c.segment))
          .map((c) => ({ ...c, score: c.score + rand() * 10 }))
          .sort((a, b) => b.score - a.score)[0];
      if (day) chosen.push(day);
    }
    for (const c of pool) {
      if (chosen.length >= want) break;
      if (quiet.has(c.segment)) continue;
      if (!chosen.some((x) => x.key === c.key || x.segment === c.segment)) chosen.push(c);
    }
    // airing order: most pressing first
    items = chosen
      .sort((a, b) => b.score - a.score)
      .map((i) => (i.segment === 'funFacts' ? { segment: i.segment, key: pickFact(recent, rand) } : { segment: i.segment, key: i.key }));
  }

  // heads-ups waiting for this break (something important just changed) go first, ahead of everything else
  const heads = kind === 'callin' || kind === 'headsup' ? [] : (packet.headsUps ?? []).slice(0, 2);
  if (heads.length) items = [...heads.map((h) => ({ segment: 'headsUp' as const, key: `headsup:${h.id}` })), ...items.filter((i) => i.segment !== 'headsUp')];

  const [lo, hi] = rundown ? RUNDOWN_LINES[len] : TALK_LENGTH_LINES[len];
  let lines = lo + Math.floor(rand() * (hi - lo + 1)) + heads.length;
  if (hosts > 1) lines = Math.max(lines, 2);
  if (kind === 'opening' && !rundown && len !== 'short') lines = Math.min(hi, lines + 1);

  const songs = station.segments.songs && kind !== 'callin' && kind !== 'stream';
  return {
    kind,
    topics: items.map((i) => i.segment),
    items,
    lines,
    // the next song is always introduced (the radio needs it); the last one is named only now and then
    outro: songs && Boolean(packet.songBefore) && breaksSinceOutro(recent) >= OUTRO_EVERY[mix]! - 1,
    intro: songs && Boolean(packet.songAfter),
    mix,
    ...(rundown ? { rundown: true } : {}),
    callIn: opts.callIn,
    request: opts.request,
    requestFrom: opts.request ? (opts.requestFrom ?? (kind === 'callin' ? 'call' : 'app')) : undefined,
    ...(opts.notion ? { notion: opts.notion } : {}),
    ...(opts.followUp ? { followUp: opts.followUp } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.action ? { action: opts.action } : {}),
  };
}

/** Strings stored on the Break so the next plans know what was said (segment keys + item keys). */
export function planTopicKeys(plan: BreakPlan): string[] {
  const keys = new Set<string>();
  if (plan.outro || plan.intro) keys.add('songs');
  if (plan.outro) keys.add('outro');
  if (plan.intro) keys.add('intro');
  if (plan.rundown) keys.add('rundown');
  if (plan.callIn) keys.add('callin');
  for (const i of plan.items) {
    keys.add(i.segment);
    keys.add(i.key);
  }
  return [...keys];
}

const sameSong = (a: { title: string; artist: string }, b: { title: string; artist: string }) =>
  a.title.trim().toLowerCase() === b.title.trim().toLowerCase() && a.artist.trim().toLowerCase() === b.artist.trim().toLowerCase();

/** A found request that this break also introduces as the next song (named once: in the intro, the last line). */
export function requestIsNext(plan: Pick<BreakPlan, 'request' | 'intro'>, packet: Pick<ContextPacket, 'songAfter'>): boolean {
  const found = plan.request?.found;
  return Boolean(found && plan.intro && packet.songAfter && sameSong(packet.songAfter, found));
}
