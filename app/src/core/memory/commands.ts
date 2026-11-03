// "Remember that ..." and "forget that ..." from a call-in or the listener's AI app: honored right away (any brain,
// even the scripted one), so the hosts can confirm it on air in a few words.
import { isQuestionNotOrder } from '../agent/question';
import type { MemoryCard } from '../types';
import { addCard, allCards, deleteCards } from './store';
import { contentWords, guessKind, toSecondPerson, withAbsoluteDate } from './text';

export type MemoryCommand = { op: 'remember'; text: string } | { op: 'forget'; text: string } | { op: 'forget-all' };

export interface MemoryChange {
  op: 'remembered' | 'updated' | 'forgot' | 'refused' | 'notfound' | 'forget-all';
  /** the card's text (remembered / updated / forgot) or what was asked */
  text: string;
  cardId?: string;
  from: 'call' | 'app';
  /** refused: why ('secret': never kept; 'full'; 'empty') */
  problem?: string;
}

const LEAD = /^\s*(?:(?:hey|hi|ok|okay|so|and|oh|um|uh|well)\b[^,.!?]{0,24}[,.!]\s*)?(?:(?:please|hey)\s+)?(?:(?:can|could|would|will) you (?:please )?)?/i;
const REMEMBER = /^(?:remember|don'?t forget|do not forget|keep in mind|make a note|note down|take a note)\b(?:\s+(?:that|this|for me|:))*\s*[:,]?\s*(.+)$/i;
const FORGET = /^(?:forget|stop remembering|don'?t remember|unremember|delete the memory|remove the memory)\b(?:\s+(?:about|that|what i said about|the thing about))*\s*(.*)$/i;

/** The command in what the listener said, if it is one. */
export function parseMemoryCommand(said: string): MemoryCommand | undefined {
  const s = said.trim().replace(/[’]/g, "'").replace(LEAD, '');
  if (/^(do|did) you remember\b|^remember when\b|^remember (to|the time)\b/i.test(s)) return undefined;
  let m = s.match(REMEMBER);
  if (m) {
    const text = m[1]!.trim().replace(/[.!?\s]+$/, '').replace(/,? (please|thanks|thank you)$/i, '');
    // "can you remember things?" asks what the hosts can do; it is not something to remember
    if (isQuestionNotOrder(said, text)) return undefined;
    return text.length >= 3 ? { op: 'remember', text } : undefined;
  }
  m = s.match(FORGET);
  if (m) {
    const rest = m[1]!.trim().replace(/[.!?\s]+$/, '').replace(/,? ?(please|thanks|thank you)$/i, '').trim();
    if (/^(everything|all of it|all that|it all|all)( about me)?$/i.test(rest)) return { op: 'forget-all' };
    if (/^(it|that|this|what i (just )?said|the last (thing|one))?$/i.test(rest)) return { op: 'forget', text: '' };
    return { op: 'forget', text: rest };
  }
  return undefined;
}

/** The card "forget ..." is about: the best match by words, or (for a bare "forget that") the last one learned. */
export function cardToForget(cards: MemoryCard[], text: string, now: number): MemoryCard | undefined {
  const fromWords = cards.filter((c) => c.source === 'callin' || c.source === 'app' || c.source === 'you');
  if (!text) {
    const recent = [...fromWords].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return recent && now - recent.updatedAt < 24 * 3600_000 ? recent : undefined;
  }
  const want = new Set(contentWords(toSecondPerson(text)));
  let best: MemoryCard | undefined;
  let score = 0;
  for (const c of cards) {
    const words = contentWords(c.text);
    const hit = words.filter((w) => want.has(w)).length;
    const s = hit / Math.max(1, Math.min(words.length, want.size));
    if (hit > 0 && s > score) {
      best = c;
      score = s;
    }
  }
  return score >= 0.3 ? best : undefined;
}

/** Turns "my sister Ana is visiting next weekend" into a card draft (second person, real dates, a kind). */
export function draftFromWords(text: string, now: number): { text: string; kind: MemoryCard['kind']; expiresAt?: number } {
  const { text: dated, date } = withAbsoluteDate(text, now);
  const card = toSecondPerson(dated).replace(/[.!\s]+$/, '');
  const kind = guessKind(card, Boolean(date));
  return { text: card, kind, ...(date && kind === 'plans' ? { expiresAt: date.end } : {}) };
}

/** Applies a remember / forget command; undefined when `said` is not one. */
export async function takeMemoryCommand(said: string, from: 'call' | 'app' = 'call', now = Date.now()): Promise<MemoryChange | undefined> {
  const cmd = parseMemoryCommand(said);
  if (!cmd) return undefined;
  if (cmd.op === 'forget-all') return { op: 'forget-all', text: '', from };
  if (cmd.op === 'forget') {
    const card = cardToForget(await allCards(), cmd.text, now);
    if (!card) return { op: 'notfound', text: cmd.text, from };
    await deleteCards([card.id]);
    return { op: 'forgot', text: card.text, cardId: card.id, from };
  }
  const d = draftFromWords(cmd.text, now);
  const plan = await addCard({ ...d, source: from === 'app' ? 'app' : 'callin', asked: true, learnedAt: now }, now);
  if (!plan.put) return { op: 'refused', text: d.text, from, problem: plan.refused };
  return { op: plan.updated ? 'updated' : 'remembered', text: plan.put.text, cardId: plan.put.id, from };
}

/** For the prompt: what just happened, so the hosts confirm it in a few words. */
export function memoryFact(c: MemoryChange | undefined): string {
  if (!c) return '';
  const who = c.from === 'app' ? "The listener's AI assistant" : 'The listener';
  switch (c.op) {
    case 'remembered':
    case 'updated':
      return `MEMORY: ${who} asked you to remember something, and you now remember: "${c.text}". It is saved.`;
    case 'forgot':
      return `MEMORY: ${who} asked you to forget something: "${c.text}" is forgotten now.`;
    case 'notfound':
      return `MEMORY: ${who} asked you to forget ${c.text ? `"${c.text}"` : 'something'}, but you had nothing like that saved.`;
    case 'forget-all':
      return 'MEMORY: the listener asked you to forget everything. That is done in the app: Settings, What your hosts remember, Forget everything.';
    default:
      return `MEMORY: ${who} asked you to remember something you cannot keep (${c.problem === 'secret' ? 'passwords, codes and numbers like that are never kept' : c.problem === 'full' ? 'the memory is full' : 'it was empty'}). Nothing was saved.`;
  }
}

export function memoryTask(c: MemoryChange | undefined): string {
  if (!c) return '';
  if (c.op === 'remembered' || c.op === 'updated') return 'Confirm in a few words that you will remember it (like "Got it, I will remember that."), once. Do not read the whole memory back.';
  if (c.op === 'forgot') return 'Confirm in a few words that it is forgotten (like "Done, I have forgotten that."), once.';
  if (c.op === 'forget-all') return 'Say kindly, in one short sentence, where they can clear everything (Settings, What your hosts remember).';
  return 'Say kindly, in one short sentence, that nothing was saved and why.';
}

/** The scripted fallback's words for it. */
export function memorySpoken(c: MemoryChange): string {
  switch (c.op) {
    case 'remembered':
    case 'updated':
      return 'Got it, I will remember that.';
    case 'forgot':
      return 'Done, I have forgotten that.';
    case 'notfound':
      return "I don't have anything like that saved, so there is nothing to forget.";
    case 'forget-all':
      return 'To clear everything, open Settings and then What your hosts remember.';
    default:
      return c.problem === 'secret' ? 'I never keep passwords, codes or numbers like that, so I did not save it.' : 'I could not save that one.';
  }
}
