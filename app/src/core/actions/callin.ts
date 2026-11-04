// The scripted fallback's reader (no AI brain) for a call-in or a note from the listener's AI app, and the words
// every path shares (the read-back, the done and failed lines, written by code so every brain says the same resolved
// date and time). With an AI brain the hosts' agent decides instead (agent/kit, docs/AGENT.md).
// 1. a proposal is waiting and they said a plain yes / no -> done (with the one-time token) / dropped;
// 2. their words are about Your list ("remind me to ...", "I sent the quotes") -> done now (their own space).
import { getSettings } from '../db'
import { kvGet, kvSet } from '../db/kv'
import { integrations } from '../api/endpoints'
import { api } from '../api/client'
import { cached } from '../context/cache'
import type { CalendarEvent, TrackedItem } from '../types'
import { addItem, allItems, markDone, openItems, updateItem } from '../tracker/store'
import { clearListAsk, lastListAsk } from '../tracker/brief'
import { matchDone, parseTrackerCommand } from '../tracker/commands'
import { canAct, cancelAction, classifyAnswer, confirmAndRun, pendingAction, propose, type ProposeProblem } from './engine'
import type { ActionRecord, ConfirmVia, ServerActionType } from './types'
import { spokenDate, spokenTime, wallAt, zoneNote, type WhenContext } from './when'

export interface ActionTurn {
  kind: 'asked' | 'done' | 'failed' | 'cancelled' | 'expired' | 'added' | 'closed' | 'refused' | 'needs' | 'problem' | 'held'
  /** FACTS line for the model: what happened, so it never contradicts the last line */
  fact: string
  /** the exact last line, spoken by the lead host (code-authored) */
  line: string
  action?: ActionRecord
  item?: TrackedItem
}

const INVITES_TTL = 10 * 60_000

function whenCtx(now = Date.now()): WhenContext {
  let tz = 'UTC'
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    /* keep UTC */
  }
  return { now: new Date(now), tz }
}

const GOOGLE_TZ = 'actions:google-tz'
const GOOGLE_TZ_TTL = 24 * 3600_000

/** The Google Calendar for the next two weeks (kept 10 minutes): invitations, and the listener's own events. */
export async function invites(): Promise<CalendarEvent[]> {
  const settings = await getSettings()
  if (!settings.connections.calendar?.google || !api.available || !api.signedIn) return []
  // two weeks ahead: an invitation is often for next week (the radio's own calendar window is shorter)
  const c = await cached('actions:invites', INVITES_TTL, async () => {
    const r = await integrations.calendar(14 * 24)
    // the Google Calendar's own time zone comes along (kept a day): a read-back in another zone says so
    if (r.timeZone) await kvSet(GOOGLE_TZ, { tz: r.timeZone, at: Date.now() }).catch(() => undefined)
    return r.events
  }).catch(() => undefined)
  return (c?.value as CalendarEvent[] | undefined) ?? []
}

/** The Google Calendar's own time zone (its primary calendar), fetched once and kept a day; undefined = unknown. */
export async function googleZone(now = Date.now()): Promise<string | undefined> {
  const hit = (await kvGet<{ tz?: string; at: number }>(GOOGLE_TZ).catch(() => undefined))?.value
  if (hit && now - hit.at < GOOGLE_TZ_TTL) return hit.tz
  await invites().catch(() => undefined)
  return (await kvGet<{ tz?: string; at: number }>(GOOGLE_TZ).catch(() => undefined))?.value?.tz ?? hit?.tz
}

/** "Tuesday, November 3, from 3 PM to 4 PM" from a calendar.add payload. */
export function spokenSpan(p: { allDay?: unknown; start?: unknown; end?: unknown; timeZone?: unknown }): string {
  const tz = typeof p.timeZone === 'string' ? p.timeZone : 'UTC'
  const now = new Date().getFullYear()
  if (p.allDay && typeof p.start === 'string') {
    const [y, m, d] = p.start.split('-').map(Number)
    return `${spokenDate({ y, m, d, h: 0, mi: 0 }, now)}, all day`
  }
  const s = Date.parse(String(p.start))
  const e = Date.parse(String(p.end))
  if (Number.isNaN(s)) return ''
  const a = wallAt(s, tz)
  const b = wallAt(e, tz)
  return `${spokenDate(a, now)}, from ${spokenTime(a.h, a.mi)} to ${spokenTime(b.h, b.mi)}`
}

