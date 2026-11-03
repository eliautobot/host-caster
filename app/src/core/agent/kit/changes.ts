// Changes the hosts made to Host-Caster's own data (Your list, memory), each with what undoes it: the listener says
// "undo that" (the undo_change tool) or taps Undo. Kept in kv (the newest 30, 7 days).
import { kvGet, kvSet } from '../../db/kv';
import { deleteCards, replaceCard } from '../../memory/store';
import { removeItems, updateItem } from '../../tracker/store';
import type { MemoryCard, TrackedItem } from '../../types';
import type { AppChange } from './types';

export type UndoOp =
  | { op: 'list-remove'; id: string }
  | { op: 'list-restore'; item: TrackedItem }
  | { op: 'memory-remove'; id: string }
  | { op: 'memory-restore'; card: MemoryCard };

interface Row extends AppChange {
  undo: UndoOp;
  undone?: boolean;
}

const KEY = 'agent:changes';
const KEEP_MS = 7 * 86_400_000;

async function rows(): Promise<Row[]> {
  return ((await kvGet<Row[]>(KEY))?.value ?? []).filter((r) => Date.now() - r.at < KEEP_MS);
}

export async function recordChange(what: string, undo: UndoOp, now = Date.now()): Promise<AppChange> {
  const change: Row = { id: `chg_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, what: what.slice(0, 160), at: now, undo };
  await kvSet(KEY, [...(await rows()), change].slice(-30));
  return { id: change.id, what: change.what, at: change.at };
}

/** Changes made since `since` that can still be undone, newest first. */
export async function recentChanges(since: number): Promise<AppChange[]> {
  return (await rows())
    .filter((r) => r.at >= since && !r.undone)
    .reverse()
    .map(({ id, what, at }) => ({ id, what, at }));
}

/** What the host says after undoing a change, in plain radio words ("Okay, I won't remember that you're vegetarian."). */
export function undoneLine(what: string, op: UndoOp['op']): string {
  const subject = /"([^"]+)"/.exec(what)?.[1] ?? '';
  const lower = subject ? subject.charAt(0).toLowerCase() + subject.slice(1) : '';
  switch (op) {
    case 'list-remove':
      return subject ? `Okay, I took "${subject}" back off Your list.` : 'Okay, I took that back off Your list.';
    case 'list-restore':
      return subject ? `Okay, "${subject}" is back on Your list the way it was.` : 'Okay, Your list is back the way it was.';
    case 'memory-remove':
      return lower ? `Okay, I won't remember that: ${lower.replace(/[.!]+$/, '')}.` : "Okay, I won't remember that.";
    case 'memory-restore':
      return lower ? `Okay, I'll remember it again: ${lower.replace(/[.!]+$/, '')}.` : "Okay, I'll remember it again.";
  }
}

/** Undoes one change (by id, or the newest since `since`). Returns what was undone, or undefined. */
export async function undoChange(id?: string, since = 0): Promise<(AppChange & { line: string }) | undefined> {
  const all = await rows();
  const row = id ? all.find((r) => r.id === id && !r.undone) : [...all].reverse().find((r) => r.at >= since && !r.undone);
  if (!row) return undefined;
  const u = row.undo;
  if (u.op === 'list-remove') await removeItems([u.id]);
  else if (u.op === 'list-restore') {
    const { id: itemId, createdAt: _c, ...rest } = u.item;
    await updateItem(itemId, rest);
  }
  else if (u.op === 'memory-remove') await deleteCards([u.id]);
  else await replaceCard(u.card);
  row.undone = true;
  await kvSet(KEY, all);
  return { id: row.id, what: row.what, at: row.at, line: undoneLine(row.what, u.op) };
}
