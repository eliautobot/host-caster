// Gmail's "Invitation from an unknown sender: ...": Google holds an invitation from someone the listener has never
// dealt with. The event is NOT on the calendar until the listener answers in the email itself, so the hosts can not
// answer it (and never do it another way: no reply by email, no importing the event). It stays a careful Your list
// item, and a call-in about it gets the real reason.
import { lemmas } from './commands'
import { caution, speakable } from './safety'
import type { CalendarEvent, EmailSummary } from '../types'

export interface HeldInvite {
  mailId: string
  /** the sender as the hosts may say it ("someone" when the name itself looks hostile) */
  sender: string
  /** the event title from the subject (outside content: used to match words, said only when safe) */
  title?: string
  address?: string
}

export const HELD_ITEM = 'Invitation from someone new: answer it in the email'
export const HELD_WHY = 'Google holds invitations from new senders: it is not in your calendar until you answer in the email'

const UNKNOWN = /^\s*invitation from an unknown sender\b/i

function senderOf(m: EmailSummary): string {
  const raw = m.from.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim()
  if (!raw || /@/.test(raw)) return 'someone new'
  return caution(raw).careful ? 'someone new' : speakable(raw, 40) || 'someone new'
}

const sameWords = (a: string, b: string) => {
  const x = [...new Set(lemmas(a))]
  const y = new Set(lemmas(b))
  return x.length > 0 && x.every((w) => y.has(w))
}

/** The invitation this mail holds when Google keeps it out of the calendar (unknown sender, no event yet). */
export function heldInvite(m: EmailSummary, calendar: CalendarEvent[] = []): HeldInvite | undefined {
  if (!m.invite || (m.invite.method && m.invite.method !== 'request')) return undefined
  if (!m.invite.unknownSender && !UNKNOWN.test(m.subject)) return undefined
  const title = m.invite.title?.trim() || m.subject.replace(UNKNOWN, '').replace(/^\s*:\s*/, '').replace(/\s+@\s+.*$/, '').trim() || undefined
  // answered in the email already: Google put the event on the calendar, the normal invitation path takes over
  const eventId = m.invite.eventId
  if (calendar.some((e) => (eventId && e.id.endsWith(`:${eventId}`)) || (title && sameWords(title, e.title) && sameWords(e.title, title)))) return undefined
  return { mailId: m.id, sender: senderOf(m), ...(title ? { title } : {}), ...(m.address ? { address: m.address.toLowerCase() } : {}) }
}

const META = new Set(lemmas('accept accepted decline declined invite invitation invited rsvp respond answer reply meeting event yes no maybe going attend please the that this from new unknown sender'))

/**
 * Which held invitation a call-in's words point at: a title word or the sender's first name, one clear winner
 * (`byWords`), or "that invitation" when only one is held.
 */
export function pickHeld(said: string, held: HeldInvite[]): { held: HeldInvite; byWords: boolean } | undefined {
  if (!held.length) return undefined
  const words = new Set(lemmas(said))
  const lower = said.toLowerCase()
  // numbers count too ("HC RSVP test 2" next to "HC RSVP test"): lemmas drop one-character words
  const numbers = (s: string) => new Set(s.match(/\b\d+\b/g) ?? [])
  const saidNumbers = numbers(said)
  const scored = held
    .map((h) => {
      const first = h.sender.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '')
      const nameHit = first && first.length > 1 && first !== 'someone' && new RegExp(`\\b${first}(?:'s)?\\b`).test(lower) ? 1.5 : 0
      const titleHit = [...new Set(lemmas(h.title ?? ''))].filter((w) => words.has(w) && !META.has(w)).length
      const numberHit = [...numbers(h.title ?? '')].filter((n) => saidNumbers.has(n)).length
      return { h, score: nameHit + titleHit + numberHit }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return { held: scored[0].h, byWords: true }
  // a tie between invitations from the same sender: the line names only the sender, so it is true for either
  const top = scored.filter((x) => x.score === scored[0]?.score)
  if (top.length > 1 && top.every((x) => x.h.sender === top[0].h.sender && x.h.sender !== 'someone new')) return { held: top[0].h, byWords: true }
  // "accept that invitation" with only one held
  return !scored.length && held.length === 1 && /\b(?:the|that|this|my|new) (?:invite|invitation)\b/.test(lower) ? { held: held[0], byWords: false } : undefined
}

/** What the hosts say about it: the real reason, and where to answer. */
export function heldLine(h: HeldInvite): string {
  const who = h.sender === 'someone new' ? 'someone new' : h.sender
  return `That invitation from ${who} isn't in your calendar yet, because Google holds invitations from new senders. Open the email to answer it.`
}
