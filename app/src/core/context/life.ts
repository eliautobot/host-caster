// Life events (birthdays, anniversaries), notes and reminders: what is due right now.
import type { LifeEvent, ProfileNote, Reminder } from '../types';

const DAY = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface LifeEventInfo {
  event: LifeEvent;
  /** 0 = today, 1 = tomorrow, -1 = yesterday */
  daysAway: number;
  /** yearly events: how many years it has been (birthday age, anniversary) */
  years?: number;
  /** "today", "tomorrow", "in 3 days", "yesterday" */
  when: string;
}

/** The next (or just passed) occurrence of an event relative to `now`. */
export function lifeEventInfo(event: LifeEvent, now = Date.now()): LifeEventInfo | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.date);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const today = startOfDay(now);
  let target = new Date(y, mo, d).getTime();
  let years: number | undefined;
  if (event.yearly) {
    const thisYear = new Date(now).getFullYear();
    // the closest occurrence: last year, this year or next year
    const options = [thisYear - 1, thisYear, thisYear + 1].map((yy) => ({ yy, t: new Date(yy, mo, d).getTime() }));
    const best = options.reduce((a, b) => (Math.abs(b.t - today) < Math.abs(a.t - today) ? b : a));
    target = best.t;
    years = best.yy - y > 0 ? best.yy - y : undefined;
  }
  const daysAway = Math.round((startOfDay(target) - today) / DAY);
  const when = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : daysAway === -1 ? 'yesterday' : daysAway > 0 ? `in ${daysAway} days` : `${-daysAway} days ago`;
  return { event, daysAway, years, when };
}

/** Events from yesterday up to a week ahead, closest first. */
export function dueLifeEvents(events: LifeEvent[], now = Date.now(), aheadDays = 7): LifeEventInfo[] {
  return events
    .map((e) => lifeEventInfo(e, now))
    .filter((i): i is LifeEventInfo => Boolean(i) && i!.daysAway >= -1 && i!.daysAway <= aheadDays)
    .sort((a, b) => Math.abs(a.daysAway) - Math.abs(b.daysAway));
}

export function activeNotes(notes: ProfileNote[], now = Date.now()): string[] {
  return notes.filter((n) => n.text.trim() && (!n.until || n.until > now)).map((n) => n.text.trim());
}

/** Reminders due in the next 3 hours, or up to 1 hour overdue. */
export function dueReminders(reminders: Reminder[], now = Date.now()): Reminder[] {
  return reminders.filter((r) => r.at > now - 3600_000 && r.at < now + 3 * 3600_000).sort((a, b) => a.at - b.at);
}
