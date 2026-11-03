// Memory: what the hosts remember about the listener (see ARCHITECTURE.md "Memory"). Long-term cards (cards.ts,
// store.ts; synced), the short-term journal (journal.ts; this device), learning from words (commands.ts, learn.ts),
// patterns and upkeep (patterns.ts, reflect.ts), and what a break gets (brief.ts, search.ts).
import { kvGet, kvSet } from '../db/kv';
import { player } from '../player';
import type { InboxItem, Station } from '../types';
import { takeMemoryCommand } from './commands';
import { noteListening, noteSaid, noteSkip } from './journal';
import { learnFromWords } from './learn';
import { memoryUpkeep } from './reflect';

export * from './cards';
export * from './commands';
export * from './journal';
export * from './store';
export { learnFromWords, worthLearning } from './learn';
export { memoryUpkeep, reflect, consolidate } from './reflect';
export { memoryBrief, quieterNow, memorySheet, MEMORY_RULE } from './brief';
export { memorySearch, journalSearch, memoryAnswer } from './search';

let started = false;
let timer: ReturnType<typeof setInterval> | undefined;

/** Starts the journal's listeners (skips, songs) and the hourly upkeep check. Once per app run. */
export function startMemory(): void {
  if (started) return;
  started = true;
  player.on('userskip', ({ track, positionMs, durationMs }) => void noteSkip(track, positionMs, durationMs));
  timer = setInterval(() => void memoryUpkeep().catch(() => undefined), 3600_000);
  // the first check a little after start (the reflection of the day, the weekly tidy-up)
  setTimeout(() => void memoryUpkeep().catch(() => undefined), 20_000);
}

export function stopMemory(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  started = false;
}

/** A song started on a station: the hour is noted, and the first play of the day runs the reflection. */
export function memoryOnPlay(station: Pick<Station, 'id' | 'name'>): void {
  void noteListening(station.id, station.name);
  void memoryUpkeep({ stationId: station.id }).catch(() => undefined);
}

/**
 * Notes from the listener's AI app (their own words, like a call-in): journaled once. With an AI brain the hosts'
 * agent reads each note (actions/inbox.ts: it may remember, add or propose, never approve) and learns from the rest,
 * so nothing here would remember it a second time. Without one, "remember that ..." is honored here and the rest
 * learned from in the background.
 */
export async function memoryFromInbox(inbox: InboxItem[] | undefined, stationId?: string, opts: { agent?: boolean } = {}): Promise<void> {
  const notes = (inbox ?? []).filter((i) => i.kind === 'note' && i.text.trim());
  if (!notes.length) return;
  const seen = new Set((await kvGet<string[]>('memory:inbox'))?.value ?? []);
  const fresh = notes.filter((n) => !seen.has(n.id));
  if (!fresh.length) return;
  await kvSet('memory:inbox', [...seen, ...fresh.map((n) => n.id)].slice(-200));
  for (const n of fresh) {
    await noteSaid(n.text, 'app');
    if (opts.agent) continue;
    const cmd = await takeMemoryCommand(n.text, 'app').catch(() => undefined);
    if (!cmd) await learnFromWords(n.text, 'app', { stationId });
  }
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  if (import.meta.env.VITE_HOSTCASTER_DEBUG === '1') {
    void Promise.all([import('./store'), import('./journal'), import('./reflect'), import('./learn'), import('./commands'), import('./brief')]).then(([store, journal, reflect, learn, commands, brief]) => {
      (w.__hostcaster ??= {}).memory = { ...store, ...journal, ...reflect, ...learn, ...commands, ...brief };
    });
  }
}
