// What changed in the listener's day while the radio plays, and how much it matters (pure: core/agent/headsup.ts
// does the watching). An event in the next 12 hours cancelled, moved, newly added, a guest declining, the organizer
// changing, a video link added, an invitation to answer; urgent mail. Mass mail never counts.
import type { CalendarEvent, EmailSummary, HeadsUp, HeadsUpKind } from '../types';
import { clockTime, senderName, subjectGist, whenSpoken } from '../radio/speakable';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** changes to events further out than this are left for the regular breaks */
export const HORIZON_MS = 12 * HOUR;
/** a cancelled or moved meeting this close is urgent */
export const MAJOR_WITHIN_MS = 2 * HOUR;
/** anything that changed and starts this soon is urgent */
export const IMMINENT_MS = 15 * MIN;

/** One event from the watch: a live event, or only the id (and maybe title and start) of a cancelled one. */
export type WatchedEvent = (CalendarEvent & { cancelled?: false }) | { id: string; cancelled: true; declinedByMe?: boolean; title?: string; start?: number };

/** A new message from the watch, with the signs of a mass mailing and of a conversation. */
export interface WatchedMail extends EmailSummary {
  bulk?: boolean;
  reply?: boolean;
  gmailImportant?: boolean;
  starred?: boolean;
  address?: string;
}

const others = (e: CalendarEvent) => (e.attendees ?? []).filter((a) => !a.self && a.status !== 'declined');
export const people = (e: CalendarEvent, n = 3): string | undefined => {
  const names = others(e).map((a) => a.name.split(/\s+/)[0]!).filter(Boolean).slice(0, n);
  return names.length ? (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]) : undefined;
};
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/** "2 PM", "tomorrow at 9 AM": an absolute time, right whenever it is said */
export const atWords = (t: number, now: number) => (sameDay(t, now) ? clockTime(t) : whenSpoken(t, now).replace(/^in .*/, clockTime(t)));
const inWindow = (t: number | undefined, now: number) => t !== undefined && t > now - 5 * MIN && t <= now + HORIZON_MS;
const normPlace = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function make(kind: HeadsUpKind, id: string, title: string, fact: string, why: string, major: boolean, now: number, extra: Partial<HeadsUp> = {}): HeadsUp {
  return { id, kind, title, fact, why, major, at: now, state: 'pending', ...extra };
}

/**
 * Heads-ups from calendar changes. `known` = the events the hosts last knew; `changed` = what the watch says changed
 * (Google: updated since the last check; a feed: the whole new list, with the missing ones as cancelled).
 */
