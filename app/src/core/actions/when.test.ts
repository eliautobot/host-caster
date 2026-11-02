import { describe, expect, it } from 'vitest'
import { resolveDue, resolveWhen, zonedToUtc } from './when'

const NY = 'America/New_York'
// Sunday, November 1, 2026 = the US DST end day (2 AM EDT -> 1 AM EST)
const SUN_10AM = new Date('2026-11-01T15:00:00Z') // 10:00 EST

type Row = [phrase: string, now: Date, tz: string, start: string | null, end?: string, extra?: (w: ReturnType<typeof resolveWhen>) => void]

// start/end: ISO with offset for timed, YYYY-MM-DD for all-day; null = refused (end = the reason)
const TABLE: Row[] = [
  ['tomorrow at 3', SUN_10AM, NY, '2026-11-02T15:00:00-05:00', '2026-11-02T16:00:00-05:00', (r) => expect(r.ok && r.when.assumed).toContain('3 as 3 PM')],
  ['tomorrow at 3pm', SUN_10AM, NY, '2026-11-02T15:00:00-05:00', '2026-11-02T16:00:00-05:00'],
  ['tomorrow at 3 p.m.', SUN_10AM, NY, '2026-11-02T15:00:00-05:00'],
  ['Tuesday at 3', SUN_10AM, NY, '2026-11-03T15:00:00-05:00'],
  ['dentist Tuesday at 3', SUN_10AM, NY, '2026-11-03T15:00:00-05:00'],
  ['next Friday at 10am', SUN_10AM, NY, '2026-11-13T10:00:00-05:00'],
  ['this Friday at 10am', SUN_10AM, NY, '2026-11-06T10:00:00-05:00'],
  ['Friday', SUN_10AM, NY, '2026-11-06', '2026-11-07'],
  ['on Sunday', SUN_10AM, NY, '2026-11-08', '2026-11-09'],
  ['all day Friday', SUN_10AM, NY, '2026-11-06', '2026-11-07'],
  ['Friday for 3 days', SUN_10AM, NY, '2026-11-06', '2026-11-09'],
  ['for 20 days starting Friday', SUN_10AM, NY, null, 'too_long'],
  ['today at 4pm', SUN_10AM, NY, '2026-11-01T16:00:00-05:00'],
  ['today at 9am', SUN_10AM, NY, null, 'past'],
  ['at 9am', SUN_10AM, NY, '2026-11-02T09:00:00-05:00', undefined, (r) => expect(r.ok && r.when.assumed.join()).toMatch(/tomorrow/)],
  ['at noon', SUN_10AM, NY, '2026-11-01T12:00:00-05:00'],
  ['tomorrow at midnight', SUN_10AM, NY, '2026-11-03T00:00:00-05:00'],
  ['tomorrow from 3 to 4:30 pm', SUN_10AM, NY, '2026-11-02T15:00:00-05:00', '2026-11-02T16:30:00-05:00'],
  ['tomorrow 3-4pm', SUN_10AM, NY, '2026-11-02T15:00:00-05:00', '2026-11-02T16:00:00-05:00'],
  ['Tuesday from 11 to 1', SUN_10AM, NY, '2026-11-03T11:00:00-05:00', '2026-11-03T13:00:00-05:00'],
  ['tomorrow at 10pm for 3 hours', SUN_10AM, NY, '2026-11-02T22:00:00-05:00', '2026-11-03T01:00:00-05:00'],
  ['tomorrow from 10 pm to 1 am', SUN_10AM, NY, '2026-11-02T22:00:00-05:00', '2026-11-03T01:00:00-05:00'],
  ['tomorrow at 4pm until 2pm', SUN_10AM, NY, null, 'end_before_start'],
  ['tomorrow at 3 for 30 minutes', SUN_10AM, NY, '2026-11-02T15:00:00-05:00', '2026-11-02T15:30:00-05:00'],
  ['tomorrow at 9 for 25 hours', SUN_10AM, NY, null, 'too_long'],
  ['November 20 at 2:30 pm', SUN_10AM, NY, '2026-11-20T14:30:00-05:00'],
  ['Nov 20th at 2:30pm', SUN_10AM, NY, '2026-11-20T14:30:00-05:00'],
  ['the 20th of November at 9am', SUN_10AM, NY, '2026-11-20T09:00:00-05:00'],
  ['11/20 at 9am', SUN_10AM, NY, '2026-11-20T09:00:00-05:00'],
  ['2026-11-20 at 14:00', SUN_10AM, NY, '2026-11-20T14:00:00-05:00'],
  ['October 3 at 10am', SUN_10AM, NY, '2027-10-03T10:00:00-04:00'],
  ['in 3 days', SUN_10AM, NY, '2026-11-04', '2026-11-05'],
  ['in 2 weeks at 10am', SUN_10AM, NY, '2026-11-15T10:00:00-05:00'],
  ['day after tomorrow at 8am', SUN_10AM, NY, '2026-11-03T08:00:00-05:00'],
  ['tomorrow morning', SUN_10AM, NY, '2026-11-02T09:00:00-05:00'],
  ['tomorrow afternoon', SUN_10AM, NY, '2026-11-02T14:00:00-05:00'],
  ['tomorrow at 3 in the morning', SUN_10AM, NY, '2026-11-02T03:00:00-05:00'],
  ['tomorrow evening at 7', SUN_10AM, NY, '2026-11-02T19:00:00-05:00'],
  ['quarter to 4 tomorrow', SUN_10AM, NY, '2026-11-02T15:45:00-05:00'],
  ['half past 2 tomorrow', SUN_10AM, NY, '2026-11-02T14:30:00-05:00'],
  ['yesterday at 3', SUN_10AM, NY, null, 'past'],
  ['last Friday', SUN_10AM, NY, null, 'past'],
  ['whenever', SUN_10AM, NY, null, 'not_understood'],
  // explicit zones
  ['tomorrow at 3 PM Pacific', SUN_10AM, NY, '2026-11-02T18:00:00-05:00', undefined, (r) => expect(r.ok && r.when.spoken).toMatch(/3 PM Pacific/)],
  ['tomorrow at 9am UTC', SUN_10AM, NY, '2026-11-02T04:00:00-05:00'],
  ['tomorrow at 2pm ET', SUN_10AM, 'America/Los_Angeles', '2026-11-02T11:00:00-08:00'],
  // other listener zones
  ['tomorrow at 3', SUN_10AM, 'Europe/London', '2026-11-02T15:00:00+00:00'],
  ['tomorrow at 9:30am', SUN_10AM, 'Asia/Kolkata', '2026-11-02T09:30:00+05:30'],
  ['Friday at noon', SUN_10AM, 'Australia/Sydney', '2026-11-06T12:00:00+11:00'],
  ['tomorrow at 3pm', SUN_10AM, 'America/Phoenix', '2026-11-02T15:00:00-07:00'],
  // DST end day (Nov 1): 1:30 AM happens twice -> the first (EDT); 1 to 3 AM is 3 real hours
  ['today at 1:30am', new Date('2026-11-01T04:30:00Z'), NY, '2026-11-01T01:30:00-04:00'],
  ['today from 1 to 3 am', new Date('2026-11-01T04:30:00Z'), NY, '2026-11-01T01:00:00-04:00', '2026-11-01T03:00:00-05:00',
    (r) => expect(r.ok && r.when.endMs - r.when.startMs).toBe(3 * 3600_000)],
  ['today at 11pm', new Date('2026-11-01T04:30:00Z'), NY, '2026-11-01T23:00:00-05:00'],
  // spring forward (Mar 14, 2027): 2:30 AM does not exist -> 3:30 AM EDT
  ['March 14 at 2:30am', SUN_10AM, NY, '2027-03-14T03:30:00-04:00'],
  // late night: "tomorrow" at 11:55 PM = the next date; at 1 AM = the coming daytime
  ['tomorrow at 3', new Date('2026-11-02T04:55:00Z'), NY, '2026-11-02T15:00:00-05:00'],
  ['tomorrow at 3', new Date('2026-11-02T06:00:00Z'), NY, '2026-11-02T15:00:00-05:00',
    undefined, (r) => expect(r.ok && r.when.assumed).toContain('late-night tomorrow')],
  ['tonight at 11', new Date('2026-11-02T04:55:00Z'), NY, null, 'past'],
  ['at midnight', new Date('2026-11-02T04:55:00Z'), NY, '2026-11-02T00:00:00-05:00'],
  ['in 10 minutes', SUN_10AM, NY, null, 'not_understood'],
]