function quoted(summary: string): string | undefined {
  return summary.match(/"([^"]{1,120})"/)?.[1]
}

/** The line that asks: exactly what will happen (the server's own words for the checked payload), then the question. */
/** `calendarTz`: the Google Calendar's own zone; a time in another zone is said in both (never a silent mismatch). */
export function askLine(a: ActionRecord, calendarTz?: string): string {
  // level 3 says who will see it (once: the server's summary may already say it)
  const others = a.others ?? 'The organizer will see your answer.'
  const extra = a.level === 3 && !a.summary.includes(others.replace(/\.$/, '')) ? ` ${others}` : ''
  const zone = a.type === 'calendar.add' ? zoneNote(a.payload, calendarTz) : ''
  return `Just to check: ${a.summary}${extra}${zone ? ` ${zone}` : ''} Should I go ahead? Just say yes or no.`
}

export function doneLine(a: ActionRecord, calendarTz?: string): string {
  const title = String(a.payload.title ?? quoted(a.summary) ?? 'it')
  switch (a.type) {
    case 'calendar.add': {
      const zone = zoneNote(a.payload, calendarTz)
      return `Done. ${title} is on your Google Calendar for ${spokenSpan(a.payload)}.${zone ? ` ${zone}` : ''}`
    }
    case 'task.add':
      return `Done. ${title} is in your Google Tasks.`
    case 'task.complete':
      return `Done. ${title} is marked complete in Google Tasks too.`
    case 'task.edit':
      return `Done. I updated ${title} in Google Tasks.`
    case 'task.delete':
      return `Done. ${title} is deleted from your Google Tasks.`
    case 'task.move':
      return `Done. I moved ${title} to your other list.`
    case 'calendar.update':
      return `Done. I changed ${quoted(a.summary) ?? 'the event'} on your Google Calendar.${a.level === 3 ? ' Google told your guests.' : ''}`
    case 'calendar.delete':
      return `Done. ${title} is off your Google Calendar.${a.level === 3 ? ' Google told your guests.' : ''}`
    case 'notion.add':
      return `Done. It is on your Notion page${a.result?.pageTitle ? ` "${a.result.pageTitle}"` : ''}.`
    case 'invite.respond': {
      const r = a.payload.response
      const what = quoted(a.summary) ?? 'the meeting'
      return r === 'accepted' ? `Done. I said you are going to ${what}.` : r === 'declined' ? `Done. I said you can not make it to ${what}.` : `Done. I said you might come to ${what}.`
    }
  }
}

export function failedLine(a: ActionRecord | undefined): string {
  if (!a) return 'I could not reach Host-Caster just now, so nothing changed. You can tap the card when you are back online.'
  if (a.status === 'expired') return 'That question timed out, so nothing changed. Ask me again any time.'
  const msg = a.error?.message?.replace(/—/g, ',')
  return msg ? `Sorry, that did not work: ${msg}` : 'Sorry, that did not work, so nothing changed. Try again in a minute.'
}

export function problemLine(p: ProposeProblem, service: 'calendar' | 'tasks' | 'notion' | undefined, message?: string): string {
  const what = service === 'tasks' ? 'Hosts can use my Google Tasks' : 'Hosts can add to my calendar'
  // Notion's own reasons (writes off, no page chosen, not connected) come back from the server in words
  if (service === 'notion' && p !== 'offline' && p !== 'signed-out' && p !== 'limit') return message ? `I could not add that to Notion: ${message}.` : 'I could not add that to Notion just now, so nothing changed.'
  switch (p) {
    case 'off':
      return `I can do that once you turn on "${what}" in Settings, Connections, Google.`
    case 'reconnect':
      return 'I need one more permission for that. Reconnect Google in Settings, Connections to allow this.'
    case 'offline':
      return 'I can not reach Host-Caster right now, so I can not do that.'
    case 'signed-out':
      return 'Sign in to Host-Caster and connect Google, then I can do that for you.'
    case 'limit':
      return 'I have done as much as I can for today, so not this one. Try again tomorrow.'
    case 'not-allowed':
      return 'That is something I am not allowed to do. It stays with you.'
    case 'invalid':
      return message ? `I could not set that up: ${message}` : 'I could not set that up. Try saying it a different way.'
    default:
      return 'Something went wrong, so nothing changed.'
  }
}

