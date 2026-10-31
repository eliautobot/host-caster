// Minimal iCalendar (ICS) reader: VEVENTs with times, all-day dates, TZID and simple RRULEs, for a time window.
import type { CalendarEvent } from '../types';

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line: string): Prop | undefined {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon < 0) return undefined;
  const [name = '', ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

export function unescapeText(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

/** Offset (ms) of `timeZone` from UTC at `utcMs`. */
function tzOffset(utcMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - utcMs;
  } catch {
    return -new Date(utcMs).getTimezoneOffset() * 60_000;
  }
}

interface IcsTime {
  /** the wall-clock time written in the file, encoded as if it were UTC */
  wall: number;
  /** 'utc' (Z), 'local' (floating / all-day) or an IANA zone (TZID) */
  zone: string;
  allDay: boolean;
}

function readIcsTime(value: string, params: Record<string, string> = {}): IcsTime | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, z] = m;
  const allDay = h === undefined || params.VALUE === 'DATE';
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), allDay ? 0 : Number(h), allDay ? 0 : Number(mi), allDay ? 0 : Number(s ?? 0));
  return { wall, allDay, zone: allDay ? 'local' : z ? 'utc' : (params.TZID ?? 'local') };
}

/** Wall-clock time in `zone` -> epoch ms. */
function wallToUtc(wall: number, zone: string): number {
  if (zone === 'utc') return wall;
  if (zone === 'local') {
    const d = new Date(wall);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
  }
  // two passes handle DST edges
  let utc = wall - tzOffset(wall, zone);
  utc = wall - tzOffset(utc, zone);
  return utc;
}

/** ICS date or date-time -> epoch ms. */
export function parseIcsDate(value: string, params: Record<string, string> = {}): { at: number; allDay: boolean } | undefined {
  const t = readIcsTime(value, params);
  return t && { at: wallToUtc(t.wall, t.zone), allDay: t.allDay };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86_400_000;

/** Occurrence start times (epoch ms) of a simple RRULE, stepped in the event's own wall-clock time. */
function occurrences(start: IcsTime, rrule: string | undefined, from: number, to: number): number[] {
  const first = wallToUtc(start.wall, start.zone);
  if (!rrule) return [first];
  const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=') as [string, string]));
  const freq = r.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq ?? '')) return [first];
  const interval = Math.max(1, Number(r.INTERVAL ?? 1));
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? (parseIcsDate(r.UNTIL)?.at ?? Infinity) : Infinity;
  const byDay = r.BYDAY?.split(',').map((d) => DAYS.indexOf(d.replace(/^[+-]?\d+/, ''))).filter((d) => d >= 0);
  const out: number[] = [];
  let n = 0;
  for (let i = 0; i < 3000 && n < count; i++) {
    const d = new Date(start.wall);
    if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + i * interval);
    else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + i * 7 * interval);
    else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + i * interval);
    else d.setUTCFullYear(d.getUTCFullYear() + i * interval);
    const walls =
      freq === 'WEEKLY' && byDay?.length ? byDay.map((wd) => d.getTime() + (wd - d.getUTCDay()) * DAY_MS) : [d.getTime()];
    for (const w of walls.sort((a, b) => a - b)) {
      if (w < start.wall) continue;
      const at = wallToUtc(w, start.zone);
      if (at > until || n >= count) return out;
      n++;
      if (at >= from && at <= to) out.push(at);
    }
    if (wallToUtc(d.getTime(), start.zone) > to) break;
  }
  return out;
}

/** Events that overlap [from, to], sorted by start. */
export function parseIcs(text: string, from: number, to: number): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let cur: Prop[] | undefined;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = [];
    else if (line === 'END:VEVENT' && cur) {
      const props = cur;
      cur = undefined;
      const get = (n: string) => props.find((p) => p.name === n);
      const startP = get('DTSTART');
      const start = startP && readIcsTime(startP.value, startP.params);
      if (!start || get('STATUS')?.value === 'CANCELLED') continue;
      const endP = get('DTEND');
      const end = endP && readIcsTime(endP.value, endP.params);
      const length = end ? end.wall - start.wall : start.allDay ? DAY_MS : 3_600_000;
      const uid = get('UID')?.value ?? `${start.wall}`;
      for (const at of occurrences(start, get('RRULE')?.value, from - length, to)) {
        if (at + length < from || at > to) continue;
        events.push({
          id: `ics:${uid}:${at}`,
          title: unescapeText(get('SUMMARY')?.value ?? 'Busy'),
          start: at,
          end: at + length,
          allDay: start.allDay,
          location: get('LOCATION') ? unescapeText(get('LOCATION')!.value) || undefined : undefined,
          source: 'ics',
        });
      }
    } else if (cur) {
      const p = parseLine(line);
      if (p) cur.push(p);
    }
  }
  return events.sort((a, b) => a.start - b.start);
}
