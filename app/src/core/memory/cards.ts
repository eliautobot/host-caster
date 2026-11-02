// The long-term memory (pure): a bounded, curated set of short cards. Adding one that is already there updates it;
// a full memory makes room by letting go of the least useful learned card (an expired plan, a weak pattern, the
// oldest); the listener's own and pinned cards are never pushed out. See store.ts for the database side.
import type { MemoryCard, MemoryKind, MemorySource } from '../types';
import { newId } from '../util/id';
import { checkCard } from './safety';
import { clip, similarity } from './text';

export const MAX_CARDS = 60;
export const MAX_TEXT = 200;
export const KINDS: MemoryKind[] = ['about', 'people', 'preferences', 'routines', 'plans', 'jokes'];
export const KIND_LABEL: Record<MemoryKind, string> = {
  about: 'About you',
  people: 'People',
  preferences: 'Preferences',
  routines: 'Routines and patterns',
  plans: 'Plans and dates',
  jokes: 'Running jokes',
};
/** two cards this alike (same kind) are one fact */
export const SAME = 0.7;
const DAY = 86_400_000;

export interface CardDraft {
  text: string;
  kind: MemoryKind;
  source: MemorySource;
  learnedAt?: number;
  expiresAt?: number;
  pinned?: boolean;
  pattern?: string;
  evidence?: { count: number; days: number };
  /** the listener asked for it ("remember that ...", typed in the app): a sensitive topic may stay */
  asked?: boolean;
  /** learned cards: the words it must come from */
  sources?: string[];
}

export interface AddPlan {
  /** the card to write (new or updated) */
  put?: MemoryCard;
  /** cards to drop to stay within the bound */
  drop: string[];
  /** true when `put` updates a card that was there */
  updated?: boolean;
  refused?: 'secret' | 'sensitive' | 'ungrounded' | 'empty' | 'full';
}

export const isExpired = (c: Pick<MemoryCard, 'expiresAt'>, now: number) => c.expiresAt !== undefined && c.expiresAt < now;
/** the listener's own words or a pin: never changed or dropped by the hosts */
export const isProtected = (c: Pick<MemoryCard, 'source' | 'pinned' | 'editedAt'>) => c.source === 'you' || Boolean(c.pinned || c.editedAt);

/** The card the hosts would let go of first, or undefined when every card is the listener's own or pinned. */
export function leastUseful(cards: MemoryCard[], now: number): MemoryCard | undefined {
  const rank = (c: MemoryCard) => {
    if (isExpired(c, now)) return 0;
    if (c.pattern) return 1 + Math.min(c.evidence?.count ?? 0, 20) / 100;
    return 2;
  };
  return cards
    .filter((c) => !isProtected(c))
    .sort((a, b) => rank(a) - rank(b) || a.updatedAt - b.updatedAt)[0];
}

/** The card a new fact is the same as (same pattern rule, or alike in words and kind). */
export function sameCard(cards: MemoryCard[], d: Pick<CardDraft, 'text' | 'kind' | 'pattern'>): MemoryCard | undefined {
  if (d.pattern) return cards.find((c) => c.pattern === d.pattern);
  let best: MemoryCard | undefined;
  let score = SAME;
  for (const c of cards) {
    if (c.pattern) continue;
    const s = similarity(c.text, d.text) + (c.kind === d.kind ? 0 : -0.15);
    if (s >= score) {
      best = c;
      score = s;
    }
  }
  return best;
}

/** What adding `d` does to `cards` (nothing is written here). */
export function planAdd(cards: MemoryCard[], d: CardDraft, now: number): AddPlan {
  const text = clip(d.text, MAX_TEXT);
  const verdict = checkCard(text, { asked: Boolean(d.asked) || d.source === 'you', sources: d.sources });
  if (!verdict.ok) return { drop: [], refused: verdict.problem };
  const sensitive = verdict.sensitive ? true : undefined;
  const same = sameCard(cards, { ...d, text });
  if (same) {
    // the listener's own card keeps their words; a learned one takes the newer wording
    const keepText = same.source === 'you' && d.source !== 'you';
    const put: MemoryCard = {
      ...same,
      text: keepText ? same.text : text,
      kind: keepText ? same.kind : d.kind,
      updatedAt: now,
      ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
      ...(d.evidence ? { evidence: d.evidence } : {}),
      ...(sensitive || same.sensitive ? { sensitive: true } : {}),
      ...(d.pinned ? { pinned: true } : {}),
    };
    return { put, drop: [], updated: true };
  }
  const live = cards.filter((c) => !isExpired(c, now - DAY));
  const drop = cards.filter((c) => !live.includes(c)).map((c) => c.id);
  if (live.length >= MAX_CARDS) {
    const out = leastUseful(live, now);
    if (!out) return { drop: [], refused: 'full' };
    drop.push(out.id);
  }
  const put: MemoryCard = {
    id: `m_${newId()}`,
    text,
    kind: d.kind,
    source: d.source,
    learnedAt: d.learnedAt ?? now,
    createdAt: now,
    updatedAt: now,
    ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
    ...(d.pinned ? { pinned: true } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    ...(d.pattern ? { pattern: d.pattern } : {}),
    ...(d.evidence ? { evidence: d.evidence } : {}),
  };
  return { put, drop };
}

/**
 * The weekly tidy-up without a brain: expired plans go, near duplicates become one (the newer wording; the
 * listener's own wins), patterns not seen again for 3 weeks with little evidence retire, and the set stays within
 * the bound.
 */
export function tidy(cards: MemoryCard[], now: number): { drop: string[]; keep: MemoryCard[] } {
  const drop = new Set<string>();
  for (const c of cards) {
    if (isProtected(c)) continue;
    if (isExpired(c, now)) drop.add(c.id);
    else if (c.pattern && now - c.updatedAt > 21 * DAY && (c.evidence?.count ?? 0) < 6) drop.add(c.id);
  }
  const live = cards.filter((c) => !drop.has(c.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (let i = 0; i < live.length; i++) {
    const a = live[i]!;
    if (drop.has(a.id) || a.pattern) continue;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j]!;
      if (drop.has(b.id) || b.pattern || a.kind !== b.kind || similarity(a.text, b.text) < SAME) continue;
      // b is older: it goes unless it is the listener's own (then the learned newer one goes)
      if (isProtected(b) && !isProtected(a)) {
        drop.add(a.id);
        break;
      }
      if (!isProtected(b)) drop.add(b.id);
    }
  }
  let keep = cards.filter((c) => !drop.has(c.id));
  while (keep.length > MAX_CARDS) {
    const out = leastUseful(keep, now);
    if (!out) break;
    drop.add(out.id);
    keep = keep.filter((c) => c.id !== out.id);
  }
  return { drop: [...drop], keep };
}

/** "you said on a call-in, Nov 1" / "learned from how you listen" / "you added it" */
export function sourceWords(c: Pick<MemoryCard, 'source' | 'learnedAt' | 'evidence' | 'editedAt'>): string {
  const when = new Date(c.learnedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (c.editedAt && c.source !== 'you') return `You changed it, ${new Date(c.editedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  switch (c.source) {
    case 'callin':
      return `You said it on a call-in, ${when}`;
    case 'app':
      return `From your AI app, ${when}`;
    case 'listening':
      return c.evidence ? `Learned from how you listen (${c.evidence.count} times over ${c.evidence.days} days)` : 'Learned from how you listen';
    default:
      return `You added it, ${when}`;
  }
}
