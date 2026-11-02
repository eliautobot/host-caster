// Upkeep of the memory. Daily reflection (once a day while the app runs, or at the first play of the day): the
// journal's patterns become cards, only with real evidence (3+ times over 2+ days), each with its count; with an AI
// brain it may also name patterns in what the listener said, citing the journal rows (checked here). Weekly
// consolidation: expired plans go, duplicates merge, a changed fact replaces the old one (a new job), stale weak
// patterns retire, the bound holds. The scripted fallback brain never writes: rules only.
import { generate } from '../ai/generate';
import { getSettings } from '../db/profile';
import { kvGet, kvSet } from '../db/kv';
import type { Brain, JournalEntry, MemoryCard } from '../types';
import { MAX_TEXT, isProtected } from './cards';
import { listJournal, memorySwitches } from './journal';
import { learningBrain } from './learn';
import { MIN_DAYS, MIN_TIMES, findPatterns } from './patterns';
import { checkCard } from './safety';
import { addCard, allCards, deleteCards, memoryEvents, replaceCard, tidyCards } from './store';
import { clip, contentWords, dayKey } from './text';

const DAY = 86_400_000;
const KEY = 'memory:upkeep';
const PATTERN_WORDS = 'asks often usually always before after mentions talks skips likes listens loves enjoys requests plays tunes morning evening night afternoon weekdays weekends';

interface Upkeep {
  reflectDay?: string;
  consolidatedAt?: number;
}

