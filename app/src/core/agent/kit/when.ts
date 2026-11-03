// Times the model passes to a tool ("Friday at 3", "tomorrow", "2026-11-06T15:00") resolved by code in the
// listener's zone (actions/when.ts), never by the model: the read-back says the resolved day and time.
import { isoWithOffset, resolveDue, resolveWhen, spokenDate, spokenTime, wallAt, zonedToUtc, type WhenContext, type WhenResult } from '../../actions/when';

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DAY = 86_400_000;

export function whenCtx(now = Date.now()): WhenContext {
  let tz = 'UTC';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    /* keep UTC */
  }
  return { now: new Date(now), tz };
}

const dayStr = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function isoMs(m: RegExpExecArray, tz: string): number {
  const [, y, mo, d, h, mi, off] = m;
  if (off) return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00${off === 'Z' ? 'Z' : off.includes(':') ? off : `${off.slice(0, 3)}:${off.slice(3)}`}`);
  return zonedToUtc({ y: +y!, m: +mo!, d: +d!, h: +(h ?? 0), mi: +(mi ?? 0) }, tz);
}

/** An event's time from a tool's arguments: words go through resolveWhen, an ISO day or time is taken as is. */
const TIME_OF_DAY = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)/i;
const dayPart = (words: string) => words.replace(TIME_OF_DAY, ' ').replace(/\bat\b|[,.]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** "Friday, November 6 at 7:30 PM" as the end of "Friday, November 6 at 7 PM": the end's own time is what matters. */
export function endWords(start: string, end: string): string {
  const time = TIME_OF_DAY.exec(end)?.[1];
  if (!time) return end;
  const day = dayPart(end);
  return !day || day === dayPart(start) ? time : end;
}

export function eventTime(start: string, end: string | undefined, minutes: number | undefined, ctx: WhenContext): WhenResult {
  const s = ISO.exec(start.trim());
  if (!s) {
    const phrase = `${start}${end ? ` to ${endWords(start, end)}` : ''}${!end && minutes ? ` for ${minutes} minutes` : ''}`;
    return resolveWhen(phrase, ctx, { defaultMinutes: minutes ?? 60 });
  }
  const now = ctx.now.getTime();
  const year = ctx.now.getFullYear();
  const e = end ? ISO.exec(end.trim()) : null;
  if (!s[4]) {
    // all day: Google's end is the day after the last one
    const first = dayStr(+s[1]!, +s[2]!, +s[3]!);
    const lastMs = e && !e[4] ? Date.parse(`${dayStr(+e[1]!, +e[2]!, +e[3]!)}T00:00:00Z`) : Date.parse(`${first}T00:00:00Z`);
    const after = new Date(lastMs + DAY).toISOString().slice(0, 10);
    const today = wallAt(now, ctx.tz);
    if (first < dayStr(today.y, today.m, today.d)) return { ok: false, reason: 'past', message: 'That day has already passed.' };
    if (after <= first || (Date.parse(after) - Date.parse(first)) / DAY > 14) return { ok: false, reason: 'too_long', message: 'That is too long for one event.' };
    const startMs = Date.parse(`${first}T00:00:00Z`);
    const spoken = `${spokenDate({ y: +s[1]!, m: +s[2]!, d: +s[3]!, h: 0, mi: 0 }, year)}, all day`;
    return { ok: true, when: { allDay: true, start: first, end: after, startMs, endMs: startMs + DAY, tz: ctx.tz, spoken, assumed: [] } };
  }
  const startMs = isoMs(s, ctx.tz);
  const endMs = e && e[4] ? isoMs(e, ctx.tz) : startMs + (minutes ?? 60) * 60_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, reason: 'not_understood', message: 'I could not read that time.' };
  if (startMs < now - 2 * 60_000) return { ok: false, reason: 'past', message: 'That time has already passed.' };
  if (endMs <= startMs) return { ok: false, reason: 'end_before_start', message: 'The end is before the start.' };
  if (endMs - startMs > DAY) return { ok: false, reason: 'too_long', message: 'An event can last at most a day.' };
  const a = wallAt(startMs, ctx.tz);
  const b = wallAt(endMs, ctx.tz);
  const spoken = `${spokenDate(a, year)}, from ${spokenTime(a.h, a.mi)} to ${spokenTime(b.h, b.mi)}`;
  return { ok: true, when: { allDay: false, start: isoWithOffset(startMs, ctx.tz), end: isoWithOffset(endMs, ctx.tz), startMs, endMs, tz: ctx.tz, spoken, assumed: [] } };
}

export interface DueWhen {
  /** YYYY-MM-DD (all day) or an ISO time with offset */
  due: string;
  dueAllDay: boolean;
  /** epoch ms of a timed reminder */
  remindAt?: number;
  spoken: string;
}

const TIMED = /\b(at|@)\s*\d|\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\bnoon\b|\bmidnight\b|\bin \d+ (minutes|hours)\b|T\d{2}:\d{2}/i;

/** A due day ("Friday", "by the end of the month") or, with a time in it, a reminder time ("tomorrow at 9"). */
export function dueOrRemind(phrase: string, ctx: WhenContext): DueWhen | { error: string } {
  const p = phrase.trim();
  if (!p) return { error: 'No day was given.' };
  if (TIMED.test(p)) {
    const w = eventTime(p, undefined, 15, ctx);
    if (w.ok && !w.when.allDay) return { due: w.when.start, dueAllDay: false, remindAt: w.when.startMs, spoken: w.when.spoken.replace(/, from (.+?) to .+$/, ' at $1') };
    if (!w.ok && w.reason === 'past') return { error: w.message };
  }
  const iso = ISO.exec(p);
  if (iso && !iso[4]) {
    const today = wallAt(ctx.now.getTime(), ctx.tz);
    const day = dayStr(+iso[1]!, +iso[2]!, +iso[3]!);
    if (day < dayStr(today.y, today.m, today.d)) return { error: 'That day has already passed.' };
    return { due: day, dueAllDay: true, spoken: spokenDate({ y: +iso[1]!, m: +iso[2]!, d: +iso[3]!, h: 0, mi: 0 }, ctx.now.getFullYear()) };
  }
  const d = resolveDue(p, ctx);
  return d ? { due: d.date, dueAllDay: true, spoken: d.spoken } : { error: `I could not tell which day "${p.slice(0, 40)}" is.` };
}

