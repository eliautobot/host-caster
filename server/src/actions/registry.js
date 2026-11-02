// The fixed things the hosts may do in the listener's Google account, and only after the listener confirms: their
// strict schemas (unknown keys refused), levels, the payload hash a confirmation is bound to, and the plain words the
// listener hears before saying yes. Anything else (paying, forwarding or deleting mail, inviting people, editing
// other people's events, sharing) is not an action type at all and is refused with action_not_allowed.
import { sha256 } from '../crypto.js';
import { HttpError } from '../errors.js';

/** level 2: ask first, only their own accounts. level 3: ask first and read back exactly, other people will see it. */
export const TYPES = Object.freeze({
  'calendar.add': { level: 2, service: 'calendarEvents' },
  'task.add': { level: 2, service: 'tasks' },
  'task.complete': { level: 2, service: 'tasks' },
  'task.edit': { level: 2, service: 'tasks' },
  'invite.respond': { level: 3, service: 'calendarEvents' },
});
export const ORIGINS = Object.freeze(['call-in', 'ai-app', 'app']);
export const VIAS = Object.freeze(['call-in', 'tap', 'ai-app']);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** a start a little in the past is fine (the listener took a moment to say yes) */
export const PAST_GRACE_MS = 2 * MINUTE;
const MAX_AHEAD_MS = 3 * 366 * DAY;

export const invalid = (field, message) => new HttpError(400, 'invalid_action', message, { field });

export function notAllowed(type) {
  const what = typeof type === 'string' ? type.slice(0, 40) : 'that';
  return new HttpError(400, 'action_not_allowed', `Host-Caster cannot do "${what}". It only adds to your calendar and your Google Tasks, and answers your invitations.`);
}

// ---- strict field checks --------------------------------------------------------------------------------------------

/** control characters, zero-width spaces, direction overrides: they hide or reorder what the listener hears */
const HIDDEN_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
/** a regex character class from code point ranges (kept as numbers so no invisible character sits in this file) */
const charClass = (ranges) => new RegExp(`[${ranges.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('')}]`);
function esc(n) {
  return `\\u${n.toString(16).padStart(4, '0')}`;
}
const HIDDEN = charClass(HIDDEN_RANGES);
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;
const BREAKS = charClass([[0x09, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]]);

/**
 * A string field: NFC, trimmed, no hidden characters, at most `max` characters. Missing or empty -> undefined
 * (required ones refuse).
 */
function str(p, key, { max, required = false, multiline = false }) {
  const raw = p[key];
  if (raw === undefined || raw === null) {
    if (required) throw invalid(key, `${key} is required`);
    return undefined;
  }
  if (typeof raw !== 'string') throw invalid(key, `${key} must be text`);
  if (raw.length > max * 4 + 64) throw invalid(key, `${key} is too long (at most ${max} characters)`);
  let v = raw.normalize('NFC').replace(/\r\n?/g, '\n');
  if (HIDDEN.test(v)) throw invalid(key, `${key} has hidden characters`);
  if (!multiline && BREAKS.test(v)) throw invalid(key, `${key} must be one line`);
  v = v.trim();
  if ([...v].length > max) throw invalid(key, `${key} is too long (at most ${max} characters)`);
  // nothing anyone could read (only joiners or marks): as good as empty
  if (!VISIBLE.test(v)) v = '';
  if (!v) {
    if (required) throw invalid(key, `${key} is required`);
    return undefined;
  }
  return v;
}

