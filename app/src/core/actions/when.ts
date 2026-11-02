// Turns what the listener said ("Tuesday at 3", "tomorrow at noon for 30 minutes", "this month") into exact,
// zone-correct times. Pure code (no model): the read-back says the resolved date and time, so whatever the
// listener confirms is exactly what gets written. Handles the listener's time zone incl. DST change days, all-day
// events, "next Friday", late-night "tomorrow", explicit zones ("3 PM Pacific"), and refuses the past and
// absurd durations.

export interface WhenContext {
  now: Date
  tz: string
}

export interface ResolvedWhen {
  allDay: boolean
  /** timed: ISO with offset ("2026-11-03T15:00:00-05:00"); all-day: "2026-11-03" */
  start: string
  /** timed: ISO with offset; all-day: the day AFTER the last day (Google's exclusive end) */
  end: string
  startMs: number
  endMs: number
  tz: string
  /** what the host reads back, e.g. "Tuesday, November 3, from 3 PM to 4 PM" */
  spoken: string
  /** guesses we made, read back by the host when present ("I took 3 as 3 PM") */
  assumed: string[]
}

export type WhenFail = 'not_understood' | 'past' | 'too_long' | 'end_before_start' | 'bad_zone'
export type WhenResult = { ok: true; when: ResolvedWhen } | { ok: false; reason: WhenFail; message: string }

export interface DueResult {
  /** YYYY-MM-DD in the listener's zone */
  date: string
  spoken: string
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fortyfive: 45, a: 1, an: 1, half: 0.5,
}
const ZONES: Record<string, string> = {
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  utc: 'UTC', gmt: 'UTC', 'london time': 'Europe/London', 'uk time': 'Europe/London', 'paris time': 'Europe/Paris',
  'berlin time': 'Europe/Berlin', 'tokyo time': 'Asia/Tokyo', 'india time': 'Asia/Kolkata', 'sydney time': 'Australia/Sydney',
}

const MAX_TIMED_MS = 24 * 3600_000
const MAX_ALLDAY_DAYS = 14
/** a little grace so "now" said at 3:00:20 for 3:00 is not refused */
const PAST_GRACE_MS = 2 * 60_000

// ---------- zone math (Intl only, no date library) ----------

interface Wall { y: number; m: number; d: number; h: number; mi: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    fmtCache.set(tz, f)
  }
  return f
}

export function validZone(tz: string): boolean {
  try { fmt(tz); return true } catch { return false }
}

