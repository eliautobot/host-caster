import { describe, expect, it } from 'vitest'
import type { CalendarEvent, Dossier } from '../types'
import { eventDetailFacts } from '../agent/brief'
import { extractItems } from './extract'
import { subscribedOnly, subscribedPrepIds } from './owned'
import type { TrackedItem } from '../types'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const ev = (id: string, title: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title,
  start: NOW + 20 * 3600_000,
  end: NOW + 44 * 3600_000,
  allDay: true,
  source: 'google',
  ...extra,
})
const dossier = (e: CalendarEvent, prepare: string[]): Dossier => ({ key: `calendar:${e.id}`, version: '1', kind: 'calendar', title: e.title, prepare } as Dossier)

const HOLIDAY = ev('en.usa#holiday@group.v.calendar.google.com:20261103_election', 'Election Day', { calendarRole: 'reader', calendar: 'Holidays in United States' })
const DST = ev('en.usa#holiday@group.v.calendar.google.com:20261101_dst', 'Daylight Saving Time ends')
const BIRTHDAY = ev('addressbook#contacts@group.v.calendar.google.com:bday1', "Dana's birthday")
const SPORTS = ev('sports123@group.v.calendar.google.com:game1', 'Team game', { calendarRole: 'freeBusyReader' })
const SHARED_RO = ev('partner@example.com:dinner1', 'Dinner with the Reyes family', { calendarRole: 'reader', allDay: false })
const MINE = ev('me@example.com:lunch1', 'Lunch with Priya', { calendarRole: 'owner', allDay: false })
const MY_GROUP = ev('abc123@group.calendar.google.com:trip1', 'Trip planning', { calendarRole: 'owner', allDay: false })

describe('holiday and other subscribed calendars give no to-dos', () => {
  it('knows which calendars the listener only subscribes to', () => {
    expect([HOLIDAY, DST, BIRTHDAY, SPORTS, SHARED_RO].map(subscribedOnly)).toEqual([true, true, true, true, true])
    expect([MINE, MY_GROUP].map(subscribedOnly)).toEqual([false, false])
    expect(subscribedOnly({ id: 'x#holiday@group.v.calendar.google.com:1', source: 'ics' })).toBe(false)
  })

  it('Election Day and the clock change bring no "To prepare" items; the listener\'s own events still do', () => {
    const calendar = [HOLIDAY, DST, BIRTHDAY, SPORTS, SHARED_RO, MINE]
    const dossiers = new Map<string, Dossier>([
      [`calendar:${HOLIDAY.id}`, dossier(HOLIDAY, ['Bring valid identification', 'Verify polling locations'])],
      [`calendar:${DST.id}`, dossier(DST, ['Adjust clocks back one hour'])],
      [`calendar:${BIRTHDAY.id}`, dossier(BIRTHDAY, ['Buy a card for Dana'])],
      [`calendar:${SPORTS.id}`, dossier(SPORTS, ['Wear the team shirt'])],
      [`calendar:${SHARED_RO.id}`, dossier(SHARED_RO, ['Bring dessert'])],
      [`calendar:${MINE.id}`, dossier(MINE, ['Bring the Q4 notes'])],
    ])
    const items = extractItems({ calendar, dossiers, now: NOW, tz: 'America/New_York' })
    expect(items.map((i) => i.what)).toEqual(['Bring the Q4 notes'])
  })

  it('the hosts may mention the day, but get no TO PREPARE for it', () => {
    const facts = eventDetailFacts(HOLIDAY, [], dossier(HOLIDAY, ['Bring valid identification']))
    expect(facts.join(' ')).not.toMatch(/TO PREPARE|identification/)
    expect(eventDetailFacts(MINE, [], dossier(MINE, ['Bring the Q4 notes'])).join(' ')).toMatch(/TO PREPARE: Bring the Q4 notes/)
  })
  it('to-dos an older version kept from a holiday calendar leave Your list', () => {
    const item = (id: string, sourceId: string, kind = 'prepare'): TrackedItem => ({ id, what: id, kind, status: 'open', source: { type: 'event', id: sourceId, label: 'x' } } as TrackedItem)
    const items = [item('a', HOLIDAY.id), item('b', DST.id), item('c', SHARED_RO.id), item('d', MINE.id), item('e', HOLIDAY.id, 'todo')]
    expect(subscribedPrepIds(items, [SHARED_RO, MINE])).toEqual(['a', 'b', 'c'])
  })
})
