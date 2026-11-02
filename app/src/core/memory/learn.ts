// Learning from what the listener says: after a call-in or a message from their AI app, one small step with the
// host's brain answers "anything worth remembering?" through one tool with a tight schema (add / update / forget a
// card; no free text actions). Every action is checked here: the kind and the card must exist, the words must come
// from what the listener said (so an email or a web page can never plant a memory), nothing secret, nothing
// sensitive they did not ask for. Capped per day; on Host-Caster AI it is metered like every other call.
import { generate } from '../ai/generate';
import { getSettings } from '../db/profile';
import { getStation } from '../db/hosts';
import { kvGet, kvSet } from '../db/kv';
import { rememberMode, toolMode } from '../agent/loop';
import { leadWithBrain } from '../agent/research';
import { modelStep, ToolsUnsupportedError } from '../agent/step';
import type { Brain, MemoryCard, MemoryKind, ToolSpec } from '../types';
import { KINDS, MAX_TEXT, isProtected, type CardDraft } from './cards';
import type { MemoryChange } from './commands';
import { parseMemoryCommand } from './commands';
import { memorySwitches } from './journal';
import { checkCard } from './safety';
import { addCard, allCards, deleteCards, replaceCard } from './store';
import { clip, contentWords, dateEnd, findDate, similarity, withAbsoluteDate } from './text';

export const LEARN_CALLS_PER_DAY = 30;
const MAX_ACTIONS = 3;

export const MEMORY_TOOL: ToolSpec = {
  name: 'update_memory',
  description: 'Save what is worth remembering about the listener: add a card, update a card that changed, or forget one that is no longer true. No actions when nothing is worth remembering.',
  parameters: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        maxItems: MAX_ACTIONS,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'forget'] },
            id: { type: 'string', description: 'the card id from MEMORY (update and forget)' },
            kind: { type: 'string', enum: KINDS },
            text: { type: 'string', maxLength: MAX_TEXT, description: 'the card, second person, under 25 words ("Your sister Ana visits the weekend of November 7")' },
            date: { type: 'string', description: 'plans: the day it happens, YYYY-MM-DD' },
          },
          required: ['op'],
        },
      },
    },
    required: ['actions'],
  },
};

