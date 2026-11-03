// A question is never an order (pure). The scripted fallback (no AI brain) reads plain commands with patterns; this
// keeps it from acting on "Can you add things to my Google Tasks?" (a question about what it can do, not an item
// called "Things") or "What should I add?". With an AI brain the model decides, with the same rule in its prompt.

const WH = /^(?:what|which|who|whom|whose|when|where|why|how)\b/;
const AUX = /^(?:do|does|did|is|are|am|was|were|have|has|had|should|shall|may|might)\s+(?:you|u|i|we|they|it|there|my|your|the|that|this)\b/;
const POLITE = /^(?:can|could|would|will)\s+(?:you|u|the hosts|y'?all)\b/;
const ABILITY = /\b(?:able to|know how to|allowed to|have access to|is it possible|are you capable|how do i|how can i)\b/;
/** words that name a kind of thing, not a thing: "add things", "remember stuff", "play songs" */
const GENERIC =
  /^(?:(?:a|an|some|any|my|more|other|new)\s+)?(?:things?|stuff|something|anything|everything|items?|tasks?|to-?dos?|events?|appointments?|reminders?|notes?|songs?|music|tracks?|it|that|this|them|those|these|ones?|more|whatever|what i (?:say|tell you))$/;

const tidy = (s: string) =>
  s
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[’]/g, "'")
    .replace(/^(?:(?:hey|hi|so|ok|okay|um|uh|well|and|also|oh)[,!\s]+)+/, '')
    .replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * True when the words ask something rather than order it: a WH-question, a yes/no question ("do you add tasks?"),
 * an ability question ("are you able to ..."), or a polite "can you ..." whose object is only a kind of thing
 * (`object`: what a command would have added or played). "Can you add milk to my list?" stays an order.
 */
export function isQuestionNotOrder(said: string, object?: string): boolean {
  const s = tidy(said);
  if (!s) return false;
  if (WH.test(s) || AUX.test(s) || ABILITY.test(s)) return true;
  if (POLITE.test(s) && object !== undefined && GENERIC.test(tidy(object))) return true;
  return false;
}
