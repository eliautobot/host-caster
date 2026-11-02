// Keeps Your list up to date from what the radio already reads (after each break is prepared, in the background):
// events, mail, Notion pages and the research desk's dossiers (extract.ts), later mail that suggests an item is done,
// and the listener's Google Tasks (two-way: done there = done here; done here = done there only after they say yes).
import { api } from '../api/client'
import { db } from '../db/db'
import { similarity } from '../memory/text'
import { kvGet, kvSet } from '../db/kv'
import { getSettings } from '../db'
import { latestDossiers } from '../agent/research'
import { getNotionPages } from '../context/notion'
import { trackerApi, type GoogleTask } from './api'
import type { ContextPacket, TrackedItem } from '../types'
import { doneEvidence, extractItems } from './extract'
import { addItem, allItems, markDone, openItems, updateItem } from './store'
import { subscribedPrepIds } from './owned'

const KNOWN_KEY = 'tracker:known-senders'
const KNOWN_TTL = 7 * 24 * 3600_000
const TASKS_KEY = 'tracker:gtasks-at'
const TASKS_EVERY_MS = 10 * 60_000

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** sender -> the listener emailed them before (Gmail sent mail), cached a week. Unknown = treated as new. */
export async function knownSenders(addresses: string[], now = Date.now()): Promise<Record<string, boolean>> {
  const cache = (await kvGet<Record<string, { known: boolean; at: number }>>(KNOWN_KEY))?.value ?? {}
  const want = [...new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean))]
  const missing = want.filter((a) => !cache[a] || now - cache[a].at > KNOWN_TTL)
  if (missing.length && api.available && api.signedIn) {
    try {
      const { known } = await trackerApi.knownSenders(missing.slice(0, 40))
      for (const [a, k] of Object.entries(known)) cache[a] = { known: k, at: now }
      const trimmed = Object.fromEntries(Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 500))
      await kvSet(KNOWN_KEY, trimmed)
    } catch {
      /* unknown stays unknown: flagged as new, the safe side */
    }
  }
  return Object.fromEntries(want.filter((a) => cache[a]).map((a) => [a, cache[a].known]))
}

let running: Promise<unknown> | undefined

/** Items from this break's packet (events, mail), Notion and dossiers; done suggestions; Google Tasks. */
export function trackFromPacket(packet: Pick<ContextPacket, 'calendar' | 'email'>, now = Date.now()): Promise<{ added: number; merged: number }> {
  const run = (running ?? Promise.resolve()).then(() => track(packet, now)).catch(() => ({ added: 0, merged: 0 }))
  running = run
  return run
}

async function track(packet: Pick<ContextPacket, 'calendar' | 'email'>, now: number): Promise<{ added: number; merged: number }> {
  const settings = await getSettings()
  const t = settings.connections.tracker
  if (t?.enabled === false) return { added: 0, merged: 0 }
  const calendar = packet.calendar ?? []
  const email = packet.email ?? []
  const dossiers = await latestDossiers([...calendar.map((e) => `calendar:${e.id}`), ...email.map((m) => `email:${m.id}`)]).catch(() => new Map())
  const notion = t?.fromNotion !== false && settings.connections.notion?.connected ? await getNotionPages(now).catch(() => []) : []
  const known = await knownSenders(email.map((m) => m.address ?? '').filter(Boolean), now)
  const drafts = extractItems({
    calendar,
    email,
    notion,
    dossiers,
    known,
    now,
    tz: tz(),
    from: { mail: t?.fromMail !== false, events: t?.fromEvents !== false, notion: t?.fromNotion !== false },
  })
  let added = 0
  let merged = 0
  for (const d of drafts) {
    const r = await addItem(d, now).catch(() => undefined)
    if (r?.op === 'added') added++
    if (r?.op === 'merged') merged++
  }
  for (const ev of doneEvidence(email, await openItems(now))) await updateItem(ev.itemId, { suggestDone: { why: ev.why, at: now } }, now)
  for (const id of subscribedPrepIds(await openItems(now), calendar)) await updateItem(id, { status: 'dismissed' }, now)
  await linkPlans(now).catch(() => undefined)
  await syncGoogleTasks(now).catch(() => undefined)
  return { added, merged }
}

