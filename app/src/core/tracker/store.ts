// Your list on this device (db.tracker, synced with the account like memory cards: see api/sync.ts).
// Items are deduped by source + meaning, bounded, and old done items fade out. Every change is announced so the
// list screen and the call-in sheet can show it.
import { nanoid } from 'nanoid'
import { db } from '../db/db'
import { contentWords, similarity } from '../memory/text'
import type { TrackedItem, TrackedKind, TrackedSource, TrackedStatus } from '../types'
import { createEmitter } from '../util/emitter'
import { speakable } from './safety'

export interface TrackerEvents {
  change: { item?: TrackedItem; added?: boolean; removed?: string[] }
}
export const trackerEvents = createEmitter<TrackerEvents>()

/** at most this many open items; the oldest undated outside items go first */
export const MAX_OPEN = 400
/** done items stay visible this long, then fade out; done/dismissed rows are removed after KEEP_MS */
export const DONE_VISIBLE_MS = 7 * 24 * 3600_000
export const KEEP_MS = 30 * 24 * 3600_000

export interface TrackedDraft {
  what: string
  kind: TrackedKind
  due?: string
  dueAllDay?: boolean
  remindAt?: number
  who?: string
  source: TrackedSource
  flags?: TrackedItem['flags']
  gtask?: TrackedItem['gtask']
  memoryId?: string
  status?: TrackedStatus
}

export type AddOp = 'added' | 'merged' | 'skipped'

let lock: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch(() => undefined)
  return run
}

/** "source + meaning": the same mail/event/task with the same few content words is the same item. */
export function itemKey(source: TrackedSource, what: string): string {
  const words = [...new Set(contentWords(what))].sort().slice(0, 6).join('.')
  return `${source.type}:${source.id ?? ''}:${words}`
}

function dueDay(due?: string): string | undefined {
  return due ? due.slice(0, 10) : undefined
}

/**
 * The item a draft is the same as, or undefined. Same key; or the same source record and alike; or (any source)
 * very alike, same due day and the same person, so an email and the event it is about become one item.
 */
export function sameAs(items: TrackedItem[], d: TrackedDraft, key = itemKey(d.source, d.what)): TrackedItem | undefined {
  const exact = items.find((i) => i.key === key)
  if (exact) return exact
  if (d.gtask) {
    const t = items.find((i) => i.gtask?.taskId === d.gtask!.taskId)
    if (t) return t
  }
  // two different Google tasks are two things the listener wrote down, however alike
  let best: { item: TrackedItem; score: number } | undefined
  for (const i of items) {
    if (i.status === 'done' && i.doneAt && Date.now() - i.doneAt > DONE_VISIBLE_MS) continue
    if (d.gtask && i.gtask) continue
    const sim = similarity(i.what, d.what)
    const sameSource = !!d.source.id && i.source.type === d.source.type && i.source.id === d.source.id
    const samePerson = !i.who || !d.who || i.who.toLowerCase().split(' ')[0] === d.who.toLowerCase().split(' ')[0]
    const sameDue = dueDay(i.due) === dueDay(d.due) || !i.due || !d.due
    const ok = (sameSource && sim >= 0.34) || (sim >= 0.6 && sameDue && samePerson)
    if (ok && (!best || sim > best.score)) best = { item: i, score: sim }
  }
  return best?.item
}

export async function allItems(): Promise<TrackedItem[]> {
  return db.tracker.toArray()
}

/** Open items (snoozed ones whose time came are open again), soonest due first. */
export async function openItems(now = Date.now()): Promise<TrackedItem[]> {
  const rows = await db.tracker.toArray()
  return rows.filter((i) => isOpen(i, now)).sort(byDue)
}

export function isOpen(i: TrackedItem, now = Date.now()): boolean {
  return i.status === 'open' || (i.status === 'snoozed' && (i.snoozedUntil ?? 0) <= now)
}

export function dueMs(i: Pick<TrackedItem, 'due' | 'remindAt'>): number | undefined {
  if (i.remindAt) return i.remindAt
  if (!i.due) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(i.due)) {
    const [y, m, d] = i.due.split('-').map(Number)
    return new Date(y, m - 1, d, 23, 59).getTime()
  }
  const t = Date.parse(i.due)
  return Number.isNaN(t) ? undefined : t
}

