// What a break talks about: topic rotation with per-segment and per-item cooldowns, respecting station.segments,
// talkEvery and talkLength. Pure and deterministic given `rand`, so it is easy to test.
import type { SongRequest } from './requests';
import type { Break, ContextPacket, SegmentKey, Station } from '../types';
import { FUN_FACTS } from './facts';

export type BreakKind = 'regular' | 'opening' | 'callin' | 'stream';
export type TopicKey = SegmentKey | 'inbox';

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
  /** what the listener said (call-ins) */
  callIn?: string;
  /** a song the listener (or their AI app) asked for, queued next when found */
  request?: SongRequest;
  /** the request came from an AI app, not a call */
  requestFrom?: 'call' | 'app';
}

export const TALK_LENGTH_LINES = { short: [1, 2], normal: [3, 4], long: [5, 8] } as const;
const TOPICS_PER_BREAK = { short: 1, normal: 2, long: 3 } as const;

const MIN = 60_000;
/** a segment rests this long after it was on air */
export const SEGMENT_COOLDOWN: Record<TopicKey, number> = {
  songs: 0,
  time: 25 * MIN,
  weather: 45 * MIN,
  calendar: 20 * MIN,
  email: 45 * MIN,
  news: 20 * MIN,
  lifeEvents: 60 * MIN,
  notes: 30 * MIN,
  reminders: 10 * MIN,
  funFacts: 20 * MIN,
  inbox: 0,
};
/** the same item (one calendar event, one headline) rests this long */
export const ITEM_COOLDOWN: Partial<Record<TopicKey, number>> = {
  calendar: 45 * MIN,
  email: 4 * 60 * MIN,
  news: 6 * 60 * MIN,
  lifeEvents: 3 * 60 * MIN,
  notes: 2 * 60 * MIN,
  reminders: 30 * MIN,
  inbox: Infinity,
};

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

/** Every topic the packet can support right now, with a score (higher = sooner on air). */
export function candidates(station: Station, packet: ContextPacket, recent: Break[], now: number): Candidate[] {
  const seg = station.segments;
  const out: Candidate[] = [];
  const free = (key: string, segment: TopicKey) => now - lastUsed(key, recent) >= (ITEM_COOLDOWN[segment] ?? 0);
  const rest = (segment: TopicKey) => now - lastUsed(segment, recent) >= SEGMENT_COOLDOWN[segment];
  const stale = (segment: TopicKey) => Math.min(30, (now - lastUsed(segment, recent)) / (4 * MIN));
  const add = (segment: TopicKey, key: string, base: number) => {
    if (!rest(segment) || !free(key, segment)) return false;
    out.push({ segment, key, score: base + stale(segment) });
    return true;
  };

  for (const item of packet.inbox ?? []) if (add('inbox', `inbox:${item.id}`, item.kind === 'segment' ? 95 : 85)) break;
  if (seg.reminders) {
    for (const r of packet.reminders ?? []) {
      const soon = r.at - now < 30 * MIN;
      if (add('reminders', `reminders:${r.id}`, soon ? 100 : 55)) break;
    }
  }
  if (seg.time) add('time', 'time', 28);
  if (seg.weather && packet.weather) add('weather', 'weather', 42);
  if (seg.calendar) {
    for (const e of packet.calendar ?? []) {
      const soon = e.start - now < 2 * 60 * MIN && e.start > now - 15 * MIN;
      if (add('calendar', `calendar:${e.id}`, soon ? 72 : 38)) break;
    }
  }
  if (seg.email) for (const m of packet.email ?? []) if (add('email', `email:${m.id}`, m.important ? 40 : 28)) break;
  if (seg.news) for (const h of packet.news ?? []) if (add('news', h.id, 32)) break;
  if (seg.lifeEvents) {
    for (const e of packet.lifeEvents ?? []) {
      const today = isToday(e.date, now, e.yearly);
      if (add('lifeEvents', `lifeEvents:${e.id}`, today ? 82 : 40)) break;
    }
  }
  if (seg.notes) for (const n of packet.notes ?? []) if (add('notes', noteKey(n), 34)) break;
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

export interface PlanOptions {
  kind?: BreakKind;
  callIn?: string;
  request?: SongRequest;
  requestFrom?: 'call' | 'app';
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
  let want: number = TOPICS_PER_BREAK[len];
  if (kind === 'callin') want = len === 'short' ? 0 : 1;

  const pool = candidates(station, packet, recent, now).map((c) => ({ ...c, score: c.score + rand() * 10 }));
  if (kind === 'opening') {
    for (const c of pool) if (c.segment === 'time' || c.segment === 'weather') c.score += 60;
  }
  pool.sort((a, b) => b.score - a.score);
  const items = pool.slice(0, want).map((i) => (i.segment === 'funFacts' ? { ...i, key: pickFact(recent, rand) } : i));

  const [lo, hi] = TALK_LENGTH_LINES[len];
  let lines = lo + Math.floor(rand() * (hi - lo + 1));
  if (hosts > 1) lines = Math.max(lines, 2);
  if (kind === 'opening' && len !== 'short') lines = Math.min(hi, lines + 1);

  const songs = station.segments.songs && kind !== 'callin' && kind !== 'stream';
  return {
    kind,
    topics: items.map((i) => i.segment),
    items,
    lines,
    outro: songs && Boolean(packet.songBefore),
    intro: songs && Boolean(packet.songAfter),
    callIn: opts.callIn,
    request: opts.request,
    requestFrom: opts.request ? (opts.requestFrom ?? (kind === 'callin' ? 'call' : 'app')) : undefined,
  };
}

/** Strings stored on the Break so the next plans know what was said (segment keys + item keys). */
export function planTopicKeys(plan: BreakPlan): string[] {
  const keys = new Set<string>();
  if (plan.outro || plan.intro) keys.add('songs');
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
