// The listener's own words about Your list, read by code (works with every brain, the scripted fallback too):
// "remind me to renew my license this month", "add oat milk to Your list", "I sent the quotes", "the bill is paid".
import { isQuestionNotOrder } from '../agent/question'
import { contentWords, toSecondPerson } from '../memory/text'
import { resolveDue, resolveWhen, type WhenContext } from '../actions/when'
import type { TrackedItem, TrackedKind } from '../types'

export type TrackerCommand =
  | { op: 'add'; what: string; kind: TrackedKind; due?: string; dueAllDay?: boolean; remindAt?: number; spokenDue?: string; google?: boolean }
  | { op: 'done'; words: string }

// where the "when" part of "remind me to X <when>" starts
const WHEN_START =
  /\s+(?:(?:by|on|at|before|until|around|this|next|coming|in|tomorrow|today|tonight|the end of|end of|later today|first thing)\b|(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d)/i

const REMIND = /^(?:hey\s+)?(?:(?:please|can you|could you|would you|will you)\s+)?(?:set (?:a|me a) reminder to|remind me (?:to|that i (?:need|have) to|about)|don't let me forget to|make sure i)\s+(.+)$/i
const ADD_LIST = /^(?:(?:please|can you|could you)\s+)?(?:add|put|stick|write down)\s+(.+?)\s+(?:to|on|onto|in)\s+(?:my|the|your)\s+(list|to-?do list|tasks|google tasks|task list)\b(.*)$/i
const DONE_RES = [
  /^(?:ok(?:ay)?,?\s+|so,?\s+|well,?\s+|good news,?\s+)?(?:i|we)(?:'ve| have)?\s+(?:just\s+|already\s+|finally\s+|now\s+)?((?:sent|paid|finished|did|done|renewed|booked|called|emailed|submitted|returned|picked up|bought|replied to|answered|filed|scheduled|ordered|mailed|cancelled|canceled|fixed|signed|got|made|gave|wrote|dropped off|handed in|took care of|completed)\b.*)$/i,
  /^(?:(?:please|can you|could you)\s+)?(?:mark|tick|check|cross)\s+(?:off\s+)?(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|off))?(?:\s+(?:on|from)\s+my\s+list)?$/i,
  /^(?:i'?m |we'?re )?(?:all )?done with\s+(.+)$/i,
  /^(?:the\s+)?(.+?)\s+(?:is|are|got|has been|have been)\s+(?:done|finished|taken care of|sorted|handled|paid|sent|booked|renewed|submitted)\b/i,
]

const IRREGULAR: Record<string, string> = {
  sent: 'send', paid: 'pay', did: 'do', done: 'do', bought: 'buy', got: 'get', made: 'make', gave: 'give', wrote: 'write',
  took: 'take', brought: 'bring', told: 'tell', found: 'find', met: 'meet', spoke: 'speak', sold: 'sell', went: 'go',
}
const DONE_VERBS = new Set(['send', 'pay', 'do', 'finis', 'renew', 'book', 'call', 'email', 'submi', 'retur', 'pick', 'buy', 'reply', 'answe', 'file',
  'sched', 'order', 'mail', 'cance', 'fix', 'sign', 'get', 'make', 'give', 'write', 'drop', 'hand', 'take', 'care', 'compl', 'mark', 'tick', 'check', 'cross'])

/** Content words with irregular verbs mapped ("sent" -> "send"), stemmed like the memory text helpers. */
export function lemmas(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .map((w) => IRREGULAR[w] ?? w)
    .flatMap((w) => contentWords(w))
}

function kindOf(what: string): TrackedKind {
  if (/\b(pay|bill|invoice|rent|insurance|tax(es)?)\b/i.test(what)) return 'bill'
  if (/\b(renew|deadline|due|submit|file|register|apply)\b/i.test(what)) return 'deadline'
  return 'todo'
}

/** "Renew my license" -> "Renew your license" (the list talks to the listener). Capitalized, no end period. */
export function tidyWhat(text: string): string {
  const t = toSecondPerson(text.replace(/^(?:to|that i (?:need|have) to)\s+/i, '').replace(/[.!?\s]+$/, '').trim())
  return t ? t[0].toUpperCase() + t.slice(1) : t
}

/** Reads a Your list command, or undefined (not one). `ctx` gives the time zone for "this month" / "at 5". */
export function parseTrackerCommand(said: string, ctx: WhenContext): TrackerCommand | undefined {
  const s = said.trim().replace(/\s+/g, ' ')
  let m = s.match(REMIND)
  let google = false
  let rest: string | undefined
  if (!m) {
    const a = s.match(ADD_LIST)
    if (a && !/\bnotion\b/i.test(s)) {
      m = a
      google = /google|tasks/i.test(a[2])
      rest = a[3]
    }
  }
  if (m) {
    let body = m[1].trim()
    let whenPart = rest?.trim() ?? ''
    const cut = body.search(WHEN_START)
    if (cut > 2) {
      whenPart = `${body.slice(cut).trim()} ${whenPart}`.trim()
      body = body.slice(0, cut)
    }
    const what = tidyWhat(body)
    if (!what || contentWords(what).length === 0) return undefined
    // "can you add things to my Google Tasks?" is a question about what the hosts can do, not an item "Things"
    if (isQuestionNotOrder(s, what)) return undefined
    const out: TrackerCommand = { op: 'add', what, kind: kindOf(what), google }
    if (whenPart) {
      const timed = /\b(at|@)\s*\d|\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)|\bnoon\b|\bmidnight\b|\bin \d+ (minutes|hours)\b/i.test(whenPart)
      if (timed) {
        const w = resolveWhen(whenPart, ctx, { defaultMinutes: 15 })
        if (w.ok && !w.when.allDay) {
          out.remindAt = w.when.startMs
          out.due = w.when.start
          out.dueAllDay = false
          out.spokenDue = w.when.spoken.replace(/, from (.+?) to .+$/, ' at $1')
        }
      }
      if (!out.due) {
        const d = resolveDue(whenPart, ctx)
        if (d) {
          out.due = d.date
          out.dueAllDay = true
          out.spokenDue = d.spoken
        }
      }
    }
    return out
  }
  // "did I send the quotes?" asks; it does not tick anything off
  if (isQuestionNotOrder(s)) return undefined
  for (const re of DONE_RES) {
    const d = s.match(re)
    if (d && d[1] && d[1].length < 140) return { op: 'done', words: d[1] }
  }
  return undefined
}

export interface DoneMatch {
  item?: TrackedItem
  /** more than one item fits equally well: the hosts ask which one */
  ambiguous?: TrackedItem[]
}

/**
 * Which open item "I sent the quotes" closes: at least one shared word that is not the verb, and a clear winner.
 * Outside items flagged careful are never closed this way (they are not the listener's to-do).
 */
export function matchDone(words: string, items: TrackedItem[]): DoneMatch {
  const said = new Set(lemmas(words))
  const nouns = [...said].filter((w) => !DONE_VERBS.has(w))
  if (!nouns.length) return {}
  const scored = items
    .filter((i) => !i.flags?.careful)
    .map((i) => {
      const iw = new Set([...lemmas(i.what), ...(i.who ? lemmas(i.who) : [])])
      const hitNouns = nouns.filter((w) => iw.has(w)).length
      const hitAll = [...said].filter((w) => iw.has(w)).length
      return { i, hitNouns, score: hitAll / Math.max(1, Math.min(said.size, iw.size)) + hitNouns * 0.25 }
    })
    .filter((x) => x.hitNouns > 0 && x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
  if (!scored.length) return {}
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.05) return { ambiguous: scored.slice(0, 3).map((x) => x.i) }
  return { item: scored[0].i }
}

