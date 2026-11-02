// Using the memory in a break: a compact WHAT YOU KNOW ABOUT THE LISTENER block (pinned cards, upcoming plans, the
// cards that match this break's topics, a little recency; a small budget for small local models) and the last day
// or two of the journal when it fits. Also the patterns that steer the radio ("Skips the news before 9 AM": less
// news in the morning).
import { db } from '../db/db';
import type { ContextPacket, JournalEntry, MemoryBrief, MemoryCard } from '../types';
import { isExpired } from './cards';
import { quieterFrom } from './patterns';
import { sensitiveTopic } from './safety';
import { contentWords, dayKey, toSecondPerson } from './text';

const DAY = 86_400_000;
const MAX_FACTS = 8;
const BUDGET = 700;

const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** One prompt line for a card, with where it came from and how old it is. */
export function cardLine(c: MemoryCard): string {
  const from =
    c.source === 'listening'
      ? `pattern${c.evidence ? `, seen ${c.evidence.count} times over ${c.evidence.days} days` : ''}`
      : `${c.source === 'you' ? 'they wrote it' : c.source === 'app' ? 'from their AI app' : 'they told you'}, ${shortDate(c.learnedAt)}`;
  // the listener's own words say "I": the hosts read them as "you"
  return `- ${c.source === 'you' || c.editedAt ? toSecondPerson(c.text) : c.text} (${from})`;
}

const overlap = (a: Set<string>, text: string) => contentWords(text).filter((w) => a.has(w)).length;

/**
 * The cards for one break (pure). `topics` = the words of this break (its items, the songs, the call); a sensitive
 * card only when the listener's own call is about it.
 */
