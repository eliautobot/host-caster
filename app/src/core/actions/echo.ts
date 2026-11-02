// The read-back, the done line, "Okay, I will leave that alone": code writes them and the app says them last. A model
// that copies or rewords that line makes the listener hear it twice, and a model that cheers "you're all set" before
// the yes says something that has not happened. Both are dropped here, sentence by sentence, whatever the prompt did.
import { contentWords } from '../memory/text'
import type { ActionTurn } from './callin'

/** Lowercase words only: quotes, punctuation and spacing never hide a copy. */
export function plainWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”"«»]/g, ' ')
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
}

// what the code's line says, and the ways a model says the same thing: when the code's line matches `line`, a model
// sentence that matches `same` repeats it
const FAMILIES: Array<{ line: RegExp; same: RegExp }> = [
  { line: /\bjust to check\b|\bshould i go ahead\b|\byes or no\b/i, same: /\bjust to check\b|\bshould i go ahead\b|\byes or no\b/i },
  { line: /^done\b/i, same: /^\s*(?:okay,?\s*|ok,?\s*|alright,?\s*|all right,?\s*|and\s+)?(?:it'?s\s+|all\s+)?done\b|\bit'?s done\b|\ball done\b/i },
  { line: /\bon your google calendar\b/i, same: /\b(?:on|in|to|onto) your (?:google )?calendar\b/i },
  { line: /\bin (?:your )?google tasks\b/i, same: /\b(?:in|to|into) (?:your )?google tasks\b/i },
  { line: /\bmarked complete\b|\bmark it complete\b/i, same: /\bmark(?:ed)? (?:it |that )?(?:as )?(?:complete|completed|done)\b/i },
  { line: /\bleave that alone\b/i, same: /\bleave (?:that|it) (?:alone|be)\b|\bwon'?t (?:add|do|put|book|schedule|touch|mark|answer|send)\b|\bwill not\b|\bnot (?:adding|doing|putting|booking)\b|\bscrap(?:ped)? (?:that|it)\b|\bforget (?:it|that|about it)\b|\bnothing (?:was |is |has been |got )?(?:added|done|changed)\b|\bhold off\b|\bleft (?:it|that) alone\b/i },
  { line: /\badded to your list\b/i, same: /\b(?:added|put|popped|saved|noted|stuck)\b.*\b(?:your|the) list\b|\bon your list\b|\bto your list\b/i },
  { line: /\bkeep it on your list\b/i, same: /\b(?:keep|stays?|leave|left|still) (?:it )?on (?:your|the) list\b|\bstill open\b/i },
  { line: /\bticked off\b/i, same: /\b(?:ticked|checked|crossed|marked) (?:it |that )?off\b/i },
  { line: /\bi said you (?:are going|can not|might)\b/i, same: /\b(?:i|i'?ve)\s+(?:said|told (?:them|her|him)|let (?:them|her|him) know)\b|\byou'?re going\b|\b(?:accepted|declined)\b/i },
  { line: /\bdid not work\b|\bnothing changed\b|\btimed out\b/i, same: /\b(?:did not|didn'?t) (?:work|go through)\b|\bnothing changed\b|\btimed out\b|\bsomething went wrong\b/i },
  { line: /\bisn'?t in your calendar yet\b/i, same: /\b(?:can'?t|can not|cannot|unable to|not able to) (?:accept|answer|respond)\b|\binvitations? from (?:new|unknown) (?:senders?|people)\b|\bopen the email\b|\bnot (?:in|on) your calendar\b|\bgoogle holds\b/i },
  { line: /\bin settings\b/i, same: /\bsettings\b|\breconnect\b|\bpermission\b|\bturn on\b/i },
  { line: /\bstays with you\b|\bnot allowed\b/i, same: /\bnot allowed\b|\bcan'?t (?:help|do) (?:with )?that\b|\bstays with you\b/i },
]

// a model asking the same question again ("want me to add it?", "should I put it on?")
const ASKS_AGAIN = /\b(?:should|shall|can|may) i\b|\bwant me to\b|\bwould you like (?:me|it)\b|\bdo you want\b|\byes or no\b|\bgo ahead\b|\bconfirm\b|\bsound good\b|\bwhat (?:day|time)\b|\bwhich (?:one|invitation)\b/i

// saying or promising that it happened ("I've got you covered", "you're all set", "I'll pop that on your calendar")
const CLAIMS = new RegExp(
  [
    `\\b(?:i|we)(?:'ve| have)\\s+(?:just\\s+|already\\s+|now\\s+|gone ahead and\\s+)?(?:added|put|popped|scheduled|booked|set|created|marked|accepted|declined|ticked|sent|done|taken care|handled|sorted|locked|blocked|pencil+ed|answered|responded|rsvp'?d|saved|noted|made)\\b`,
    `\\bgot (?:you|that|it|this)(?: all)? (?:covered|sorted|handled|done|booked|down|in)\\b`,
    `\\b(?:you'?re|you are|we'?re|we are)\\s+(?:all\\s+)?(?:set|booked|sorted|good to go|in)\\b`,
    `\\ball set\\b`,
    `\\bconsider it done\\b`,
    `\\btaken care of\\b`,
    `\\bone less thing\\b`,
    `\\b(?:it|that|this)(?:'s| is| has been)\\s+(?:now\\s+)?(?:done|added|booked|scheduled|sorted|official|locked in|happening|on there|in there|taken care of|handled|confirmed|saved)\\b`,
    `\\b(?:it'?s|that'?s|is|are)\\s+(?:now\\s+|already\\s+)*(?:on|in)\\s+your\\s+(?:google\\s+)?(?:calendar|tasks|list)\\b`,
    `\\b(?:locked|penciled|pencilled|blocked) (?:it |that )?in\\b`,
    `\\bon the books\\b`,
    `\\bdone and dusted\\b`,
    `\\b(?:i'?ll|i will|let me|i'?m going to|i'?m gonna)\\s+(?:just\\s+|go ahead and\\s+)?(?:add|put|pop|get|schedule|book|set|take care|handle|make sure|pencil|block|mark|tick|send|let (?:them|her|him) know|tell|answer|accept|decline|save|note|create)\\b`,
    `\\bi'?m (?:adding|putting|popping|scheduling|booking|on it|taking care)\\b`,
    `\\b(?:it|that)'?ll be (?:on|in) your\\b`,
    `\\bwill be (?:on|in) your (?:google )?(?:calendar|tasks|list)\\b`,
    `\\bcoming right up\\b`,
    `\\bno need to worry about\\b`,
  ].join('|'),
  'i',
)

// "I can't accept it for you" right before the code asks "Should I go ahead?": a contradiction
const CANT = /\b(?:can'?t|cannot|can not|unable to|not able to|won'?t be able to)\b[^.!?]{0,30}\b(?:accept|answer|respond|decline|add|put|book|schedule|mark|tick|do that|do it|handle|help with)\b/i

/** Kinds where nothing was written to Google (yet): no model line may say or hint that it was. */
const NOTHING_HAPPENED = new Set<ActionTurn['kind']>(['asked', 'cancelled', 'failed', 'expired', 'refused', 'needs', 'problem', 'held'])

const straight = (text: string) => text.replace(/[’‘ʼ`´]/g, "'")

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+(?=["“'(]?[A-Z0-9])/).filter((s) => s.trim())
}

function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** True when this sentence says the code's line again: copied (with or without quotes) or reworded. */
export function repeatsLine(sentence: string, line: string): boolean {
  const s = plainWords(sentence)
  const l = plainWords(line)
  if (s.length >= 4 && containsRun(l, s)) return true
  if (l.length >= 4 && containsRun(s, l)) return true
  // a run of 6+ words straight from the line
  for (let i = 0; i + 6 <= s.length; i++) if (containsRun(l, s.slice(i, i + 6))) return true
  const sc = [...new Set(contentWords(sentence))]
  const lc = new Set(contentWords(line))
  if (sc.length >= 3 && sc.filter((w) => lc.has(w)).length / sc.length >= 0.6) return true
  return FAMILIES.some((f) => f.line.test(straight(line)) && f.same.test(straight(sentence)))
}

/** Why a model sentence can not stay next to the code's line, or undefined (it stays). */
export function dropReason(said: string, t: ActionTurn): 'repeat' | 'asks' | 'claims' | undefined {
  // models write curly apostrophes ("I’ve got you covered"): one form for every pattern below
  const sentence = straight(said)
  if (repeatsLine(sentence, straight(t.line))) return 'repeat'
  if (/\?|\byes or no\b/i.test(t.line) && /\?/.test(sentence) && ASKS_AGAIN.test(sentence)) return 'asks'
  if (t.kind === 'asked' && CANT.test(sentence)) return 'claims'
  if (NOTHING_HAPPENED.has(t.kind) && CLAIMS.test(sentence)) {
    // the listener's own list changed (an item added or ticked off) even when Google waits for a yes
    if (t.kind === 'asked' && t.item && /\b(?:your|the) list\b/i.test(sentence) && !/\bgoogle\b/i.test(sentence)) return 'repeat'
    return 'claims'
  }
  return undefined
}

/**
 * The model's lines before the code's line: sentences that repeat it, ask it again or claim what has not happened
 * are dropped; a line left empty is dropped. The code's line itself is added by the caller, once.
 */
export function linesAroundAction<L extends { text: string }>(lines: L[], t: ActionTurn): L[] {
  const out: L[] = []
  for (const l of lines) {
    if (l.text.trim() === t.line.trim()) continue
    const kept = sentences(l.text).filter((s) => !dropReason(s, t))
    const text = kept.join(' ').trim()
    if (text && /[a-z0-9]/i.test(text)) out.push(text === l.text ? l : { ...l, text })
  }
  return out
}
