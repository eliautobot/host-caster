// The memory lookups a host can make while answering a call (memory_search, journal_search: on this device, logged
// in Lookups like the others), and the scripted fallback's answer from memory.
import { db } from '../db/db';
import type { MemoryCard } from '../types';
import { KIND_LABEL, isExpired, sourceWords } from './cards';
import { pickCards } from './brief';
import { contentWords } from './text';

const DAY = 86_400_000;

const matchScore = (want: Set<string>, text: string) => contentWords(text).filter((w) => want.has(w)).length;

export async function memorySearch(query: string, now = Date.now()): Promise<{ cards: { text: string; kind: string; from: string; until?: string }[] }> {
  const cards = (await db.memories.toArray()).filter((c) => !isExpired(c, now));
  const want = new Set(contentWords(query));
  // "what's happening next weekend": plans match by date too
  const plansAsked = /\b(weekend|week|tomorrow|tonight|plans?|coming up|happening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(query);
  const scored = cards
    .map((c) => ({ c, s: matchScore(want, c.text) + (plansAsked && c.kind === 'plans' ? 1 : 0) }))
    .filter((x) => x.s > 0 || want.size === 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  return {
    cards: scored.map(({ c }) => ({
      text: c.text,
      kind: KIND_LABEL[c.kind],
      from: sourceWords(c),
      ...(c.expiresAt ? { until: new Date(c.expiresAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) } : {}),
    })),
  };
}

export async function journalSearch(query: string, days = 14, now = Date.now()): Promise<{ rows: { when: string; what: string; text: string }[] }> {
  const rows = (await db.journal.where('at').aboveOrEqual(now - Math.min(14, Math.max(1, days)) * DAY).toArray()).sort((a, b) => b.at - a.at);
  const want = new Set(contentWords(query));
  const hits = rows.filter((r) => want.size === 0 || matchScore(want, r.text) > 0).slice(0, 10);
  return {
    rows: hits.map((r) => ({
      when: new Date(r.at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      what: r.kind,
      text: r.text,
    })),
  };
}

/** The scripted fallback: a call-in question the listener's memory answers ("what's happening next weekend?"). */
export async function memoryAnswer(said: string, now = Date.now()): Promise<{ answer: string; card: MemoryCard } | undefined> {
  const cards = await db.memories.toArray();
  const picked = pickCards(cards, { topics: '', callIn: said, now, max: 3 });
  const want = new Set(contentWords(said));
  const plansAsked = /\b(weekend|week|tomorrow|tonight|plans?|coming up|happening)\b/i.test(said);
  const card = picked.find((c) => matchScore(want, c.text) > 0) ?? (plansAsked ? picked.find((c) => c.kind === 'plans') : undefined);
  if (!card) return undefined;
  return { answer: `You told me: ${card.text.replace(/\.$/, '')}.`, card };
}