/** Side effects on Your list once an action is done (a Google task now mirrored, an item closed). */
async function afterDone(a: ActionRecord, itemId?: string): Promise<void> {
  if (!itemId) return
  if (a.type === 'task.add' && a.result?.taskId && a.result.listId) await updateItem(itemId, { gtask: { listId: a.result.listId, taskId: a.result.taskId } })
  if (a.type === 'task.complete' || a.type === 'invite.respond') await markDone(itemId, 'call-in')
}

// which Your list item a proposal belongs to (kept across reloads: the "yes" may come after a restart)
const ITEM_FOR = 'actions:item-for'
async function itemFor(actionId: string): Promise<string | undefined> {
  return (await kvGet<Record<string, string>>(ITEM_FOR))?.value?.[actionId]
}
export async function linkItem(actionId: string, itemId: string): Promise<void> {
  const cur = (await kvGet<Record<string, string>>(ITEM_FOR))?.value ?? {}
  const next = Object.fromEntries([...Object.entries(cur), [actionId, itemId]].slice(-50))
  await kvSet(ITEM_FOR, next)
}

/** The listener answered a waiting proposal: run it or drop it. */
async function answer(pending: ActionRecord, said: string): Promise<ActionTurn | undefined> {
  const a = classifyAnswer(said)
  if (a === 'other') return undefined
  if (a === 'no') {
    const c = await cancelAction(pending)
    return { kind: 'cancelled', fact: `ACTION: the listener said no, so nothing was done (${pending.summary}).`, line: 'Okay, I will leave that alone.', action: c }
  }
  let final: ActionRecord | undefined
  try {
    final = await confirmAndRun(pending, 'call-in')
  } catch (err) {
    // refused (the daily limit, a changed payload): say why, nothing happened
    const message = err instanceof Error && err.message ? err.message : 'it was refused'
    return { kind: 'failed', fact: 'ACTION REFUSED: nothing changed.', line: `Sorry, I could not do that: ${message.replace(/\u2014/g, ',')}`, action: pending }
  }
  if (final?.status === 'done') {
    await afterDone(final, await itemFor(final.id)).catch(() => undefined)
    const tz = final.type === 'calendar.add' ? await googleZone().catch(() => undefined) : undefined
    return { kind: 'done', fact: `ACTION DONE: ${final.summary}`, line: doneLine(final, tz), action: final }
  }
  return { kind: final?.status === 'expired' ? 'expired' : 'failed', fact: 'ACTION FAILED: nothing changed.', line: failedLine(final), action: final }
}

/** "Did you get the quotes to Dana?" / "Should I tick it off?" -> "yes" (or "I did") closes it here (their own space). */
async function answerListAsk(itemId: string, said: string, origin: 'call-in' | 'ai-app', ref: string | undefined, now: number): Promise<ActionTurn | undefined> {
  const a = classifyAnswer(said)
  const yes = a === 'yes' || /^(?:yes|yeah|yep|yup)?[, ]*(?:i did|i have|did it|done|all done|sure did|already did|it'?s done|that'?s done|got it done)\b/i.test(said.trim())
  if (!yes && a !== 'no') return undefined
  await clearListAsk()
  const item = (await allItems()).find((i) => i.id === itemId)
  if (!item || item.status === 'done') return undefined
  if (!yes) {
    await updateItem(itemId, { suggestDone: undefined }, now)
    return { kind: 'closed', fact: `YOUR LIST: "${item.what}" is still open.`, line: 'Okay, I will keep it on your list.', item }
  }
  const done = (await markDone(itemId, 'call-in', now)) ?? item
  const lead = `Great, I ticked off ${done.what}.`
  const settings = await getSettings()
  if (done.gtask && settings.connections.actions?.tasks && (await canAct('tasks')).ok) {
    const t = await askFor('task.complete', { listId: done.gtask.listId, taskId: done.gtask.taskId, title: done.what }, said, origin, ref, '', done.id)
    if (t.kind === 'asked') return { ...t, item: done, line: `${lead} Should I mark it complete in Google Tasks too? Just say yes or no.` }
  }
  return { kind: 'closed', fact: `YOUR LIST: "${done.what}" is done.`, line: lead, item: done }
}

