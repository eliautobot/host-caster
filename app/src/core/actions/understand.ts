// The listener's own words about invitations, read by code (Rule 1: an email or an invite title can never answer
// for them): the answer they said, and the invitations they could be answering. The hosts' agent tools use these
// (agent/kit/sources/outside.ts).
import type { CalendarEvent } from '../types'
import type { RsvpAnswer } from './types'

export interface InviteChoice {
  /** "calId:eventId" (as CalendarEvent.id) */
  id: string
  title: string
  organizer?: string
  start: number
  allDay?: boolean
  myResponse?: string
}

/** The answer the listener said, read by code ("accept" -> accepted, "I can't make it" -> declined). */
export function answerFromWords(said: string): RsvpAnswer | undefined {
  const s = said.toLowerCase()
  if (/\b(maybe|tentative|tentatively|might (go|make it|come)|not sure)\b/.test(s)) return 'tentative'
  if (/\b(decline|can'?t (go|make|come|attend)|cannot (go|make|come|attend)|won'?t (go|make|be)|not going|say no|turn (it )?down|reject)\b/.test(s)) return 'declined'
  if (/\b(accept|yes to|say yes|i'?ll (go|be there|come|attend)|i'?m going|going to (go|attend)|count me in|attend)\b/.test(s)) return 'accepted'
  return undefined
}

/** Invitations the listener can answer: they are a guest (not the organizer), it has not ended. */
export function inviteChoices(events: CalendarEvent[], now = Date.now()): InviteChoice[] {
  return events
    .filter((e) => e.source === 'google' && !e.organizerSelf && (e.attendees?.some((a) => a.self) || e.myResponse) && (e.end ?? e.start) > now)
    .map((e) => ({ id: e.id, title: e.title, organizer: e.organizer, start: e.start, allDay: e.allDay, myResponse: e.myResponse }))
}
