// The memory cards on this device (db.memories, synced with the account like hosts and stations: see api/sync.ts)
// and the 14-day journal (db.journal, this device only). Every change is announced so the app and the call-in sheet
// can show it.
import { db } from '../db/db';
import { kvDelete } from '../db/kv';
import type { JournalEntry, MemoryCard, MemoryKind } from '../types';
import { createEmitter } from '../util/emitter';
import { planAdd, tidy, type AddPlan, type CardDraft } from './cards';
import { clip } from './text';

export interface MemoryEvents {
  /** a card was added or changed (added = a new one, worth a "Remembered: ..." note) */
  change: { card?: MemoryCard; added?: boolean; removed?: string[] };
  journal: { entry?: JournalEntry };
}
export const memoryEvents = createEmitter<MemoryEvents>();

export async function allCards(): Promise<MemoryCard[]> {
  return (await db.memories.toArray()).sort((a, b) => b.updatedAt - a.updatedAt);
}

// one write at a time: two learning steps at once must not both push the 61st card in
let lock: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

/** Adds a card (or updates the one it is the same as), within the bound. */
export function addCard(d: CardDraft, now = Date.now()): Promise<AddPlan> {
  return serial(async () => {
    const plan = planAdd(await db.memories.toArray(), d, now);
    if (!plan.put) return plan;
    await db.transaction('rw', db.memories, async () => {
      if (plan.drop.length) await db.memories.bulkDelete(plan.drop);
      await db.memories.put(plan.put!);
    });
    memoryEvents.emit('change', { card: plan.put, added: !plan.updated, removed: plan.drop });
    return plan;
  });
}

/** The listener's own edit: their words stand from now on. */
export function editCard(id: string, patch: { text?: string; kind?: MemoryKind; pinned?: boolean; expiresAt?: number | null }, now = Date.now()): Promise<MemoryCard | undefined> {
  return serial(async () => {
    const card = await db.memories.get(id);
    if (!card) return undefined;
    const next: MemoryCard = { ...card, updatedAt: now };
    if (patch.text !== undefined && patch.text.trim() !== card.text) {
      next.text = clip(patch.text);
      next.editedAt = now;
    }
    if (patch.kind) next.kind = patch.kind;
    if (patch.pinned !== undefined) {
      if (patch.pinned) next.pinned = true;
      else delete next.pinned;
    }
    if (patch.expiresAt === null) delete next.expiresAt;
    else if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt;
    await db.memories.put(next);
    memoryEvents.emit('change', { card: next });
    return next;
  });
}

/** Updates a learned card in place (the hosts: a changed fact, fresh evidence). */
export function replaceCard(card: MemoryCard): Promise<void> {
  return serial(async () => {
    await db.memories.put(card);
    memoryEvents.emit('change', { card });
  });
}

export function deleteCards(ids: string[]): Promise<void> {
  return serial(async () => {
    if (!ids.length) return;
    await db.memories.bulkDelete(ids);
    memoryEvents.emit('change', { removed: ids });
  });
}

/** The tidy-up without a brain (expired plans, duplicates, stale weak patterns, the bound). */
export function tidyCards(now = Date.now()): Promise<string[]> {
  return serial(async () => {
    const { drop } = tidy(await db.memories.toArray(), now);
    if (drop.length) {
      await db.memories.bulkDelete(drop);
      memoryEvents.emit('change', { removed: drop });
    }
    return drop;
  });
}

/** "Forget everything": every card (on all signed-in devices: the deletions sync), the journal, the learning state. */
export async function forgetEverything(): Promise<void> {
  await serial(async () => {
    await db.memories.clear();
    await db.journal.clear();
    for (const k of ['memory:upkeep', 'memory:learned']) await kvDelete(k);
  });
  memoryEvents.emit('change', { removed: [] });
  memoryEvents.emit('journal', {});
}