describe('resolveWhen: phrase table', () => {
  it(`has at least 40 phrases (${TABLE.length})`, () => expect(TABLE.length).toBeGreaterThanOrEqual(40))
  for (const [phrase, now, tz, start, end, extra] of TABLE) {
    it(`${phrase} @ ${now.toISOString()} ${tz}`, () => {
      const r = resolveWhen(phrase, { now, tz })
      if (start === null) {
        expect(r.ok).toBe(false)
        if (!r.ok && end) expect(r.reason).toBe(end)
      } else {
        expect(r.ok, r.ok ? '' : r.message).toBe(true)
        if (!r.ok) return
        expect(r.when.start).toBe(start)
        if (end) expect(r.when.end).toBe(end)
        expect(r.when.spoken).not.toMatch(/—/)
      }
      extra?.(r)
    })
  }
})

describe('resolveWhen: read-back', () => {
  it('says the exact date and both times', () => {
    const r = resolveWhen('Tuesday at 3', { now: SUN_10AM, tz: NY })
    expect(r.ok && r.when.spoken).toBe('Tuesday, November 3, from 3 PM to 4 PM')
  })
  it('all-day read-back', () => {
    const r = resolveWhen('Friday', { now: SUN_10AM, tz: NY })
    expect(r.ok && r.when.spoken).toBe('Friday, November 6, all day')
  })
  it('names next year', () => {
    const r = resolveWhen('October 3 at 10am', { now: SUN_10AM, tz: NY })
    expect(r.ok && r.when.spoken).toMatch(/October 3, 2027/)
  })
  it('refuses an unknown zone', () => {
    const r = resolveWhen('tomorrow at 3', { now: SUN_10AM, tz: 'Mars/Olympus' })
    expect(r.ok).toBe(false)
  })
  it('zonedToUtc picks the first 1:30 AM on the fall-back day', () => {
    expect(new Date(zonedToUtc({ y: 2026, m: 11, d: 1, h: 1, mi: 30 }, NY)).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })
})

describe('resolveDue', () => {
  const ctx = { now: SUN_10AM, tz: NY }
  const DUE: [string, string | null][] = [
    ['renew my license this month', '2026-11-30'],
    ['by the end of the month', '2026-11-30'],
    ['next month', '2026-12-31'],
    ['by Friday', '2026-11-06'],
    ['next week', '2026-11-13'],
    ['end of the week', '2026-11-06'],
    ['tomorrow', '2026-11-02'],
    ['December 3', '2026-12-03'],
    ['on the 15th', '2026-11-15'],
    ['in 3 days', '2026-11-04'],
    ['this weekend', '2026-11-01'],
    ['someday', null],
  ]
  for (const [phrase, date] of DUE) {
    it(phrase, () => expect(resolveDue(phrase, ctx)?.date ?? null).toBe(date))
  }
  it('speaks the month end', () => expect(resolveDue('this month', ctx)?.spoken).toBe('by the end of November (Monday, November 30)'))
})