export function diffCalendar(known: CalendarEvent[], changed: WatchedEvent[], now: number): HeadsUp[] {
  const byId = new Map(known.map((e) => [e.id, e]));
  const out: HeadsUp[] = [];
  for (const c of changed) {
    const old = byId.get(c.id);
    if (c.cancelled) {
      // the listener's own decline or their own event is not news to them
      if (c.declinedByMe || old?.organizerSelf) continue;
      const start = old?.start ?? c.start;
      const title = old?.title ?? c.title;
      if (!title || !inWindow(start, now) || old?.allDay) continue;
      const soon = start! - now <= MAJOR_WITHIN_MS;
      const by = old?.organizer && !old.organizerSelf ? ` ${old.organizer} organized it.` : '';
      const withWho = old && people(old) ? ` It was with ${people(old)}.` : '';
      out.push(
        make('cancelled', `cancelled:${c.id}`, title, `"${title}" at ${atWords(start!, now)} was cancelled.${withWho}${by}`, soon ? `Cancelled ${minutesWords(start! - now)} before it starts` : 'Cancelled, later today', soon, now, {
          eventId: c.id,
          start,
        }),
      );
      continue;
    }
    const e = c as CalendarEvent;
    if (e.allDay) continue;
    if (!old) {
      if (!inWindow(e.start, now) || e.organizerSelf) continue;
      if (e.invitation) {
        out.push(make('invite', `invite:${e.id}`, e.title, `${e.organizer ?? 'Someone'} invited you to "${e.title}" at ${atWords(e.start, now)}, and you have not answered yet.`, 'An invitation for something soon needs an answer', e.start - now <= IMMINENT_MS, now, { eventId: e.id, start: e.start }));
      } else {
        const withWho = people(e) ? ` with ${people(e)}` : '';
        out.push(make('new', `new:${e.id}`, e.title, `"${e.title}"${withWho} was just added to your calendar, at ${atWords(e.start, now)}.`, `Added last minute, starts ${whenSpoken(e.start, now)}`, e.start - now <= IMMINENT_MS, now, { eventId: e.id, start: e.start }));
      }
      continue;
    }
    if (!inWindow(e.start, now) && !inWindow(old.start, now)) continue;
    const facts: string[] = [];
    const sig: string[] = [];
    let kind: HeadsUpKind = 'changed';
    const mine = Boolean(old.organizerSelf);
    if (Math.abs(e.start - old.start) >= MIN && !mine) {
      kind = 'moved';
      facts.push(`"${e.title}" moved from ${atWords(old.start, now)} to ${atWords(e.start, now)}.`);
      sig.push(`t${e.start}`);
    }
    if (normPlace(e.location) !== normPlace(old.location) && e.location && !mine) {
      kind = 'moved';
      facts.push(`"${e.title}" is now at ${e.location}${old.location ? `, not ${old.location}` : ''}.`);
      sig.push(`p${normPlace(e.location)}`);
    }
    if (e.video && !old.video) {
      facts.push(`"${e.title}" now has a ${e.video.provider} link.`);
      sig.push('v');
    }
    const was = new Map((old.attendees ?? []).map((a) => [a.name, a.status]));
    for (const a of (e.attendees ?? []).filter((x) => !x.self && x.status === 'declined' && was.has(x.name) && was.get(x.name) !== 'declined').slice(0, 2)) {
      facts.push(`${a.name} declined "${e.title}".`);
      sig.push(`d${a.name}`);
    }
    if (e.organizer && old.organizer && e.organizer !== old.organizer) {
      facts.push(`"${e.title}" is now organized by ${e.organizer}.`);
      sig.push(`o${e.organizer}`);
    }
    if (e.invitation && !old.invitation && !facts.length) {
      kind = 'invite';
      facts.push(`${e.organizer ?? 'Someone'} invited you to "${e.title}" at ${atWords(e.start, now)}, and you have not answered yet.`);
      sig.push('i');
    }
    if (!facts.length) continue;
    const first = Math.min(e.start, old.start);
    const major = (kind === 'moved' && first - now <= MAJOR_WITHIN_MS) || e.start - now <= IMMINENT_MS;
    const why =
      kind === 'moved' ? (major ? `Moved, and it was or is within ${minutesWords(first - now)}` : 'Moved') : kind === 'invite' ? 'An invitation for something soon needs an answer' : major ? 'Changed, and it starts very soon' : 'Changed';
    out.push(make(kind, `${kind}:${e.id}:${sig.join('|')}`, e.title, facts.join(' '), why, major, now, { eventId: e.id, start: e.start }));
  }
  return out;
}

/** A feed (ICS) has no change list: the whole new list against the old one, missing events as cancelled. */
export function feedChanges(known: CalendarEvent[], fresh: CalendarEvent[], now: number): WatchedEvent[] {
  const ids = new Set(fresh.map((e) => e.id));
  const old = new Map(known.map((e) => [e.id, e]));
  const changed: WatchedEvent[] = fresh.filter((e) => {
    const o = old.get(e.id);
    return !o || o.start !== e.start || normPlace(o.location) !== normPlace(e.location) || Boolean(o.video) !== Boolean(e.video);
  });
  for (const e of known) if (!ids.has(e.id) && inWindow(e.start, now)) changed.push({ id: e.id, cancelled: true, title: e.title, start: e.start });
  return changed;
}