/** Memory Plans cards link to the items they are about (read only on the memory side). */
export async function linkPlans(now = Date.now()): Promise<number> {
  const plans = (await db.memories.toArray()).filter((c) => c.kind === 'plans' && (!c.expiresAt || c.expiresAt > now))
  if (!plans.length) return 0
  let linked = 0
  for (const i of await openItems(now)) {
    if (i.memoryId || i.flags?.careful) continue
    const best = plans.map((c) => ({ c, sim: similarity(c.text, i.what) })).sort((a, b) => b.sim - a.sim)[0]
    if (best && best.sim >= 0.35) {
      await updateItem(i.id, { memoryId: best.c.id }, now)
      linked++
    }
  }
  return linked
}

/** Reads the listener's open Google tasks into Your list (the chosen lists; none chosen = all). */
export async function syncGoogleTasks(now = Date.now(), force = false): Promise<{ added: number; closed: number } | undefined> {
  const settings = await getSettings()
  if (!settings.connections.actions?.tasks || !api.available || !api.signedIn) return undefined
  const last = (await kvGet<number>(TASKS_KEY))?.value ?? 0
  if (!force && now - last < TASKS_EVERY_MS) return undefined
  const st = await trackerApi.status().catch(() => undefined)
  if (st && !st.tasks) return undefined
  await kvSet(TASKS_KEY, now)
  const { lists, tasks } = await trackerApi.tasks()
  return applyGoogleTasks(tasks, lists, settings.connections.actions.taskLists, now)
}

/** Pure-ish merge of Google tasks into Your list (exported for tests). */
export async function applyGoogleTasks(
  tasks: GoogleTask[],
  lists: { id: string; title: string }[],
  chosen: string[] | undefined,
  now = Date.now(),
): Promise<{ added: number; closed: number }> {
  const use = new Set(chosen?.length ? chosen : lists.map((l) => l.id))
  const titleOf = new Map(lists.map((l) => [l.id, l.title]))
  const items = await allItems()
  const byTask = new Map(items.filter((i) => i.gtask).map((i) => [i.gtask!.taskId, i]))
  let added = 0
  let closed = 0
  for (const t of tasks) {
    if (!use.has(t.listId)) continue
    const mine = byTask.get(t.id)
    if (t.status === 'completed') {
      if (mine && mine.status !== 'done' && mine.status !== 'dismissed') {
        await markDone(mine.id, 'google', now)
        closed++
      }
      continue
    }
    const due = t.due?.slice(0, 10)
    if (!mine) {
      const r = await addItem(
        {
          what: t.title,
          kind: due ? 'deadline' : 'todo',
          due,
          dueAllDay: due ? true : undefined,
          source: { type: 'gtask', id: t.id, link: t.link, label: `Google Tasks: ${titleOf.get(t.listId) ?? t.listTitle ?? 'My Tasks'}` },
          gtask: { listId: t.listId, taskId: t.id },
        },
        now,
      )
      if (r.op === 'added') added++
    } else if ((mine.what !== t.title && mine.source.type === 'gtask') || (due && mine.due !== due)) {
      await updateItem(mine.id, { ...(mine.source.type === 'gtask' ? { what: t.title } : {}), ...(due ? { due, dueAllDay: true } : {}) }, now)
    }
  }
  // a task deleted in Google (gone from a list we read, not completed): it leaves Your list too
  const seen = new Set(tasks.map((t) => t.id))
  const gone = items.filter((i: TrackedItem) => i.gtask && use.has(i.gtask.listId) && !seen.has(i.gtask.taskId) && i.status !== 'done' && i.status !== 'dismissed')
  for (const i of gone) await updateItem(i.id, { status: 'dismissed' }, now)
  return { added, closed }
}