function ident(p, key, re, { required = true, dflt } = {}) {
  const v = p[key];
  if (v === undefined || v === null || v === '') {
    if (dflt !== undefined) return dflt;
    if (required) throw invalid(key, `${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || !re.test(v)) throw invalid(key, `${key} is not valid`);
  return v;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** "YYYY-MM-DD" that is a real calendar day between 2000 and 2100 */
export function isDay(s) {
  const m = typeof s === 'string' ? DAY_RE.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);

/** ISO 8601 date-time WITH an offset (or Z): "2026-11-03T15:00:00-05:00" */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|1[0-4]):[0-5]\d)$/;
function isStamp(s) {
  const m = typeof s === 'string' ? STAMP_RE.exec(s) : null;
  return Boolean(m && isDay(m[1]) && Number.isFinite(Date.parse(s)));
}

const TZ_RE = /^(?:UTC|[A-Za-z]+(?:[_-][A-Za-z]+)*(?:\/[A-Za-z0-9]+(?:[_+-][A-Za-z0-9]+)*){1,2})$/;
export function isTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64 || !TZ_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** today's date ("YYYY-MM-DD") in a time zone */
export const todayIn = (tz, now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const LIST_ID = /^(?:@default|[A-Za-z0-9_-]{1,200})$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CAL_ID = /^(?:primary|[A-Za-z0-9._%+-]{1,120}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5})$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,300}$/;
const RESPONSES = ['accepted', 'declined', 'tentative'];

function onlyKeys(p, allowed) {
  for (const k of Object.keys(p)) if (!allowed.includes(k)) throw invalid(k, `Unknown field "${String(k).slice(0, 40)}"`);
}

function bool(p, key) {
  if (typeof p[key] !== 'boolean') throw invalid(key, `${key} must be true or false`);
  return p[key];
}

function due(p, key, { nullable = false } = {}) {
  const v = p[key];
  if (v === undefined) return undefined;
  if (v === null && nullable) return null;
  if (!isDay(v)) throw invalid(key, `${key} must be a day like 2026-11-05`);
  return v;
}

const SCHEMAS = {
  'calendar.add'(p, { now }) {
    onlyKeys(p, ['title', 'allDay', 'start', 'end', 'timeZone', 'location', 'notes']);
    const out = { title: str(p, 'title', { max: 120, required: true }), allDay: bool(p, 'allDay') };
    if (!isTimeZone(p.timeZone)) throw invalid('timeZone', 'timeZone must be a time zone like America/New_York');
    if (out.allDay) {
      if (!isDay(p.start)) throw invalid('start', 'start must be a day like 2026-11-05');
      if (!isDay(p.end)) throw invalid('end', 'end must be a day like 2026-11-06 (the day after the last one)');
      const days = (dayMs(p.end) - dayMs(p.start)) / DAY;
      if (days < 1) throw invalid('end', 'The end must be after the start');
      if (days > 14) throw invalid('end', 'An all-day event can last at most 14 days');
      if (now !== undefined) {
        if (p.start < todayIn(p.timeZone, now)) throw invalid('start', 'That day has already passed');
        if (dayMs(p.start) > now + MAX_AHEAD_MS) throw invalid('start', 'That is too far ahead');
      }
    } else {
      if (!isStamp(p.start)) throw invalid('start', 'start must be a date and time with its offset, like 2026-11-03T15:00:00-05:00');
      if (!isStamp(p.end)) throw invalid('end', 'end must be a date and time with its offset, like 2026-11-03T16:00:00-05:00');
      const s = Date.parse(p.start);
      const e = Date.parse(p.end);
      if (e <= s) throw invalid('end', 'The end must be after the start');
      if (e - s > DAY) throw invalid('end', 'An event can last at most 24 hours');
      if (now !== undefined) {
        if (s < now - PAST_GRACE_MS) throw invalid('start', 'That time has already passed');
        if (s > now + MAX_AHEAD_MS) throw invalid('start', 'That is too far ahead');
      }
    }
    out.start = p.start;
    out.end = p.end;
    out.timeZone = p.timeZone;
    const location = str(p, 'location', { max: 200 });
    const notes = str(p, 'notes', { max: 500, multiline: true });
    if (location) out.location = location;
    if (notes) out.notes = notes;
    return out;
  },

  'task.add'(p) {
    onlyKeys(p, ['title', 'notes', 'due', 'listId']);
    const out = { title: str(p, 'title', { max: 200, required: true }), listId: ident(p, 'listId', LIST_ID, { dflt: '@default' }) };
    const notes = str(p, 'notes', { max: 500, multiline: true });
    const d = due(p, 'due');
    if (notes) out.notes = notes;
    if (d) out.due = d;
    return out;
  },

  'task.complete'(p) {
    onlyKeys(p, ['listId', 'taskId', 'title']);
    return { listId: ident(p, 'listId', LIST_ID), taskId: ident(p, 'taskId', TASK_ID), title: str(p, 'title', { max: 200, required: true }) };
  },

  'task.edit'(p) {
    onlyKeys(p, ['listId', 'taskId', 'title', 'due', 'notes']);
    const out = { listId: ident(p, 'listId', LIST_ID), taskId: ident(p, 'taskId', TASK_ID) };
    if (p.title !== undefined) out.title = str(p, 'title', { max: 200, required: true });
    if (p.due !== undefined) out.due = due(p, 'due', { nullable: true });
    if (p.notes !== undefined) out.notes = p.notes === null ? null : (str(p, 'notes', { max: 500, multiline: true }) ?? null);
    if (!('title' in out) && !('due' in out) && !('notes' in out)) throw invalid('title', 'Say what to change: title, due or notes');
    return out;
  },

  'invite.respond'(p) {
    onlyKeys(p, ['calendarId', 'eventId', 'response', 'note']);
    const out = { calendarId: ident(p, 'calendarId', CAL_ID, { dflt: 'primary' }), eventId: ident(p, 'eventId', EVENT_ID) };
    if (!RESPONSES.includes(p.response)) throw invalid('response', 'response must be accepted, declined or tentative');
    out.response = p.response;
    const note = str(p, 'note', { max: 300, multiline: true });
    if (note) out.note = note;
    return out;
  },
};

/**
 * The payload as stored and hashed (defaults filled in, text trimmed). Throws 400 action_not_allowed for any type
 * that is not one of TYPES and 400 invalid_action (with `field`) for a bad payload. `now` turns on the checks
 * against the clock (start in the past, too far ahead); without it only the shape is checked.
 */
export function normalize(type, payload, { now } = {}) {
  if (typeof type !== 'string' || !Object.hasOwn(TYPES, type)) throw notAllowed(type);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('payload', 'payload must be an object');
  return SCHEMAS[type](payload, { now });
}

/** JSON with sorted keys and no spaces, so the same content always gives the same text */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** sha256 (hex) of the canonical { type, payload }: what a confirmation and its token are bound to */
export const payloadHash = (type, payload) => sha256(canonicalJson({ type, payload }));

// ---- plain words ----------------------------------------------------------------------------------------------------

const SPACES = charClass([[0xa0, 0xa0], [0x202f, 0x202f]]);
const plain = (s) => s.replace(new RegExp(SPACES.source, 'g'), ' ');

function dayWords(ms, timeZone, now) {
  const d = plain(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(ms));
  const year = (t) => new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(t);
  return year(ms) === year(now) ? d : `${d}, ${year(ms)}`;
}

function timeWords(ms, timeZone) {
  return plain(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(ms)).replace(':00 ', ' ');
}

const sameDay = (a, b, timeZone) => todayIn(timeZone, a) === todayIn(timeZone, b);

/** "on Tuesday, November 3, from 3 PM to 4 PM" / "on Tuesday, November 3, all day" / "from ... to ..." */
export function whenWords({ allDay, start, end, timeZone }, now = Date.now()) {
  if (allDay) {
    const s = dayMs(start);
    const last = dayMs(end) - DAY;
    if (last <= s) return `on ${dayWords(s, 'UTC', now)}, all day`;
    return `from ${dayWords(s, 'UTC', now)} to ${dayWords(last, 'UTC', now)}, all day`;
  }
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (sameDay(s, e, timeZone) || (e - s <= DAY && timeWords(e, timeZone) === '12 AM' && sameDay(s, e - 1, timeZone))) {
    return `on ${dayWords(s, timeZone, now)}, from ${timeWords(s, timeZone)} to ${timeWords(e, timeZone)}`;
  }
  return `from ${dayWords(s, timeZone, now)} at ${timeWords(s, timeZone)} to ${dayWords(e, timeZone, now)} at ${timeWords(e, timeZone)}`;
}

const dueWords = (day, now) => dayWords(dayMs(day), 'UTC', now);

function joinAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const ANSWER = { accepted: 'yes', declined: 'no', tentative: 'maybe' };

/**
 * What the listener hears and sees before they confirm: `summary` (exactly what will happen) and `others` (who else
 * will see it, level 3). `context` comes from Google at propose time (the task's title now, the invitation).
 */
export function describe(type, payload, context = {}, now = Date.now()) {
  switch (type) {
    case 'calendar.add': {
      const where = payload.location ? `, at ${payload.location}` : '';
      return { summary: `Add "${payload.title}" to your Google Calendar ${whenWords(payload, now)}${where}. No one is invited.` };
    }
    case 'task.add': {
      const list = context.listTitle ? `your "${context.listTitle}" list in Google Tasks` : 'your Google Tasks';
      return { summary: `Add "${payload.title}" to ${list}${payload.due ? `, due ${dueWords(payload.due, now)}` : ''}.` };
    }
    case 'task.complete':
      return { summary: `Mark "${payload.title}" as done in your Google Tasks.` };
    case 'task.edit': {
      const parts = [];
      if (payload.title !== undefined) parts.push(`rename it "${payload.title}"`);
      if (payload.due === null) parts.push('remove its due date');
      else if (payload.due !== undefined) parts.push(`make it due ${dueWords(payload.due, now)}`);
      if (payload.notes === null) parts.push('remove its notes');
      else if (payload.notes !== undefined) parts.push('replace its notes');
      const name = context.currentTitle ? `"${context.currentTitle}"` : 'the task';
      return { summary: `Change ${name} in your Google Tasks: ${joinAnd(parts)}.` };
    }
    case 'invite.respond': {
      const tz = context.tz && isTimeZone(context.tz) ? context.tz : 'UTC';
      let when = '';
      if (context.allDay && context.startDate) when = ` on ${dueWords(context.startDate, now)}`;
      else if (Number.isFinite(context.start)) when = ` on ${dayWords(context.start, tz, now)}, at ${timeWords(context.start, tz)}`;
      const note = payload.note ? ` Your note: "${payload.note}".` : '';
      const others = context.organizer ? `${context.organizer}, the organizer, will see your answer.` : 'The organizer will see your answer.';
      return { summary: `Answer ${ANSWER[payload.response]} to "${context.title || 'the invitation'}"${when}.${note} ${others}`, others };
    }
    default:
      throw notAllowed(type);
  }
}