export function pickCards(cards: MemoryCard[], opts: { topics: string; callIn?: string; now: number; max?: number; budget?: number }): MemoryCard[] {
  const { now } = opts;
  const words = new Set(contentWords(`${opts.topics} ${opts.callIn ?? ''}`));
  const call = new Set(contentWords(opts.callIn ?? ''));
  const live = cards.filter((c) => !isExpired(c, now) && (!c.sensitive || (call.size > 0 && overlap(call, c.text) > 0)));
  const picked: MemoryCard[] = [];
  const add = (list: MemoryCard[], n: number) => {
    for (const c of list) {
      if (n <= 0) break;
      if (picked.includes(c)) continue;
      picked.push(c);
      n--;
    }
  };
  add(live.filter((c) => c.pinned).sort((a, b) => b.updatedAt - a.updatedAt), 3);
  // plans in the next 10 days (a question about "next weekend" finds them)
  add(live.filter((c) => c.kind === 'plans' && c.expiresAt !== undefined && c.expiresAt - now < 10 * DAY).sort((a, b) => a.expiresAt! - b.expiresAt!), 2);
  const scored = live
    .map((c) => ({ c, s: overlap(words, c.text) + (call.size ? overlap(call, c.text) * 2 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  add(scored.map((x) => x.c), 3);
  // a little recency: what was learned in the last 3 days
  add(live.filter((c) => c.source !== 'listening' && now - c.learnedAt < 3 * DAY).sort((a, b) => b.learnedAt - a.learnedAt), 1);
  // patterns that matter right now (the radio already steers by them; the hosts may know why)
  add(live.filter((c) => c.source === 'listening').sort((a, b) => (b.evidence?.count ?? 0) - (a.evidence?.count ?? 0)), 1);
  const out: MemoryCard[] = [];
  let used = 0;
  for (const c of picked.slice(0, opts.max ?? MAX_FACTS)) {
    const len = cardLine(c).length;
    if (used + len > (opts.budget ?? BUDGET)) continue;
    used += len;
    out.push(c);
  }
  return out;
}

const RECALL = /\b(yesterday|last time|earlier|before|the other day|you said|i said|i asked|i told you|remember|we talked)\b/i;

/** Journal lines for this break (pure): the listener's own words of the last day or two, when they fit. */
export function pickJournal(rows: JournalEntry[], opts: { topics: string; callIn?: string; now: number; opening?: boolean }): string[] {
  const since = opts.now - 2 * DAY;
  const said = rows.filter((r) => (r.kind === 'said' || r.kind === 'app' || r.kind === 'requested') && r.at >= since && r.at < opts.now - 60_000);
  if (!said.length) return [];
  const words = new Set(contentWords(`${opts.topics} ${opts.callIn ?? ''}`));
  let pick: JournalEntry[];
  if (opts.callIn && RECALL.test(opts.callIn)) pick = said.slice(0, 3);
  else {
    pick = said.filter((r) => overlap(words, r.text) > 0).slice(0, 2);
    // the first break of the day picks up from yesterday ("yesterday you asked about ...")
    if (!pick.length && opts.opening) pick = said.filter((r) => r.day !== dayKey(opts.now)).slice(0, 1);
  }
  return pick
    .filter((r) => !sensitiveTopic(r.text))
    .map((r) => {
      const d = new Date(r.at);
      const today = new Date(opts.now).toDateString() === d.toDateString();
      const when = `${today ? 'Today' : 'Yesterday'} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      const how = r.kind === 'said' ? 'the listener said on a call-in' : r.kind === 'app' ? "the listener's AI app said" : 'the listener asked for the song';
      return `${when}, ${how}: "${r.text.slice(0, 160)}"`;
    });
}

/** The words of this break: its items, the songs around it, the call. */
export function breakTopics(packet: ContextPacket, keys: string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    if (k.startsWith('calendar:')) parts.push(packet.calendar?.find((e) => `calendar:${e.id}` === k)?.title ?? '');
    else if (k.startsWith('email:')) parts.push(packet.email?.find((m) => `email:${m.id}` === k)?.subject ?? '');
    else if (k === 'weather') parts.push(`weather ${packet.weather?.condition ?? ''}`);
    else parts.push(packet.news?.find((h) => h.id === k)?.title ?? '');
  }
  for (const s of [packet.songBefore, packet.songAfter]) if (s) parts.push(`${s.title} ${s.artist} ${s.album ?? ''}`);
  parts.push(packet.now.weekday, packet.now.partOfDay);
  return parts.filter(Boolean).join(' ');
}

/** The memory for a break, from the device database. */
export async function memoryBrief(packet: ContextPacket, opts: { keys: string[]; callIn?: string; opening?: boolean; now?: number }): Promise<MemoryBrief> {
  const now = opts.now ?? Date.now();
  const [cards, rows] = await Promise.all([db.memories.toArray(), db.journal.where('at').aboveOrEqual(now - 2 * DAY).toArray()]);
  rows.sort((a, b) => b.at - a.at);
  const topics = breakTopics(packet, opts.keys);
  const picked = pickCards(cards, { topics, callIn: opts.callIn, now });
  const soon = picked.filter((c) => c.kind === 'plans' && c.expiresAt !== undefined && c.expiresAt - now < 3 * DAY && !c.sensitive).sort((a, b) => a.expiresAt! - b.expiresAt!)[0];
  return {
    ...(soon ? { soon: soon.text.replace(/[.!\s]+$/, '') } : {}),
    facts: picked.map(cardLine),
    ids: picked.map((c) => c.id),
    recently: pickJournal(rows, { topics, callIn: opts.callIn, now, opening: opts.opening }),
    quieter: quieterFrom(cards.filter((c) => !isExpired(c, now)).map((c) => c.pattern), now),
  };
}

/** Only the steering (before a break is planned). */
export async function quieterNow(now = Date.now()): Promise<string[]> {
  const cards = await db.memories.toArray();
  return quieterFrom(cards.filter((c) => c.pattern && !isExpired(c, now)).map((c) => c.pattern), now);
}

/** The prompt block (empty when there is nothing). */
export function memorySheet(m: MemoryBrief | undefined): string {
  if (!m || (!m.facts.length && !m.recently.length)) return '';
  return [
    m.facts.length ? `WHAT YOU KNOW ABOUT THE LISTENER (from earlier talks and how they listen; it may be out of date):\n${m.facts.join('\n')}` : '',
    m.recently.length ? `RECENTLY ON THE RADIO (their own words):\n${m.recently.map((r) => `- ${r}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The rule that goes with it. */
export const MEMORY_RULE =
  'Use WHAT YOU KNOW ABOUT THE LISTENER only where it fits naturally: at most one memory in the whole break, in passing, like a friend would. Never list or recite it, never say you are tracking them, and never bring up health, money, relationships, religion or politics unless the listener did. It may be out of date: when unsure, ask instead of telling.';
