// Holiday calendars, contacts' birthdays and other subscriptions: the listener can read them but does not own them.
// Their events may still be mentioned on air ("it is Election Day"), but nothing from them becomes a to-do on Your list
// ("Bring valid identification", "Adjust clocks back one hour").
import type { CalendarEvent, TrackedItem } from '../types'

const PUBLIC_SUFFIX = '@group.v.calendar.google.com'

/** The Google calendar id of an event ("calId:eventId", the calendar id may itself hold no colon). */
export function calendarIdOf(e: Pick<CalendarEvent, 'id'>): string {
  const i = e.id.indexOf(':')
  return i > 0 ? e.id.slice(0, i) : ''
}

/** True for an event on a calendar the listener only subscribes to (holidays, contacts, read-only shares). */
export function subscribedOnly(e: Pick<CalendarEvent, 'id' | 'source' | 'calendarRole'>): boolean {
  if (e.source !== 'google') return false
  if (e.calendarRole === 'reader' || e.calendarRole === 'freeBusyReader') return true
  const cal = calendarIdOf(e).toLowerCase()
  if (/#(?:holiday|contacts|weeknum|other)@group\.v\.calendar\.google\.com$/.test(cal)) return true
  // a public subscription the server did not label (an older server): never the listener's own
  return cal.endsWith(PUBLIC_SUFFIX) && e.calendarRole !== 'owner' && e.calendarRole !== 'writer'
}

/** Open "to prepare" items that came from a subscribed calendar (kept by an older version): they leave Your list. */
export function subscribedPrepIds(items: TrackedItem[], calendar: CalendarEvent[]): string[] {
  const subscribed = new Set(calendar.filter(subscribedOnly).map((e) => e.id))
  return items
    .filter((i) => i.kind === 'prepare' && i.status !== 'done' && i.status !== 'dismissed' && i.source.type === 'event' && i.source.id)
    .filter((i) => subscribed.has(i.source.id!) || subscribedOnly({ id: i.source.id!, source: 'google' }))
    .map((i) => i.id)
}