/** Worth a learning step? A statement about themselves (not a question, a song request or a hello). */
export function worthLearning(said: string): boolean {
  const s = said.trim().replace(/[’]/g, "'");
  if (s.split(/\s+/).length < 4 || parseMemoryCommand(s)) return false;
  if (/^(play|put on|queue|skip|can you play|could you play|add .* to my)\b/i.test(s)) return false;
  const statement = /\b(i'?m|i am|i'?ve|i was|i will|i'?ll|i have|i had|i love|i like|i hate|i work|i live|i usually|i always|i just|i got|i started|i quit|i moved|my|we'?re|we are|we have|we'?ll|our)\b/i;
  if (!statement.test(s)) return false;
  // a plain question about their day ("what's my next meeting?") is not something to remember
  if (/\?\s*$/.test(s) && /^(what|when|where|who|how|is|are|do|does|did|can|could|will|any)\b/i.test(s) && !/\b(i'?m|i am|i'?ve|i was|i have|i just|i started|my (sister|brother|mom|dad|wife|husband|partner|friend|son|daughter))\b/i.test(s.replace(/\?[^?]*$/, ''))) return false;
  return true;
}

const todayWords = (now: number) => new Date(now).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

/** The cards the step sees: the ones that share words with what was said, then the newest (a small prompt). */
export function cardsForStep(cards: MemoryCard[], said: string, max = 20): MemoryCard[] {
  const scored = cards.map((c) => ({ c, s: similarity(c.text, said) }));
  return scored
    .sort((a, b) => b.s - a.s || b.c.updatedAt - a.c.updatedAt)
    .slice(0, max)
    .map((x) => x.c);
}

export function learnPrompt(said: string, cards: MemoryCard[], now: number, json: boolean): { system: string; user: string } {
  const system = [
    'You keep the memory a radio host has about one listener. Decide if what the listener just said has anything worth remembering later:',
    'a lasting fact about them (work, home, family, pets), a person in their life, a preference (food, music, what they love or hate), a routine, a plan with a date, or a running joke.',
    'Only what THEY said about themselves and their life. Questions, song requests, greetings and small talk: nothing.',
    'Never keep passwords, codes, numbers, addresses or links. Never keep health, money, relationships, religion or politics.',
    'Write a card in the second person ("You", "Your"), short (under 25 words), only with their facts; real dates instead of "next weekend".',
    'If it changes a card in MEMORY (a new job replaces the old one), update that card by its id instead of adding one. If they say a card is no longer true, forget it.',
    'Worth a card: "my cat Miso hates thunder" -> add (people) "You have a cat called Miso"; "I\'m off to my yoga class" -> add (routines) "You go to yoga classes". Not worth one: "great song", "what\'s the weather?".',
    json
      ? 'Answer with JSON only: {"actions":[{"op":"add","kind":"plans","text":"...","date":"YYYY-MM-DD"}]} or {"actions":[]} when nothing is worth remembering. op is add, update (with id) or forget (with id); kind is one of about, people, preferences, routines, plans, jokes.'
      : 'Call update_memory once, with no actions when nothing is worth remembering.',
  ].join('\n');
  const user = [
    `TODAY: ${todayWords(now)}`,
    `MEMORY:\n${cards.map((c) => `[${c.id}] (${c.kind}) ${c.text}`).join('\n') || '(empty)'}`,
    `THE LISTENER SAID: "${said.replace(/"/g, "'").slice(0, 600)}"`,
  ].join('\n\n');
  return { system, user };
}

/** The actions from a tool call's arguments or from JSON text. */
export function readActions(raw: unknown): unknown[] {
  let v = raw;
  if (typeof v === 'string') {
    const t = v.replace(/```(json)?/g, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
      v = JSON.parse(t.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const actions = (v as { actions?: unknown })?.actions;
  return Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];
}

export type CardAction = { op: 'add'; draft: CardDraft } | { op: 'update'; card: MemoryCard } | { op: 'forget'; card: MemoryCard };

export interface LearnContext {
  said: string;
  cards: MemoryCard[];
  now: number;
  from: 'call' | 'app';
}

/** The valid actions only (pure): schema, card ids, safety, grounded in the listener's own words. */
export function validateActions(actions: unknown[], ctx: LearnContext): CardAction[] {
  const out: CardAction[] = [];
  const byId = new Map(ctx.cards.map((c) => [c.id, c]));
  const saidDate = findDate(ctx.said, ctx.now);
  const sources = [ctx.said, ...(saidDate ? [saidDate.absolute] : [])];
  const said = new Set(contentWords(ctx.said));
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const { op, id, kind, text, date } = a as Record<string, unknown>;
    if (op === 'forget') {
      const card = typeof id === 'string' ? byId.get(id) : undefined;
      // only a learned card, and only when what they said is about it
      if (card && !isProtected(card) && contentWords(card.text).some((w) => said.has(w))) out.push({ op: 'forget', card });
      continue;
    }
    if (typeof text !== 'string' || !text.trim()) continue;
    const k = (KINDS as string[]).includes(String(kind)) ? (kind as MemoryKind) : undefined;
    const fixed = withAbsoluteDate(clip(text, MAX_TEXT), ctx.now).text;
    // a dated fact is a plan, and it ends with its last date (the brain's, the one they said, the card's own): "next
    // weekend" said on a Monday may be read as this weekend or the one after, and a card never expires before the day
    // its own words talk about
    const textDate = findDate(fixed, ctx.now);
    const ends = [dateEnd(date, /weekend/i.test(`${fixed} ${ctx.said}`)), ...(textDate || k === 'plans' ? [saidDate?.end, textDate?.end] : [])];
    const when = ends.reduce<number | undefined>((a, b) => (b === undefined ? a : a === undefined ? b : Math.max(a, b)), undefined);
    const kindNow = when && (k === 'people' || k === 'about') ? 'plans' : k;
    if (op === 'update') {
      const card = typeof id === 'string' ? byId.get(id) : undefined;
      if (!card || isProtected(card)) continue;
      const v = checkCard(fixed, { asked: false, sources: [...sources, card.text] });
      if (!v.ok) continue;
      const kind = kindNow ?? card.kind;
      out.push({ op: 'update', card: { ...card, text: fixed, kind, updatedAt: ctx.now, learnedAt: ctx.now, source: ctx.from === 'app' ? 'app' : 'callin', ...(when && kind === 'plans' ? { expiresAt: when } : {}) } });
      continue;
    }
    if (op !== 'add' || !kindNow) continue;
    const v = checkCard(fixed, { asked: false, sources });
    if (!v.ok) continue;
    out.push({ op: 'add', draft: { text: fixed, kind: kindNow, source: ctx.from === 'app' ? 'app' : 'callin', learnedAt: ctx.now, sources, ...(kindNow === 'plans' && when ? { expiresAt: when } : {}) } });
  }
  return out;
}

/** Applies checked actions; the changes, for the "Remembered: ..." note. */
export async function applyActions(actions: CardAction[], from: 'call' | 'app', now = Date.now()): Promise<MemoryChange[]> {
  const out: MemoryChange[] = [];
  for (const a of actions) {
    if (a.op === 'forget') {
      await deleteCards([a.card.id]);
      out.push({ op: 'forgot', text: a.card.text, cardId: a.card.id, from });
    } else if (a.op === 'update') {
      await replaceCard(a.card);
      out.push({ op: 'updated', text: a.card.text, cardId: a.card.id, from });
    } else {
      const plan = await addCard(a.draft, now);
      if (plan.put) out.push({ op: plan.updated ? 'updated' : 'remembered', text: plan.put.text, cardId: plan.put.id, from });
    }
  }
  return out;
}

/** One learning call against today's cap (kv 'memory:learned'). */
export async function takeLearnCall(now = Date.now(), cap = LEARN_CALLS_PER_DAY): Promise<boolean> {
  const day = new Date(now).toDateString();
  const row = (await kvGet<{ day: string; n: number }>('memory:learned'))?.value;
  const n = row?.day === day ? row.n : 0;
  if (n >= cap) return false;
  await kvSet('memory:learned', { day, n: n + 1 });
  return true;
}

/** Asks the brain once (the memory tool natively, else JSON). */
export async function askBrain(brain: Brain, said: string, cards: MemoryCard[], now: number, timeoutMs = 25_000): Promise<unknown[]> {
  const mode = await toolMode(brain);
  if (mode === 'native') {
    const { system, user } = learnPrompt(said, cards, now, false);
    try {
      const r = await modelStep(brain, { system, messages: [{ role: 'user', content: user }], tools: [MEMORY_TOOL], maxTokens: 600 }, { timeoutMs });
      const call = r.toolCalls.find((c) => c.name === MEMORY_TOOL.name);
      return call ? readActions(call.args) : readActions(r.text);
    } catch (err) {
      if (!(err instanceof ToolsUnsupportedError)) throw err;
      await rememberMode(brain, 'json');
    }
  }
  const { system, user } = learnPrompt(said, cards, now, true);
  const text = await generate(brain, { system, messages: [{ role: 'user', content: user }], json: true, maxTokens: 600 }, { timeoutMs });
  return readActions(text);
}

/** The brain that learns: the lead host's real AI brain on the station tuned in (none = nothing is learned). */
export async function learningBrain(stationId?: string): Promise<Brain | undefined> {
  const settings = await getSettings();
  const id = stationId ?? settings.activeStationId;
  const station = id ? await getStation(id) : undefined;
  return station ? (await leadWithBrain(station))?.brain : undefined;
}

/**
 * After a call-in or an AI-app message: anything worth remembering? Never throws; returns what changed. Skips
 * when the switch is off, there is no AI brain, the words are not about the listener, or today's cap is used up.
 */
export async function learnFromWords(said: string, from: 'call' | 'app', opts: { stationId?: string; now?: number; brain?: Brain } = {}): Promise<MemoryChange[]> {
  const now = opts.now ?? Date.now();
  try {
    if (!memorySwitches(await getSettings()).fromWords || !worthLearning(said)) return [];
    const brain = opts.brain ?? (await learningBrain(opts.stationId));
    if (!brain || !(await takeLearnCall(now))) return [];
    const cards = await allCards();
    const raw = await askBrain(brain, said, cardsForStep(cards, said), now);
    const actions = validateActions(raw, { said, cards, now, from });
    return await applyActions(actions, from, now);
  } catch (err) {
    console.warn('[hostcaster] memory learning', err instanceof Error ? err.message : err);
    return [];
  }
}