export function byDue(a: TrackedItem, b: TrackedItem): number {
  return (dueMs(a) ?? Number.MAX_SAFE_INTEGER) - (dueMs(b) ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt
}

/** Adds an item, or merges it into the one it is the same as. Dismissed items are not brought back. */
export function addItem(d: TrackedDraft, now = Date.now()): Promise<{ item: TrackedItem; op: AddOp }> {
  return serial(async () => {
    const what = speakable(d.what, 160)
    if (!what) throw new Error('empty item')
    const draft = { ...d, what }
    const key = itemKey(d.source, what)
    const items = await db.tracker.toArray()
    const twin = sameAs(items, draft, key)
    if (twin) {
      if (twin.status === 'dismissed' || (twin.status === 'done' && d.source.type !== 'you')) return { item: twin, op: 'skipped' as AddOp }
      const next: TrackedItem = {
        ...twin,
        // the listener's own words win; outside content only fills gaps
        what: twin.source.type === 'you' ? twin.what : d.source.type === 'you' ? what : twin.what,
        due: d.due ?? twin.due,
        dueAllDay: d.due ? d.dueAllDay : twin.dueAllDay,
        remindAt: d.remindAt ?? twin.remindAt,
        who: twin.who ?? d.who,
        flags: mergeFlags(twin.flags, d.flags),
        gtask: twin.gtask ?? d.gtask,
        memoryId: twin.memoryId ?? d.memoryId,
        source: twin.source.link || !d.source.link ? twin.source : { ...twin.source, link: d.source.link },
        status: twin.status === 'done' && d.source.type === 'you' ? 'open' : twin.status,
        updatedAt: now,
      }
      await db.tracker.put(next)
      trackerEvents.emit('change', { item: next })
      return { item: next, op: 'merged' as AddOp }
    }
    const item: TrackedItem = {
      id: nanoid(12),
      createdAt: now,
      updatedAt: now,
      what,
      kind: d.kind,
      due: d.due,
      dueAllDay: d.dueAllDay,
      remindAt: d.remindAt,
      who: d.who ? speakable(d.who, 60) : undefined,
      source: { ...d.source, label: speakable(d.source.label, 80) || d.source.type },
      status: d.status ?? 'open',
      flags: d.flags && (d.flags.careful || d.flags.newSender) ? d.flags : undefined,
      key,
      gtask: d.gtask,
      memoryId: d.memoryId,
    }
    await db.tracker.put(item)
    await trim(now)
    trackerEvents.emit('change', { item, added: true })
    return { item, op: 'added' as AddOp }
  })
}

function mergeFlags(a: TrackedItem['flags'], b: TrackedItem['flags']): TrackedItem['flags'] {
  if (!a && !b) return undefined
  // once careful, always careful: a later clean copy never clears a flag
  return { careful: !!(a?.careful || b?.careful) || undefined, newSender: !!(a?.newSender || b?.newSender) || undefined, why: a?.why ?? b?.why }
}

export function updateItem(id: string, patch: Partial<Omit<TrackedItem, 'id' | 'createdAt'>>, now = Date.now()): Promise<TrackedItem | undefined> {
  return serial(async () => {
    const cur = await db.tracker.get(id)
    if (!cur) return undefined
    const next: TrackedItem = { ...cur, ...patch, updatedAt: now }
    if (patch.what !== undefined) {
      next.what = speakable(patch.what, 160) || cur.what
      next.key = itemKey(next.source, next.what)
    }
    await db.tracker.put(next)
    trackerEvents.emit('change', { item: next })
    return next
  })
}

export function markDone(id: string, by: TrackedItem['doneBy'], now = Date.now()): Promise<TrackedItem | undefined> {
  return updateItem(id, { status: 'done', doneAt: now, doneBy: by, suggestDone: undefined, snoozedUntil: undefined }, now)
}
export function reopen(id: string, now = Date.now()): Promise<TrackedItem | undefined> {
  return updateItem(id, { status: 'open', doneAt: undefined, doneBy: undefined, snoozedUntil: undefined }, now)
}
export function snooze(id: string, until: number, now = Date.now()): Promise<TrackedItem | undefined> {
  return updateItem(id, { status: 'snoozed', snoozedUntil: until }, now)
}
export function dismiss(id: string, now = Date.now()): Promise<TrackedItem | undefined> {
  return updateItem(id, { status: 'dismissed', suggestDone: undefined }, now)
}

export function removeItems(ids: string[]): Promise<void> {
  return serial(async () => {
    await db.tracker.bulkDelete(ids)
    trackerEvents.emit('change', { removed: ids })
  })
}

/** Records that the hosts brought items up (the bound on mentions reads this). */
export function noteMentioned(ids: string[], now = Date.now()): Promise<void> {
  return serial(async () => {
    const rows = (await db.tracker.bulkGet(ids)).filter(Boolean) as TrackedItem[]
    if (!rows.length) return
    // not an edit by anyone: updatedAt stays, so a mention never wins a sync merge over a real change
    await db.tracker.bulkPut(rows.map((r) => ({ ...r, mentions: { count: (r.mentions?.count ?? 0) + 1, lastAt: now } })))
  })
}

/** Old done/dismissed items fade out; open items stay within MAX_OPEN (undated outside items go first). */
export async function trim(now = Date.now()): Promise<string[]> {
  const rows = await db.tracker.toArray()
  const drop = rows.filter((i) => (i.status === 'done' || i.status === 'dismissed') && now - (i.doneAt ?? i.updatedAt) > KEEP_MS).map((i) => i.id)
  const open = rows.filter((i) => i.status !== 'done' && i.status !== 'dismissed')
  if (open.length > MAX_OPEN) {
    const extra = open
      .filter((i) => i.source.type !== 'you' && !i.gtask)
      .sort((a, b) => (a.due ? 1 : 0) - (b.due ? 1 : 0) || a.updatedAt - b.updatedAt)
      .slice(0, open.length - MAX_OPEN)
    drop.push(...extra.map((i) => i.id))
  }
  if (drop.length) {
    await db.tracker.bulkDelete(drop)
    trackerEvents.emit('change', { removed: drop })
  }
  return drop
}

/** Items to show in the list: open, snoozed, and done in the last week. */
export function visible(items: TrackedItem[], now = Date.now()): TrackedItem[] {
  return items.filter((i) => i.status !== 'dismissed' && !(i.status === 'done' && now - (i.doneAt ?? i.updatedAt) > DONE_VISIBLE_MS))
}
