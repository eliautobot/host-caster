// Titles the hosts write in other accounts and on Your list: the listener's words, with the day and time words gone
// (code resolves those) and no word left dangling, and grounded in what the listener said (Rule 1: a title from an
// email, an invite or a web page is refused). Used by the hosts' tools (agent/kit).
import { contentWords } from '../memory/text'
import { lemmas } from '../tracker/commands'
import { speakable } from '../tracker/safety'

/** words for a kind of thing, never the thing: "Task unspecified" or "New event" is not the listener's title */
const KIND = new Set(lemmas('task tasks thing things item items stuff something anything event events reminder reminders note notes todo todos list lists google calendar meeting appointment new add put want need please make create remind remember'))

/** "can you ...", "could you ...", "are you ...": words that ask the hosts something */
const ASKS_HOSTS = /^(?:can|could|would|will|do|does|did|are|is|should|shall|may|might)\s+(?:you|u|the hosts|y'?all)\b/i

function grounded(text: string, said: string, min = 0.5): boolean {
  const want = [...new Set(lemmas(text))].filter((w) => !KIND.has(w))
  if (!want.length) return false
  const have = new Set(lemmas(said))
  return want.filter((w) => have.has(w)).length / want.length >= min
}

const WD = '(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?'
const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const CLOCK = '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?'
const WHEN_WORDS = new RegExp(
  [
    // the longer phrases first: at one spot the first alternative that fits wins
    `\\bfirst thing(?: in the morning)?\\b`,
    `\\b(?:tomorrow|tonight|today|this|in the) (?:morning|afternoon|evening|night)\\b`,
    `\\b(?:the )?end of (?:the |this |next )?(?:day|week|month|year)\\b`,
    `\\b(?:this|next|coming|this coming) (?:week|weekend|month|year)\\b`,
    `\\b\\d{4}-\\d{2}-\\d{2}\\b`,
    `\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b`,
    `\\b(?:on |this |next |coming )?${WD}\\b`,
    `\\b(?:today|tonight|tomorrow|day after tomorrow)\\b`,
    `\\b(?:at|from|until|till|to|by|around|@) ?(?:${CLOCK}(?![/\\d])|noon|midnight)\\b`,
    `\\b${CLOCK} ?(?:-|to) ?${CLOCK}`,
    `\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b`,
    `\\b(?:on )?${MON} \\d{1,2}(?:st|nd|rd|th)?\\b`,
    `\\bfor (?:an? |\\d+ |half an )?(?:hour|hours|minutes|mins)\\b`,
    `\\b(?:all day|noon|midnight)\\b`,
    `\\bin (?:a|an|one|two|three|four|five|a couple of|a few|\\d+) (?:days?|weeks?|months?|hours?|minutes?)\\b`,
    `\\b(?:the )?\\d{1,2}(?:st|nd|rd|th)(?: of ${MON})?(?!\\s+(?:floor|street|avenue|grade|anniversary|birthday|place|row|period|round|edition|time|century)\\b)`,
    `\\b(?:eod|end of day|asap)\\b`,
  ].join('|'),
  'gi',
)

// words that only joined the title to the day or time ("Test the tasks by Friday" -> "Test the tasks by")
const JOINER = 'by|on|at|for|due|before|until|till|this|next|the|to|from|around|about|in|of|and|or|starting|coming|sometime|anytime|every'
const JOINER_BEFORE = new RegExp(`(?:[\\s,]+(?:${JOINER}))+[\\s,]*\\u0000(?=[\\s,.;:!?\\u0000]*$)`, 'gi')
// never the last or first word of a title, wherever it came from ("in" / "on" can end one: "Log in", "Turn the lights on")
const NEVER_ENDS = /(?:[\s,]+(?:by|at|for|due|before|until|till|this|next|the|to|from|around|about|of|and|or|starting|coming))+$/i
const NEVER_STARTS = /^(?:(?:by|at|for|due|before|until|till|this|next|the|to|from|around|about|of|and|or|on|in)\s+)+/i

/** A title with the day and time words gone and no word left dangling where they were. */
export function titleWithoutWhen(text: string): string {
  let t = ` ${text} `.replace(WHEN_WORDS, '\u0000')
  for (let i = 0; i < 3; i++) t = t.replace(JOINER_BEFORE, '\u0000')
  return t
    .replace(/\u0000/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?-])(?:\s*[,.;:!?-])+/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '')
    .replace(NEVER_ENDS, '')
    .replace(NEVER_STARTS, '')
    .replace(/[\s,.;:!?-]+$/, '')
    .trim()
}

/** The title an action gets: the listener's words, no "to my calendar", no day or time, grounded in what they said. */
export function cleanTitle(t: unknown, said: string, kind: 'event' | 'task' = 'event'): string | undefined {
  if (typeof t !== 'string') return undefined
  // "Book the dentist" is an event called Dentist; "Book flights" is a task to do
  const verb = kind === 'event' ? /^(?:add|put|schedule|book|create|make)\s+/i : /^(?:add|put)\s+/i
  const title = titleWithoutWhen(
    speakable(t.replace(/\b(to|on|in|into) (my|the|your) (google )?(calendar|tasks?|task list|list)\b/gi, ''), 120)
      .replace(verb, '')
      // "a Google task to test the tasks" -> "test the tasks"
      .replace(/^(?:an?\s+)?(?:new\s+)?(?:google\s+)?(?:task|reminder|event)\s+(?:to|for|called|named|saying|:)\s*/i, ''),
  )
  if (!title || !contentWords(title).length) return undefined
  // a question to the hosts is never the title of a thing to do ("Can you add tasks now")
  if (ASKS_HOSTS.test(title) || /\?\s*$/.test(t)) return undefined
  return grounded(title, said) ? title[0].toUpperCase() + title.slice(1) : undefined
}