async function askFor(type: ServerActionType, payload: Record<string, unknown>, said: string, origin: 'call-in' | 'ai-app', ref: string | undefined, lead = '', itemId?: string): Promise<ActionTurn> {
  const r = await propose(type, payload, { origin, said, ref })
  if (!r.ok) {
    const line = `${lead}${problemLine(r.problem, r.service, r.message)}`.trim()
    return { kind: 'problem', fact: `ACTION NOT POSSIBLE: ${line}`, line }
  }
  if (itemId) await linkItem(r.action.id, itemId)
  const tz = type === 'calendar.add' ? await googleZone().catch(() => undefined) : undefined
  return { kind: 'asked', fact: `ACTION WAITING FOR A YES: ${r.action.summary}`, line: `${lead}${askLine(r.action, tz)}`.trim(), action: r.action }
}

export interface ActionTurnInput {
  said: string
  origin: 'call-in' | 'ai-app'
  ref?: string
  signal?: AbortSignal
  now?: number
}

/** Everything the listener's words make the hosts do, before the answer is written; undefined = a normal call. */
export async function takeActionTurn(input: ActionTurnInput): Promise<ActionTurn | undefined> {
  const { said, origin } = input
  const now = input.now ?? Date.now()
  const ctx = whenCtx(now)
  const settings = await getSettings()

  // 1. an answer to the newest question: a waiting proposal, or a Your list question the hosts just asked
  //    (only a call-in; a message from an AI app never confirms)
  if (origin === 'call-in') {
    const pending = await pendingAction(now).catch(() => undefined)
    const ask = await lastListAsk(now).catch(() => undefined)
    if (ask && (!pending || ask.at > pending.createdAt)) {
      const t = await answerListAsk(ask.itemId, said, origin, input.ref, now)
      if (t) return t
    }
    if (pending) {
      const t = await answer(pending, said)
      if (t) return t
    }
  }

  // 2. Your list, in the listener's own words (every brain, the scripted fallback too)
  if (settings.connections.tracker?.enabled !== false) {
    const cmd = parseTrackerCommand(said, ctx)
    if (cmd?.op === 'add') {
      const source = origin === 'ai-app' ? { type: 'ai-app' as const, label: 'From your AI app' } : { type: 'you' as const, label: 'You said it on a call-in' }
      const { item, op } = await addItem({ what: cmd.what, kind: cmd.kind, due: cmd.due, dueAllDay: cmd.dueAllDay, remindAt: cmd.remindAt, source }, now)
      // an AI app's note never brings back what the listener ticked off or dismissed: say so, never "added"
      if (op === 'skipped' && item.status !== 'open') {
        const line = item.status === 'dismissed' ? `You took "${item.what}" off Your list earlier, so I left it off.` : `"${item.what}" is already ticked off on Your list.`
        return { kind: 'added', fact: `YOUR LIST: "${item.what}" was not added again (${item.status}).`, line, item }
      }
      const when = cmd.spokenDue ? (cmd.remindAt ? `, and I will remind you ${cmd.spokenDue}` : `, ${cmd.spokenDue}`) : ''
      const lead = `Added to Your list: ${item.what}${when}.`
      const tasksOn = settings.connections.actions?.tasks
      if (cmd.google || tasksOn) {
        if ((await canAct('tasks')).ok) {
          const t = await askFor('task.add', { title: item.what, ...(cmd.due ? { due: cmd.due.slice(0, 10) } : {}) }, said, origin, input.ref, `${lead} `, item.id)
          if (t.kind === 'asked') return { ...t, item, line: `${lead} Want me to put it in Google Tasks too? It would say: ${t.action!.summary} Just say yes or no.` }
          return { ...t, item }
        }
        if (cmd.google) {
          const line = `${lead} ${problemLine((await canAct('tasks')).problem ?? 'off', 'tasks')}`
          return { kind: 'problem', fact: `YOUR LIST: added "${item.what}". ${line}`, line, item }
        }
      }
      return { kind: 'added', fact: `YOUR LIST: added "${item.what}"${cmd.due ? ` (due ${cmd.due.slice(0, 10)})` : ''}. It is saved.`, line: lead, item }
    }
    if (cmd?.op === 'done') {
      const m = matchDone(cmd.words, await openItems(now))
      if (m.ambiguous) {
        const line = `Which one did you finish: ${m.ambiguous.map((i) => i.what).join(', or ')}?`
        return { kind: 'needs', fact: `YOUR LIST: more than one item fits, ask which.`, line }
      }
      if (m.item) {
        const item = (await markDone(m.item.id, 'call-in', now)) ?? m.item
        const lead = `Nice, I ticked off ${item.what}.`
        if (item.gtask && settings.connections.actions?.tasks && (await canAct('tasks')).ok && origin === 'call-in') {
          const t = await askFor('task.complete', { listId: item.gtask.listId, taskId: item.gtask.taskId, title: item.what }, said, origin, input.ref, '', item.id)
          if (t.kind === 'asked') return { ...t, item, line: `${lead} Should I mark it complete in Google Tasks too? Just say yes or no.` }
        }
        return { kind: 'closed', fact: `YOUR LIST: "${item.what}" is done.`, line: lead, item }
      }
    }
  }

  // 3. anything else the hosts do is the agent's (agent/kit, docs/AGENT.md): with an AI brain the call, the chat,
  //    the on-air call-in and the AI-app inbox run one agent turn; this reader is the scripted fallback's
  return undefined
}

