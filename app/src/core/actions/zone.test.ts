import { describe, expect, it } from 'vitest'
import { askLine, doneLine } from './callin'
import type { ActionRecord } from './types'
import { zoneCity, zoneNote } from './when'

const rec = (payload: Record<string, unknown>): ActionRecord =>
  ({
    id: 'a1',
    type: 'calendar.add',
    level: 2,
    status: 'proposed',
    payload,
    summary: 'Add "Host-Caster test" to your Google Calendar on Monday, November 2, from 4 PM to 5 PM. No one is invited.',
    createdAt: 0,
  }) as unknown as ActionRecord

// the real case: the browser was in UTC, the Google Calendar in New York
const UTC_EVENT = { title: 'Host-Caster test', start: '2026-11-02T16:00:00Z', end: '2026-11-02T17:00:00Z', timeZone: 'UTC' }

describe('the time zone is named when the device and the Google Calendar differ', () => {
  it('names both: "4 PM UTC, which is 11 AM in your Google Calendar\'s time zone, New York"', () => {
    expect(zoneNote(UTC_EVENT, 'America/New_York')).toBe("That is 4 PM UTC, which is 11 AM in your Google Calendar's time zone, New York.")
  })
  it('the read-back and the done line both say it', () => {
    const a = rec(UTC_EVENT)
    expect(askLine(a, 'America/New_York')).toBe(
      `Just to check: ${a.summary} That is 4 PM UTC, which is 11 AM in your Google Calendar's time zone, New York. Should I go ahead? Just say yes or no.`,
    )
    expect(doneLine(a, 'America/New_York')).toBe(
      "Done. Host-Caster test is on your Google Calendar for Monday, November 2, from 4 PM to 5 PM. That is 4 PM UTC, which is 11 AM in your Google Calendar's time zone, New York.",
    )
  })
  it('silent when the zones agree, are the same offset, or the Google zone is unknown', () => {
    const ny = { ...UTC_EVENT, timeZone: 'America/New_York' }
    expect(zoneNote(ny, 'America/New_York')).toBe('')
    expect(zoneNote(ny, 'America/Detroit')).toBe('')
    expect(zoneNote(UTC_EVENT, undefined)).toBe('')
    expect(zoneNote(UTC_EVENT, 'Not/AZone')).toBe('')
    expect(askLine(rec(ny), 'America/New_York')).not.toMatch(/time zone/)
    expect(doneLine(rec(UTC_EVENT))).not.toMatch(/time zone/)
  })
  it('all-day events have no clock time to explain', () => {
    expect(zoneNote({ allDay: true, start: '2026-11-03', timeZone: 'UTC' }, 'America/New_York')).toBe('')
  })
  it('a different day in the Google zone says the day', () => {
    const late = { start: '2026-11-03T01:00:00Z', end: '2026-11-03T02:00:00Z', timeZone: 'UTC' }
    expect(zoneNote(late, 'America/Los_Angeles')).toBe("That is 1 AM UTC, which is 5 PM on Monday in your Google Calendar's time zone, Los Angeles.")
  })
  it('a city zone on the device is said as "<city> time"; DST is respected', () => {
    const la = { start: '2026-07-01T19:00:00Z', end: '2026-07-01T20:00:00Z', timeZone: 'America/Los_Angeles' }
    expect(zoneNote(la, 'Europe/London')).toBe("That is noon Los Angeles time, which is 8 PM in your Google Calendar's time zone, London.")
    // the US left DST on Nov 1, London on Oct 25: New York is 5 hours behind London again
    const nyNov = { start: '2026-11-02T15:00:00Z', end: '2026-11-02T16:00:00Z', timeZone: 'America/New_York' }
    expect(zoneNote(nyNov, 'Europe/London')).toBe("That is 10 AM New York time, which is 3 PM in your Google Calendar's time zone, London.")
  })
  it('zone names people say', () => {
    expect(['UTC', 'Etc/UTC', 'GMT', 'America/New_York', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires'].map(zoneCity)).toEqual([
      'UTC',
      'UTC',
      'UTC',
      'New York',
      'Kolkata',
      'Buenos Aires',
    ])
  })
  it('other actions never get a zone note', () => {
    const t = { ...rec(UTC_EVENT), type: 'task.add', payload: { title: 'X', due: '2026-11-06' }, summary: 'Add "X" to Google Tasks.' } as unknown as ActionRecord
    expect(askLine(t, 'America/New_York')).not.toMatch(/time zone/)
  })
})