/** The known list with the changes applied (what the hosts know from now on). */
export function applyChanges(known: CalendarEvent[], changed: WatchedEvent[]): CalendarEvent[] {
  const map = new Map(known.map((e) => [e.id, e]));
  for (const c of changed) {
    if (c.cancelled) map.delete(c.id);
    else map.set(c.id, c as CalendarEvent);
  }
  return [...map.values()].sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------------------------------------ urgent mail

const URGENT = /\b(urgent|urgently|asap|a\.s\.a\.p|emergency|immediately|time[- ]sensitive|right away|as soon as (you can|possible)|by (noon|eod|end of (the )?day|tonight|today|this (morning|afternoon|evening)|\d{1,2}(:\d{2})?\s*(am|pm))|before (your|the|our|my) (meeting|call)|need (this|it|them|that|your answer) today)\b/i;
const TODAY = /\b(today|tonight|this (morning|afternoon|evening)|in an hour|right now|before \d{1,2}(:\d{2})?\s*(am|pm)?)\b/i;
const MACHINE = /no-?reply|newsletter|notifications?@|mailer-daemon|marketing|news@|digest|unsubscribe/i;

export interface MailJudgement {
  /** worth a look by the brain (not mass mail, some sign of urgency or of a real conversation) */
  candidate: boolean;
  urgent: boolean;
  why: string;
}

/** The people the listener meets today (first names), for "from someone they meet today". */
export function peopleToday(events: CalendarEvent[], now: number): string[] {
  return [
    ...new Set(
      events
        .filter((e) => sameDay(e.start, now) && (e.end ?? e.start + HOUR) > now)
        .flatMap((e) => [...others(e).map((a) => a.name), e.organizerSelf ? '' : (e.organizer ?? '')])
        .map((n) => n.split(/\s+/)[0]!.toLowerCase())
        .filter((n) => n.length > 1),
    ),
  ];
}

/** The rules without a brain (conservative): urgent words from a real person, about today. Mass mail never counts. */
export function mailByRules(m: WatchedMail, meetToday: string[]): MailJudgement {
  const sender = senderName(m.from);
  if (m.bulk || MACHINE.test(`${m.from} ${m.address ?? ''}`)) return { candidate: false, urgent: false, why: 'Mass mail or an automatic sender' };
  const text = `${m.snippet ?? ''} ${m.body ?? ''}`;
  const known = meetToday.includes(sender.split(/\s+/)[0]!.toLowerCase());
  const thread = Boolean(m.reply);
  const important = Boolean(m.gmailImportant || m.starred || m.important);
  const inSubject = URGENT.test(m.subject);
  const inText = URGENT.test(text) || TODAY.test(text);
  const candidate = inSubject || inText || known || (thread && important);
  const urgent = inSubject ? known || thread || important || TODAY.test(`${m.subject} ${text}`) || URGENT.test(text) : URGENT.test(text) && (known || thread || important);
  const why = [
    inSubject || URGENT.test(text) ? 'asks for something urgent' : '',
    known ? `from ${sender}, who you meet today` : '',
    thread ? 'a reply in your conversation' : '',
    important && !known ? 'marked important' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return { candidate, urgent, why: urgent ? `Urgent email: ${why}` : why || 'Nothing urgent' };
}

export function urgentMailHeadsUp(m: WatchedMail, why: string, now: number, gist?: string): HeadsUp {
  const sender = senderName(m.from);
  const what = gist?.trim() || subjectGist(m.subject, 9);
  return make('urgent', `urgent:${m.id}`, m.subject, `An urgent email just came in from ${sender}: ${what.replace(/[.!?]+$/, '')}.`, why, true, now, { mailId: m.id });
}

// ------------------------------------------------------------------------------------------------ reminders

/** Meetings worth a reminder: with guests or a video call, not all day, not declined. */
export const remindable = (e: CalendarEvent) => !e.allDay && e.myResponse !== 'declined' && (others(e).length > 0 || (e.guests ?? 0) > 0 || Boolean(e.video));

/** When the reminder `remindMin` minutes before `e` fires, if that is between now (give or take) and `untilMs` ahead. */
export function reminderAt(e: CalendarEvent, remindMin: number, now: number, untilMs: number): number | undefined {
  if (!remindMin || !remindable(e)) return undefined;
  const at = e.start - remindMin * MIN;
  return at >= now - 90_000 && at <= now + untilMs && e.start > now ? at : undefined;
}

export function reminderHeadsUp(e: CalendarEvent, prepare: string[] | undefined, now: number): HeadsUp {
  const withWho = people(e) ? ` with ${people(e)}` : '';
  const bits = [
    `"${e.title}"${withWho} starts at ${atWords(e.start, now)}.`,
    prepare?.length ? `To bring or prepare: ${prepare.slice(0, 2).map((p) => p.replace(/[\s.!?;,]+$/, '')).join('; ')}.` : '',
    e.video ? `The ${e.video.provider} link is in the event.` : '',
    e.location ? `It is at ${e.location}.` : '',
  ];
  return make('reminder', `reminder:${e.id}:${e.start}`, e.title, bits.filter(Boolean).join(' '), 'A meeting with guests or a video call is about to start', false, now, { eventId: e.id, start: e.start });
}

// ------------------------------------------------------------------------------------------------ on air

/** "in twenty minutes" as words for an interval */
export function minutesWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** The scripted break-in line (no brain, or the brain was too slow), for a moment `at`. */
export function scriptedSay(h: HeadsUp, at: number): string {
  const when = h.start ? atWords(h.start, at) : '';
  switch (h.kind) {
    case 'cancelled':
      return `Quick heads-up: ${h.title}${when ? ` at ${when}` : ''} was just cancelled.`;
    case 'moved':
    case 'changed':
    case 'invite':
    case 'new':
      return `Quick heads-up: ${h.fact}`;
    case 'urgent':
      return `Quick heads-up: ${h.fact.replace(/^An urgent/, 'an urgent')}`;
    case 'reminder':
      return h.start ? `Heads-up, ${h.fact.replace(/ starts at [^.]+\./, ` starts ${whenSpoken(h.start, at)}.`)}` : `Heads-up: ${h.fact}`;
    default:
      return `Quick heads-up: ${h.fact}`;
  }
}

export type Delivery = 'breakin' | 'afterSong' | 'nextBreak';

export interface DeliveryContext {
  /** the listener's choice for urgent things */
  breakIn: 'now' | 'after' | 'off';
  /** break-ins over the music in the last hour */
  breakInsLastHour: number;
  /** what is left of the song (undefined: a stream or another app's music) */
  songLeftMs?: number;
  /** a break follows this song anyway */
  breakAfterSong: boolean;
}

export const BREAKINS_PER_HOUR = 3;
/** a song that ends this soon: the heads-up waits for its end */
export const WAIT_FOR_SONG_MS = 90_000;

/** How a heads-up goes on air: over the music now, right after this song, or first in the next break. */
export function deliveryFor(h: HeadsUp, ctx: DeliveryContext): Delivery {
  const urgent = h.major || h.kind === 'reminder';
  if (!urgent) return 'nextBreak';
  if (ctx.breakIn === 'off') return h.kind === 'reminder' && ctx.breakAfterSong ? 'afterSong' : 'nextBreak';
  const endsSoon = ctx.songLeftMs !== undefined && ctx.songLeftMs <= WAIT_FOR_SONG_MS;
  if (endsSoon || ctx.breakIn === 'after' || ctx.breakInsLastHour >= BREAKINS_PER_HOUR) return 'afterSong';
  return 'breakin';
}

/** "got it", "thanks", "okay": a call-in that acknowledges the last heads-up (it is not told again). */
export const isAcknowledgement = (said: string) => /^\s*(ok(ay)?|got it|gotcha|thanks?|thank you|noted|cool|will do|on it|understood|roger)\b[\s,.!]*([a-z]+[\s,.!]*){0,6}$/i.test(said.trim());