/** A tap on Done for a Google task: done here at once; a card asks before it is closed in Google Tasks too. */
export async function offerGoogleDone(item: TrackedItem): Promise<ActionRecord | undefined> {
  if (!item.gtask || !(await getSettings()).connections.actions?.tasks || !(await canAct('tasks')).ok) return undefined
  const r = await propose('task.complete', { listId: item.gtask.listId, taskId: item.gtask.taskId, title: item.what }, { origin: 'app', ref: `done:${item.gtask.taskId}:${item.doneAt ?? ''}` })
  if (!r.ok) return undefined
  await linkItem(r.action.id, item.id)
  return r.action
}

/** A tap on Yes in the app: the same run as a spoken yes, with the same Your list side effects. */
export async function confirmByTap(a: ActionRecord): Promise<ActionRecord | undefined> {
  return confirmBy(a, 'tap')
}

/** The listener's yes (a tap, their words through approve_action, or "allowed without asking"): run it, then Your list. */
export async function confirmBy(a: ActionRecord, via: ConfirmVia): Promise<ActionRecord | undefined> {
  const final = await confirmAndRun(a, via)
  if (final?.status === 'done') await afterDone(final, await itemFor(final.id)).catch(() => undefined)
  return final
}

/** The FACTS line for the break that answers the call. */
export function actionFact(t: ActionTurn | undefined): string {
  return t ? t.fact : ''
}

/** The TASK sentence: the exact line is code's and comes last, the hosts only react around it. */
export function actionTask(t: ActionTurn): string {
  const waiting =
    t.kind === 'asked'
      ? 'Nothing has happened yet: the listener has not said yes. Do not say it is done, added, booked, covered or taken care of, and do not promise it. '
      : t.kind === 'done' || t.kind === 'added' || t.kind === 'closed'
        ? ''
        : 'Nothing was done. Do not say or hint that it happened. '
  return (
    `The app itself says this line, word for word, right after your lines (the first host's voice): "${t.line}" ` +
    'So never say it yourself: do not copy it, do not say it in other words, do not repeat its details and do not ask its question. ' +
    waiting +
    'Before it, react to the call in one short natural line that does not contradict it.'
  )
}

// e2e hooks (debug builds only): Your list and the actions engine, like window.__hostcaster.memory
if (typeof window !== 'undefined' && import.meta.env.VITE_HOSTCASTER_DEBUG === '1') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> }
  void Promise.all([import('../tracker/store'), import('../tracker/sync'), import('../tracker/brief'), import('./engine'), import('./when')]).then(([store, sync, brief, engine, when]) => {
    const g = (w.__hostcaster ??= {})
    g.tracker = { ...store, ...sync, ...brief }
    g.actions = { ...engine, ...when, takeActionTurn, confirmByTap }
  })
}