/** The wall clock in `tz` at instant `ms`. */
export function wallAt(ms: number, tz: string): Wall & { s: number } {
  const p: Record<string, number> = {}
  for (const part of fmt(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second }
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
export function offsetAt(ms: number, tz: string): number {
  const w = wallAt(ms, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant of a wall-clock time in `tz`. Fall-back hour (it happens twice): the FIRST one.
 * Spring-forward gap (it never happens): moved forward by the gap (2:30 -> 3:30).
 */
export function zonedToUtc(w: Wall, tz: string): number {
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi)
  const candidates = new Set<number>()
  for (const probe of [asUtc - 14 * 3600_000, asUtc, asUtc + 14 * 3600_000]) candidates.add(asUtc - offsetAt(probe, tz))
  const exact = [...candidates].filter((ms) => {
    const back = wallAt(ms, tz)
    return back.y === w.y && back.m === w.m && back.d === w.d && back.h === w.h && back.mi === w.mi
  }).sort((a, b) => a - b)
  if (exact.length) return exact[0]
  // gap: use the offset from before the change, which lands after the gap
  return asUtc - offsetAt(asUtc - 14 * 3600_000, tz)
}

function addDays(w: Wall, n: number): Wall {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: w.h, mi: w.mi }
}
function weekdayOf(w: Wall): number {
  return new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()
}
function ymd(w: Wall): string {
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function isoWithOffset(ms: number, tz: string): string {
  const w = wallAt(ms, tz)
  const off = Math.round(offsetAt(ms, tz) / 60_000)
  const sign = off < 0 ? '-' : '+'
  const a = Math.abs(off)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${ymd(w)}T${pad(w.h)}:${pad(w.mi)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

// ---------- spoken forms ----------

export function spokenTime(h: number, mi: number): string {
  if (h === 12 && mi === 0) return 'noon'
  if (h === 0 && mi === 0) return 'midnight'
  const ap = h < 12 ? 'AM' : 'PM'
  const hh = h % 12 === 0 ? 12 : h % 12
  return mi === 0 ? `${hh} ${ap}` : `${hh}:${String(mi).padStart(2, '0')} ${ap}`
}
export function spokenDate(w: Wall, withYearIfNot?: number): string {
  const wd = WEEKDAYS[weekdayOf(w)]
  const base = `${wd[0].toUpperCase()}${wd.slice(1)}, ${MONTHS[w.m - 1][0].toUpperCase()}${MONTHS[w.m - 1].slice(1)} ${w.d}`
  return withYearIfNot !== undefined && w.y !== withYearIfNot ? `${base}, ${w.y}` : base
}

/** "UTC", "Los Angeles", "Kolkata": a zone as people say it. */
export function zoneCity(tz: string): string {
  if (/^(?:etc\/)?(?:utc|gmt|uct|universal|zulu|greenwich)(?:[+-]0)?$/i.test(tz)) return 'UTC'
  if (/^etc\//i.test(tz)) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value ?? tz
    } catch {
      return tz
    }
  }
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ')
}

/** "4 PM UTC" / "4 PM Los Angeles time". */
function timeIn(h: number, mi: number, tz: string): string {
  const city = zoneCity(tz)
  return `${spokenTime(h, mi)} ${/^(?:UTC|GMT[+-]?\d*)$/.test(city) ? city : `${city} time`}`
}

/**
 * When the device's zone (the one the event is written in) is not the Google Calendar's own zone at that moment:
 * "That is 4 PM UTC, which is 11 AM in your Google Calendar's time zone, New York." Same offset (or unknown): ''.
 */
export function zoneNote(p: { allDay?: unknown; start?: unknown; timeZone?: unknown }, calendarTz?: string): string {
  if (!calendarTz || p.allDay || typeof p.start !== 'string' || typeof p.timeZone !== 'string') return ''
  if (!validZone(calendarTz) || !validZone(p.timeZone)) return ''
  const s = Date.parse(p.start)
  if (Number.isNaN(s) || offsetAt(s, p.timeZone) === offsetAt(s, calendarTz)) return ''
  const a = wallAt(s, p.timeZone)
  const b = wallAt(s, calendarTz)
  const day = a.d !== b.d ? ` on ${spokenDate(b).split(',')[0]}` : ''
  return `That is ${timeIn(a.h, a.mi, p.timeZone)}, which is ${spokenTime(b.h, b.mi)}${day} in your Google Calendar's time zone, ${zoneCity(calendarTz)}.`
}

// ---------- parsing ----------

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[‐-―]/g, '-')
    .replace(/\b(a\.m\.|a\.m|am)\b/g, 'am')
    .replace(/\b(p\.m\.|p\.m|pm)\b/g, 'pm')
    .replace(/(\d)\s*(am|pm)\b/g, '$1 $2')
    .replace(/[,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function num(tok: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(tok)) return Number(tok)
  return NUMBER_WORDS[tok]
}

interface DatePick { wall: Wall; explicit: 'today' | 'tomorrow' | 'weekday' | 'date' | 'relative' | 'none'; label?: string }

/** Finds the day part. Returns the remaining text too (so "at 3" etc. can be read from it). */
function pickDate(s: string, nowWall: Wall & { s: number }, assumed: string[]): DatePick | null {
  const today: Wall = { y: nowWall.y, m: nowWall.m, d: nowWall.d, h: 0, mi: 0 }
  let m: RegExpMatchArray | null
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) return { wall: today, explicit: 'today' }
  if (/\bday after tomorrow\b/.test(s)) return { wall: addDays(today, 2), explicit: 'tomorrow' }
  if (/\b(tomorrow|tmrw|tmr)\b/.test(s)) {
    // said between midnight and 4 AM, "tomorrow" means the coming daytime (today's date); the read-back says the date
    if (nowWall.h < 4) {
      assumed.push('late-night tomorrow')
      return { wall: today, explicit: 'tomorrow' }
    }
    return { wall: addDays(today, 1), explicit: 'tomorrow' }
  }
  if ((m = s.match(/\bin (\d+|a|an|one|two|three|four|five|six|seven|ten) (day|days|week|weeks)\b/))) {
    const n = num(m[1]) ?? 1
    return { wall: addDays(today, m[2].startsWith('week') ? n * 7 : n), explicit: 'relative' }
  }
  if ((m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
    return { wall: { y: +m[1], m: +m[2], d: +m[3], h: 0, mi: 0 }, explicit: 'date' }
  }
  if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : nowWall.y
    let w: Wall = { y, m: +m[1], d: +m[2], h: 0, mi: 0 }
    if (!m[3] && ymd(w) < ymd(today)) w = { ...w, y: y + 1 }
    return { wall: w, explicit: 'date' }
  }
  const monthRe = MONTHS.map((x) => `${x}|${x.slice(0, 3)}${x === 'september' ? '|sept' : ''}`).join('|')
  if ((m = s.match(new RegExp(`\\b(${monthRe})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?\\b`))) ||
      (m = s.match(new RegExp(`\\b(?:the )?(\\d{1,2})(?:st|nd|rd|th)? of (${monthRe})(?: (\\d{4}))?\\b`)))) {
    const monthTok = isNaN(Number(m[1])) ? m[1] : m[2]
    const dayTok = isNaN(Number(m[1])) ? m[2] : m[1]
    const mi = MONTHS.findIndex((x) => x.startsWith(monthTok.slice(0, 3))) + 1
    let w: Wall = { y: m[3] ? +m[3] : nowWall.y, m: mi, d: +dayTok, h: 0, mi: 0 }
    if (!m[3] && ymd(w) < ymd(today)) w = { ...w, y: w.y + 1 }
    return { wall: w, explicit: 'date' }
  }
  if ((m = s.match(/\bon the (\d{1,2})(?:st|nd|rd|th)\b/))) {
    let w: Wall = { y: nowWall.y, m: nowWall.m, d: +m[1], h: 0, mi: 0 }
    if (w.d < nowWall.d) w = nowWall.m === 12 ? { ...w, y: w.y + 1, m: 1 } : { ...w, m: w.m + 1 }
    return { wall: w, explicit: 'date' }
  }
  const wdRe = WEEKDAYS.map((x) => `${x}|${x.slice(0, 3)}${x === 'tuesday' ? '|tues' : ''}${x === 'thursday' ? '|thurs' : ''}`).join('|')
  if ((m = s.match(new RegExp(`\\b(next|this|coming|on)? ?(${wdRe})\\b`)))) {
    const target = WEEKDAYS.findIndex((x) => x.startsWith(m![2].slice(0, 3)))
    const todayWd = weekdayOf(today)
    let delta = (target - todayWd + 7) % 7
    const qual = m[1]
    if (qual === 'this') {
      // "this Tuesday" said on Tuesday = today
    } else if (delta === 0) {
      delta = 7
    }
    if (qual === 'next') {
      // "next Friday" = Friday of next week (weeks start on Sunday): if the coming one is still this week, skip it
      const comingInThisWeek = todayWd + delta <= 6
      if (comingInThisWeek) delta += 7
      assumed.push('next weekday = next week')
    }
    return { wall: addDays(today, delta), explicit: 'weekday' }
  }
  return null
}

interface TimePick { h: number; mi: number; meridiem: boolean }

function parseClock(tok: string, ap?: string): TimePick | null {
  let m = tok.match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (!m) {
    const n = num(tok)
    if (n === undefined || n !== Math.floor(n)) return null
    m = [tok, String(n)] as unknown as RegExpMatchArray
  }
  let h = Number(m[1])
  const mi = m[2] ? Number(m[2]) : 0
  if (h > 23 || mi > 59) return null
  if (ap) {
    if (h < 1 || h > 12) return null
    if (ap === 'am') h = h === 12 ? 0 : h
    else h = h === 12 ? 12 : h + 12
    return { h, mi, meridiem: true }
  }
  return { h, mi, meridiem: h === 0 || h > 12 || (m[1].length === 2 && m[1].startsWith('0')) }
}

/** No AM/PM said: 1-6 -> PM, 7-11 -> AM, 12 -> noon. Daypart words win ("3 in the morning"). */
function settleMeridiem(t: TimePick, s: string, assumed: string[]): TimePick {
  if (t.meridiem) return t
  if (/\bmorning\b/.test(s)) return { ...t, h: t.h === 12 ? 0 : t.h, meridiem: true }
  if (/\b(afternoon|evening|tonight|at night)\b/.test(s)) {
    return { ...t, h: t.h < 12 ? t.h + 12 : t.h, meridiem: true }
  }
  if (t.h >= 1 && t.h <= 6) {
    assumed.push(`${t.h} as ${t.h} PM`)
    return { ...t, h: t.h + 12, meridiem: true }
  }
  if (t.h >= 7 && t.h <= 11) assumed.push(`${t.h} as ${t.h} AM`)
  return { ...t, meridiem: true }
}

function pickTimes(s: string, assumed: string[]): { start?: TimePick; end?: TimePick; durationMin?: number; midnight?: boolean } {
  const out: { start?: TimePick; end?: TimePick; durationMin?: number; midnight?: boolean } = {}
  let m: RegExpMatchArray | null
  const clock = '(\\d{1,2}(?::\\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'
  // ranges: "from 3 to 4:30 pm", "3-4pm", "between 2 and 3"
  if ((m = s.match(new RegExp(`\\b(?:from |between )?${clock}(?: (am|pm))? ?(?:-|to|until|till|and) ?${clock}(?: (am|pm))?\\b`))) &&
      (/\b(from|between)\b/.test(s) || m[2] || m[4] || /-/.test(m[0]))) {
    const endAp = m[4]
    const startAp = m[2] ?? (endAp && !m[2] ? undefined : undefined)
    let a = parseClock(m[1], startAp)
    let b = parseClock(m[3], endAp)
    if (a && b) {
      if (!a.meridiem && b.meridiem) {
        // "3-4 pm": the start takes the end's meridiem when that keeps the start before the end
        const sameAp = parseClock(m[1], endAp)
        a = sameAp && sameAp.h * 60 + sameAp.mi < b.h * 60 + b.mi ? sameAp : parseClock(m[1], endAp === 'pm' ? 'am' : 'pm')
      }
      if (a) {
        a = settleMeridiem(a, s, assumed)
        if (!b.meridiem) {
          // end without meridiem: the first such time after the start (within 12 h)
          let h = b.h
          while (h * 60 + b.mi <= a.h * 60 + a.mi && h < 24) h += 12
          b = { h: h % 24, mi: b.mi, meridiem: true }
        }
        out.start = a
        out.end = b
        return out
      }
    }
  }
  if (/\bmidnight\b/.test(s)) {
    out.start = { h: 0, mi: 0, meridiem: true }
    out.midnight = true
  } else if (/\b(noon|midday|lunchtime)\b/.test(s)) {
    out.start = { h: 12, mi: 0, meridiem: true }
  } else if ((m = s.match(/\b(half past|quarter past|quarter to) (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: (am|pm))?\b/))) {
    const base = parseClock(m[2], m[3])
    if (base) {
      let { h } = base
      let mi = m[1] === 'half past' ? 30 : m[1] === 'quarter past' ? 15 : 45
      if (m[1] === 'quarter to') h = (h + 23) % 24
      if (m[1] === 'quarter to' && !base.meridiem && h === 0) h = 12
      out.start = settleMeridiem({ h, mi, meridiem: base.meridiem }, s, assumed)
      mi = 0
    }
  } else if ((m = s.match(new RegExp(`\\b(?:at |@ ?)${clock}(?: (am|pm))?(?: o'?clock)?\\b`))) ||
             (m = s.match(/\b(\d{1,2}(?::\d{2})?) (am|pm)\b/)) ||
             (m = s.match(/\b(\d{1,2}:\d{2})\b/))) {
    const t = parseClock(m[1], m[2])
    if (t) out.start = settleMeridiem(t, s, assumed)
  } else if (/\bmorning\b/.test(s)) {
    out.start = { h: 9, mi: 0, meridiem: true }
    assumed.push('morning as 9 AM')
  } else if (/\bafternoon\b/.test(s)) {
    out.start = { h: 14, mi: 0, meridiem: true }
    assumed.push('afternoon as 2 PM')
  } else if (/\b(evening|tonight)\b/.test(s)) {
    out.start = { h: 19, mi: 0, meridiem: true }
    assumed.push('evening as 7 PM')
  }
  if ((m = s.match(/\bfor (\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|half an?|ten|fifteen|twenty|thirty|forty-five|forty) (minutes?|mins?|hours?|hrs?)\b/))) {
    const n = m[1].startsWith('half') ? 0.5 : num(m[1]) ?? 1
    out.durationMin = Math.round(m[2].startsWith('h') ? n * 60 : n)
  } else if (/\bfor (an hour and a half|one and a half hours|1\.5 hours)\b/.test(s)) {
    out.durationMin = 90
  } else if ((m = s.match(new RegExp(`\\b(?:until|till|to) ${clock}(?: (am|pm))?\\b`))) && out.start && !out.end) {
    const b = parseClock(m[1], m[2])
    if (b) {
      let h = b.h
      if (!b.meridiem) while (h * 60 + b.mi <= out.start.h * 60 + out.start.mi && h < 24) h += 12
      out.end = { h: h % 24, mi: b.mi, meridiem: true }
    }
  }
  return out
}

function pickZone(s: string): { tz?: string; label?: string } {
  for (const [k, tz] of Object.entries(ZONES)) {
    if (new RegExp(`\\b${k}\\b(?: time)?`).test(s) && (k.includes(' ') || /\d ?(am|pm)? ?/.test(s))) {
      // "central" etc. only count after a time ("3 PM central"), not "central park"
      if (!k.includes(' ') && !new RegExp(`(\\d|am|pm|noon|o'?clock) (${k})\\b`).test(s)) continue
      return { tz, label: k.length <= 3 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1) }
    }
  }
  return {}
}

/**
 * Resolve an event time. `phrase` is the listener's words (or a model's when-string). Never guesses silently:
 * every assumption is listed in `assumed` and the spoken form has the exact date.
 */
export function resolveWhen(phrase: string, ctx: WhenContext, opts: { defaultMinutes?: number } = {}): WhenResult {
  const tz = ctx.tz
  if (!validZone(tz)) return { ok: false, reason: 'bad_zone', message: 'I do not know your time zone yet.' }
  const s = norm(phrase)
  const assumed: string[] = []
  const nowMs = ctx.now.getTime()
  const nowWall = wallAt(nowMs, tz)
  const zone = pickZone(s)
  const evTz = zone.tz ?? tz
  const date = pickDate(s, zone.tz ? wallAt(nowMs, evTz) : nowWall, assumed)
  // dates out of the way first so "2026-11-20" or "11/20" are never read as a time range
  const times = pickTimes(s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' '), assumed)
  const allDayWord = /\b(all day|all-day|whole day)\b/.test(s)
  const multiDay = s.match(/\bfor (\d+|two|three|four|five|six|seven|ten|fourteen|a) (days|day|weeks|week)\b/)

  if (/\b(yesterday|last (sun|mon|tue|wed|thu|fri|sat)[a-z]*|last week|last month|ago)\b/.test(s)) {
    return { ok: false, reason: 'past', message: 'That day has already passed.' }
  }
  if (!date && !times.start) return { ok: false, reason: 'not_understood', message: 'I did not catch the day or time.' }

  // all-day: a day with no time, or "all day"
  if (date && (!times.start || allDayWord)) {
    let days = 1
    if (multiDay) days = (num(multiDay[1]) ?? 1) * (multiDay[2].startsWith('week') ? 7 : 1)
    if (days > MAX_ALLDAY_DAYS) return { ok: false, reason: 'too_long', message: `That is ${days} days long, which looks like a mistake.` }
    const startW = date.wall
    const endW = addDays(startW, days)
    const today = { y: nowWall.y, m: nowWall.m, d: nowWall.d, h: 0, mi: 0 }
    if (ymd(startW) < ymd(today)) return { ok: false, reason: 'past', message: `${spokenDate(startW, nowWall.y)} has already passed.` }
    const lastW = addDays(startW, days - 1)
    return {
      ok: true,
      when: {
        allDay: true, start: ymd(startW), end: ymd(endW), tz,
        startMs: zonedToUtc(startW, tz), endMs: zonedToUtc(endW, tz),
        spoken: days === 1 ? `${spokenDate(startW, nowWall.y)}, all day` : `${spokenDate(startW, nowWall.y)} to ${spokenDate(lastW, nowWall.y)}, all day`,
        assumed,
      },
    }
  }

  // timed
  const t = times.start!
  let dayW: Wall
  if (date) {
    dayW = date.wall
    // "Friday at midnight" = the midnight that ends Friday
    if (times.midnight) dayW = addDays(dayW, 1)
  } else {
    const base = zone.tz ? wallAt(nowMs, evTz) : nowWall
    dayW = { y: base.y, m: base.m, d: base.d, h: 0, mi: 0 }
    if (times.midnight) dayW = addDays(dayW, 1)
    // just a time and it already passed today: the next one (said out loud in the read-back)
    else if (zonedToUtc({ ...dayW, h: t.h, mi: t.mi }, evTz) < nowMs - PAST_GRACE_MS) {
      dayW = addDays(dayW, 1)
      assumed.push('time passed today, so tomorrow')
    }
  }
  const startMs = zonedToUtc({ ...dayW, h: t.h, mi: t.mi }, evTz)
  let endMs: number
  if (times.end) {
    let endDay = dayW
    if (times.end.h * 60 + times.end.mi <= t.h * 60 + t.mi) {
      // "10 PM to 1 AM" runs past midnight; "4 PM until 2 PM" is a slip
      if (!(t.h >= 12 && times.end.h < 12)) return { ok: false, reason: 'end_before_start', message: 'The end time is before the start time.' }
      endDay = addDays(dayW, 1)
    }
    endMs = zonedToUtc({ ...endDay, h: times.end.h, mi: times.end.mi }, evTz)
  } else {
    const minutes = times.durationMin ?? opts.defaultMinutes ?? 60
    if (times.durationMin === undefined) assumed.push(`${minutes} minutes long`)
    endMs = startMs + minutes * 60_000
  }
  if (endMs <= startMs) return { ok: false, reason: 'end_before_start', message: 'The end time is before the start time.' }
  if (endMs - startMs > MAX_TIMED_MS) return { ok: false, reason: 'too_long', message: 'That is longer than a day, which looks like a mistake.' }
  if (startMs < nowMs - PAST_GRACE_MS) return { ok: false, reason: 'past', message: 'That time has already passed.' }

  const sW = wallAt(startMs, tz)
  const eW = wallAt(endMs, tz)
  const sameDay = sW.y === eW.y && sW.m === eW.m && sW.d === eW.d
  let spoken = sameDay
    ? `${spokenDate(sW, nowWall.y)}, from ${spokenTime(sW.h, sW.mi)} to ${spokenTime(eW.h, eW.mi)}`
    : `${spokenDate(sW, nowWall.y)} at ${spokenTime(sW.h, sW.mi)} until ${spokenDate(eW, nowWall.y)} at ${spokenTime(eW.h, eW.mi)}`
  if (zone.tz && zone.tz !== tz) {
    const zW = wallAt(startMs, zone.tz)
    spoken += ` your time (${spokenTime(zW.h, zW.mi)} ${zone.label})`
  }
  return {
    ok: true,
    when: { allDay: false, start: isoWithOffset(startMs, tz), end: isoWithOffset(endMs, tz), startMs, endMs, tz, spoken, assumed },
  }
}

/** A due DATE for tasks and Your list ("this month", "by Friday", "next week", "tomorrow"). */
export function resolveDue(phrase: string, ctx: WhenContext): DueResult | null {
  if (!validZone(ctx.tz)) return null
  const s = norm(phrase)
  const nowWall = wallAt(ctx.now.getTime(), ctx.tz)
  const today: Wall = { y: nowWall.y, m: nowWall.m, d: nowWall.d, h: 0, mi: 0 }
  const make = (w: Wall, spoken?: string): DueResult => ({ date: ymd(w), spoken: spoken ?? spokenDate(w, nowWall.y) })
  if (/\b(this month|end of (the )?month|by the end of the month)\b/.test(s)) {
    const w = { ...today, d: lastDayOfMonth(today.y, today.m) }
    return make(w, `by the end of ${MONTHS[w.m - 1][0].toUpperCase()}${MONTHS[w.m - 1].slice(1)} (${spokenDate(w, nowWall.y)})`)
  }
  if (/\bnext month\b/.test(s)) {
    const y = today.m === 12 ? today.y + 1 : today.y
    const m = today.m === 12 ? 1 : today.m + 1
    const w = { y, m, d: lastDayOfMonth(y, m), h: 0, mi: 0 }
    return make(w, `by the end of ${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} (${spokenDate(w, nowWall.y)})`)
  }
  if (/\b(this week|end of (the )?week|by the end of the week)\b/.test(s)) {
    const wd = weekdayOf(today)
    const w = addDays(today, wd <= 5 ? 5 - wd : 6)
    return make(w, `by the end of the week (${spokenDate(w, nowWall.y)})`)
  }
  if (/\bnext week\b/.test(s) && !/\b(sun|mon|tue|wed|thu|fri|sat)/.test(s)) {
    const wd = weekdayOf(today)
    const w = addDays(today, 7 - wd + 5)
    return make(w, `next week (${spokenDate(w, nowWall.y)})`)
  }
  if (/\b(this weekend|the weekend)\b/.test(s)) {
    const wd = weekdayOf(today)
    const w = addDays(today, wd === 6 ? 0 : wd === 0 ? 0 : 6 - wd)
    return make(w)
  }
  if (/\b(this year|end of (the )?year)\b/.test(s)) return make({ ...today, m: 12, d: 31 })
  const assumed: string[] = []
  const d = pickDate(s, nowWall, assumed)
  if (!d) return null
  if (ymd(d.wall) < ymd(today)) return null
  return make(d.wall)
}