const readJson = (text: string): Record<string, unknown> | undefined => {
  const t = text.replace(/```(json)?/g, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

// ---- daily reflection ------------------------------------------------------------------------------------------------

const rowLine = (r: JournalEntry, n: number) =>
  `[r${n}] ${new Date(r.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ${r.kind}: ${r.text.slice(0, 140)}`;

/** The brain's pattern ideas, kept only with 3+ cited rows over 2+ days and words from those rows (pure). */
export function checkPatternIdeas(raw: unknown, rows: JournalEntry[]): { text: string; evidence: { count: number; days: number }; fromWords: boolean }[] {
  const list = (raw as { patterns?: unknown })?.patterns;
  if (!Array.isArray(list)) return [];
  const out: { text: string; evidence: { count: number; days: number }; fromWords: boolean }[] = [];
  for (const p of list.slice(0, 3)) {
    const { text, rows: cited } = (p ?? {}) as { text?: unknown; rows?: unknown };
    if (typeof text !== 'string' || !Array.isArray(cited)) continue;
    const hits = [...new Set(cited.map((x) => Number(String(x).replace(/^r/, ''))))].map((n) => rows[n - 1]).filter((r): r is JournalEntry => Boolean(r));
    const days = new Set(hits.map((r) => r.day)).size;
    if (hits.length < MIN_TIMES || days < MIN_DAYS) continue;
    const card = clip(text, MAX_TEXT);
    // the words of a pattern itself ("asks", "skips", "usually", "before") come with it
    if (!checkCard(card, { asked: false, sources: [...hits.map((r) => r.text), PATTERN_WORDS] }).ok) continue;
    out.push({ text: card, evidence: { count: hits.length, days }, fromWords: hits.some((r) => r.kind === 'said' || r.kind === 'app') });
  }
  return out;
}

/** An idea that mostly repeats a pattern card already there ("Skips the hosts, including news" vs "Skips the news before 9 AM"). */
export function repeatsKnown(text: string, known: string[]): boolean {
  const a = new Set(contentWords(text));
  return known.some((k) => {
    const b = contentWords(k);
    const both = b.filter((w) => a.has(w)).length;
    return both / Math.max(1, Math.min(a.size, b.length)) >= 0.5;
  });
}

async function brainPatterns(brain: Brain, rows: JournalEntry[]): Promise<number> {
  const shown = rows.filter((r) => r.kind !== 'covered' && r.kind !== 'headsup').slice(0, 80);
  if (shown.length < MIN_TIMES) return 0;
  const known = (await allCards()).filter((c) => c.pattern || c.kind === 'routines').map((c) => c.text);
  const system = [
    "You look for patterns in a radio listener's last two weeks: things they do or say again and again (when they listen, what they skip, like or ask for, what they keep mentioning).",
    `A pattern needs real evidence: at least ${MIN_TIMES} rows on at least ${MIN_DAYS} different days. Cite the row ids. No guesses, nothing about health, money, relationships, religion or politics.`,
    'Write each pattern as a short card (under 12 words, like "Skips the news before 9 AM" or "Asks about the weather before running").',
    'Only NEW patterns: never one that ALREADY KNOWN says in other words.',
    'Answer with JSON only: {"patterns":[{"text":"...","rows":["r1","r4","r9"]}]} with at most 3 patterns, or {"patterns":[]}.',
  ].join('\n');
  const user = `${known.length ? `ALREADY KNOWN:\n${known.map((k) => `- ${k}`).join('\n')}\n\n` : ''}JOURNAL:\n${shown.map((r, i) => rowLine(r, i + 1)).join('\n')}`;
  const text = await generate(brain, { system, messages: [{ role: 'user', content: user }], json: true, maxTokens: 300 }, { timeoutMs: 30_000 });
  const ideas = checkPatternIdeas(readJson(text), shown).filter((p) => !repeatsKnown(p.text, known));
  let n = 0;
  for (const p of ideas) {
    const plan = await addCard({ text: p.text, kind: 'routines', source: p.fromWords ? 'callin' : 'listening', evidence: p.evidence, pattern: `ai:${contentWords(p.text).slice(0, 4).join('-')}` });
    if (plan.put) n++;
  }
  return n;
}

/** The daily reflection: rule patterns always, the brain's when there is one. Returns cards added or updated. */
export async function reflect(now = Date.now(), brain?: Brain): Promise<number> {
  const sw = memorySwitches(await getSettings());
  const rows = await listJournal(14, now);
  let n = 0;
  if (sw.fromListening) {
    for (const p of findPatterns(rows)) {
      const plan = await addCard({ text: p.text, kind: p.kind, source: 'listening', pattern: p.pattern, evidence: p.evidence }, now);
      if (plan.put) n++;
    }
  }
  if (brain && (sw.fromListening || sw.fromWords)) {
    const allowed = rows.filter((r) => ((r.kind === 'said' || r.kind === 'app') ? sw.fromWords : sw.fromListening));
    n += await brainPatterns(brain, allowed).catch((err: unknown) => {
      console.warn('[hostcaster] memory reflection', err instanceof Error ? err.message : err);
      return 0;
    });
  }
  return n;
}

// ---- weekly consolidation ---------------------------------------------------------------------------------------------

export type TidyAction = { op: 'merge'; keep: MemoryCard; drop: string[] } | { op: 'forget'; id: string } | { op: 'update'; card: MemoryCard };

/** The brain's tidy-up, checked (pure): learned cards only, merged words from the merged cards, a replaced fact needs its newer card. */
export function checkTidy(raw: unknown, cards: MemoryCard[], now: number): TidyAction[] {
  const list = (raw as { actions?: unknown })?.actions;
  if (!Array.isArray(list)) return [];
  // patterns are kept by their evidence (and steer the radio by their rule): never rewritten by the brain
  const byId = new Map(cards.filter((c) => !c.pattern).map((c) => [c.id, c]));
  const used = new Set<string>();
  const out: TidyAction[] = [];
  for (const a of list.slice(0, 10)) {
    const { op, id, ids, by, text } = (a ?? {}) as Record<string, unknown>;
    if (op === 'merge' && Array.isArray(ids) && typeof text === 'string') {
      const group = [...new Set(ids.map(String))].map((x) => byId.get(x)).filter((c): c is MemoryCard => Boolean(c));
      if (group.length < 2 || group.some((c) => isProtected(c) || used.has(c.id))) continue;
      const merged = clip(text, MAX_TEXT);
      if (!checkCard(merged, { asked: group.some((c) => c.sensitive), sources: group.map((c) => c.text) }).ok) continue;
      const newest = [...group].sort((x, y) => y.learnedAt - x.learnedAt)[0]!;
      group.forEach((c) => used.add(c.id));
      out.push({ op: 'merge', keep: { ...newest, text: merged, updatedAt: now }, drop: group.filter((c) => c !== newest).map((c) => c.id) });
    } else if (op === 'forget' && typeof id === 'string') {
      const card = byId.get(id);
      const newer = typeof by === 'string' ? byId.get(by) : undefined;
      if (!card || isProtected(card) || used.has(card.id)) continue;
      const expired = card.expiresAt !== undefined && card.expiresAt < now;
      // a fact replaced by a newer one of the same kind (the old job), or a plan that is over
      if (!expired && !(newer && newer.id !== card.id && newer.learnedAt > card.learnedAt && newer.kind === card.kind)) continue;
      used.add(card.id);
      out.push({ op: 'forget', id: card.id });
    } else if (op === 'update' && typeof id === 'string' && typeof text === 'string') {
      const card = byId.get(id);
      if (!card || isProtected(card) || used.has(card.id)) continue;
      const t = clip(text, MAX_TEXT);
      if (!checkCard(t, { asked: Boolean(card.sensitive), sources: [card.text] }).ok) continue;
      used.add(card.id);
      out.push({ op: 'update', card: { ...card, text: t, updatedAt: now } });
    }
  }
  return out;
}

async function brainTidy(brain: Brain, now: number): Promise<number> {
  const cards = await allCards();
  const learned = cards.filter((c) => !isProtected(c) && !c.pattern);
  if (learned.length < 2) return 0;
  const line = (c: MemoryCard) => `[${c.id}] (${c.kind}, ${new Date(c.learnedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${isProtected(c) || c.pattern ? ', keep' : ''}) ${c.text}`;
  const system = [
    "You tidy up a radio host's memory cards about one listener. Today is " + new Date(now).toDateString() + '.',
    'Merge cards that say the same thing into one short card. When a newer card changes an older fact (a new job, a move, a new pet name), forget the older card and name the newer one in "by".',
    'Forget plans that are over. Never change cards marked "keep". Change nothing that is fine; no new facts.',
    'Answer with JSON only: {"actions":[{"op":"merge","ids":["m1","m2"],"text":"..."},{"op":"forget","id":"m3","by":"m7"},{"op":"update","id":"m4","text":"..."}]} or {"actions":[]}.',
  ].join('\n');
  const text = await generate(brain, { system, messages: [{ role: 'user', content: `CARDS:\n${cards.slice(0, 60).map(line).join('\n')}` }], json: true, maxTokens: 500 }, { timeoutMs: 40_000 });
  const actions = checkTidy(readJson(text), cards, now);
  for (const a of actions) {
    if (a.op === 'merge') {
      await replaceCard(a.keep);
      await deleteCards(a.drop);
    } else if (a.op === 'forget') await deleteCards([a.id]);
    else await replaceCard(a.card);
  }
  return actions.length;
}

/** The weekly consolidation. Returns the number of changes. */
export async function consolidate(now = Date.now(), brain?: Brain): Promise<number> {
  let n = (await tidyCards(now)).length;
  if (brain) {
    n += await brainTidy(brain, now).catch((err: unknown) => {
      console.warn('[hostcaster] memory consolidation', err instanceof Error ? err.message : err);
      return 0;
    });
  }
  return n;
}

// ---- when it runs ----------------------------------------------------------------------------------------------------

let running: Promise<{ reflected: boolean; consolidated: boolean }> | undefined;

/** Runs what is due: the reflection once a day, the consolidation once a week (or `force` them now). */
export function memoryUpkeep(opts: { now?: number; force?: 'reflect' | 'consolidate' | 'both'; stationId?: string } = {}): Promise<{ reflected: boolean; consolidated: boolean }> {
  running ??= (async () => {
    const now = opts.now ?? Date.now();
    const st = (await kvGet<Upkeep>(KEY))?.value ?? {};
    const reflectDue = st.reflectDay !== dayKey(now) || opts.force === 'reflect' || opts.force === 'both';
    const consolidateDue = !st.consolidatedAt || now - st.consolidatedAt >= 7 * DAY || opts.force === 'consolidate' || opts.force === 'both';
    if (!reflectDue && !consolidateDue) return { reflected: false, consolidated: false };
    const brain = await learningBrain(opts.stationId).catch(() => undefined);
    if (reflectDue) await reflect(now, brain);
    if (consolidateDue) await consolidate(now, brain);
    await kvSet(KEY, { reflectDay: reflectDue ? dayKey(now) : st.reflectDay, consolidatedAt: consolidateDue ? now : st.consolidatedAt });
    memoryEvents.emit('change', {});
    return { reflected: reflectDue, consolidated: consolidateDue };
  })().finally(() => {
    running = undefined;
  });
  return running;
}
