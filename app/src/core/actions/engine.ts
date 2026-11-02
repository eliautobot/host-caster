// The app half of Rule 2: the AI proposes, the listener confirms, the APP acts.
// propose() sends a validated payload to the server (which checks it again and keeps it); the hosts read it back.
// Only the listener's own "yes" in a call-in (classified by code, never by a model) or a tap on the card confirms:
// confirm() gets a one-time token bound to the exact payload, execute() spends it. A double "yes" or a second device
// gets the same single action back; a network drop mid-action is retried with the same token or read back from the
// server, never sent twice.
import { api, ApiError, isOffline } from '../api/client'
import { kvGet, kvSet } from '../db/kv'
import { getSettings } from '../db'
import { createEmitter } from '../util/emitter'
import { actionsApi } from './api'
import type { ActionOrigin, ActionRecord, ActionsStatus, ServerActionType } from './types'

export interface ActionEvents {
  /** a proposal, a confirmation, a result or an undo */
  change: { action: ActionRecord }
}
export const actionEvents = createEmitter<ActionEvents>()

const PENDING_KEY = 'actions:pending'
const FINAL = new Set(['done', 'failed', 'cancelled', 'expired', 'undone', 'undo_failed'])

export type ProposeProblem = 'offline' | 'signed-out' | 'off' | 'reconnect' | 'invalid' | 'not-allowed' | 'limit' | 'error'
export type ProposeResult = { ok: true; action: ActionRecord } | { ok: false; problem: ProposeProblem; message?: string; service?: 'calendar' | 'tasks' }

let statusCache: { at: number; value: ActionsStatus } | undefined

/** What the server can do for this listener right now (scopes granted). Cached a minute. */
export async function actionsStatus(force = false): Promise<ActionsStatus | undefined> {
  if (!api.available || !api.signedIn) return undefined
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value
  try {
    statusCache = { at: Date.now(), value: await actionsApi.status() }
    return statusCache.value
  } catch {
    return statusCache?.value
  }
}

export function serviceOf(type: ServerActionType): 'calendar' | 'tasks' {
  return type.startsWith('task.') ? 'tasks' : 'calendar'
}

/** The listener turned the switch on (Settings > Connections > Google) and Google granted it. */
export async function canAct(service: 'calendar' | 'tasks'): Promise<{ ok: boolean; problem?: ProposeProblem }> {
  if (!api.available) return { ok: false, problem: 'offline' }
  if (!api.signedIn) return { ok: false, problem: 'signed-out' }
  const on = (await getSettings()).connections.actions?.[service]
  if (!on) return { ok: false, problem: 'off' }
  const st = await actionsStatus()
  if (st && !(service === 'calendar' ? st.calendarWrite : st.tasks)) return { ok: false, problem: 'reconnect' }
  return { ok: true }
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** Proposes one action. Never executes anything. */
export async function propose(
  type: ServerActionType,
  payload: Record<string, unknown>,
  opts: { origin: ActionOrigin; said?: string; ref?: string },
): Promise<ProposeResult> {
  const service = serviceOf(type)
  const can = await canAct(service)
  if (!can.ok) return { ok: false, problem: can.problem!, service }
  try {
    const { action } = await actionsApi.propose({ type, payload, origin: opts.origin, said: opts.said?.slice(0, 500), ref: opts.ref, tz: tz() })
    await setPending(action)
    actionEvents.emit('change', { action })
    return { ok: true, action }
  } catch (err) {
    return { ok: false, problem: problemOf(err), message: err instanceof ApiError ? err.message : undefined, service }
  }
}

function problemOf(err: unknown): ProposeProblem {
  if (isOffline(err)) return 'offline'
  if (!(err instanceof ApiError)) return 'error'
  if (err.code === 'scope_missing' || err.code === 'google_not_connected') return 'reconnect'
  if (err.code === 'invalid_action') return 'invalid'
  if (err.code === 'action_not_allowed') return 'not-allowed'
  if (err.code === 'proposals_limit' || err.code === 'actions_limit') return 'limit'
  if (err.status === 401) return 'signed-out'
  return 'error'
}

async function setPending(a: ActionRecord | undefined): Promise<void> {
  await kvSet(PENDING_KEY, a ? { id: a.id, expiresAt: a.expiresAt } : null)
}

/**
 * The proposal the hosts are asking about: the newest one still waiting, on this device or another one signed in
 * to the same account (the server is the truth). Expired ones never count.
 */
export async function pendingAction(now = Date.now()): Promise<ActionRecord | undefined> {
  if (!api.available || !api.signedIn) return undefined
  const local = (await kvGet<{ id: string; expiresAt: number } | null>(PENDING_KEY))?.value
  try {
    const { actions } = await actionsApi.list({ limit: 5, status: 'proposed' })
    const live = actions.filter((a) => a.status === 'proposed' && a.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt)
    if (live[0]) return live[0]
    if (local) await setPending(undefined)
    return undefined
  } catch {
    if (local && local.expiresAt > now) {
      try {
        const { action } = await actionsApi.get(local.id)
        return action.status === 'proposed' && action.expiresAt > now ? action : undefined
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFinal(id: string, ms = 30_000): Promise<ActionRecord | undefined> {
  const end = Date.now() + ms
  let last: ActionRecord | undefined
  while (Date.now() < end) {
    try {
      last = (await actionsApi.get(id)).action
      if (FINAL.has(last.status)) return last
    } catch {
      /* the network may be back in a moment */
    }
    await sleep(700)
  }
  return last
}

/**
 * The listener said yes (or tapped Yes): confirm, then execute with the one-time token. Returns the final record
 * (done or failed), or undefined when the server could not be reached at all (nothing happened).
 */
export async function confirmAndRun(action: ActionRecord, via: 'call-in' | 'tap' | 'ai-app'): Promise<ActionRecord | undefined> {
  let token: string | undefined
  let current = action
  try {
    const r = await actionsApi.confirm(action.id, { payloadHash: action.payloadHash, via })
    current = r.action
    token = r.token
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'action_expired' || err.status === 410)) {
      const gone = { ...action, status: 'expired' as const }
      actionEvents.emit('change', { action: gone })
      await setPending(undefined)
      return gone
    }
    if (isOffline(err)) return undefined
    throw err
  }
  await setPending(undefined)
  actionEvents.emit('change', { action: current })
  // another device (or a double "yes") confirmed it first: the one action is theirs, read its result
  if (!token) return FINAL.has(current.status) ? current : await waitFinal(current.id)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { action: done } = await actionsApi.execute(current.id, { token, payload: current.payload })
      actionEvents.emit('change', { action: done })
      return done
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) break // used / expired: the server has the truth
      if (err instanceof ApiError && err.status === 409) throw err // payload changed: never retried
      // network drop mid-action: did the server get it? If it is still only confirmed, the same token is retried
      await sleep(500 * (attempt + 1))
      try {
        const { action: now } = await actionsApi.get(current.id)
        if (now.status !== 'confirmed') {
          const final = FINAL.has(now.status) ? now : await waitFinal(now.id)
          if (final) actionEvents.emit('change', { action: final })
          return final
        }
      } catch {
        /* still offline: try again */
      }
    }
  }
  const final = await waitFinal(current.id, 15_000)
  if (final) actionEvents.emit('change', { action: final })
  return final
}

/** "No", "cancel", or the No button. Silence needs nothing: proposals expire on their own. */
export async function cancelAction(action: ActionRecord): Promise<ActionRecord> {
  await setPending(undefined)
  try {
    const { action: a } = await actionsApi.cancel(action.id)
    actionEvents.emit('change', { action: a })
    return a
  } catch {
    const a = { ...action, status: 'cancelled' as const }
    actionEvents.emit('change', { action: a })
    return a
  }
}

export async function undoAction(id: string): Promise<ActionRecord> {
  const { action } = await actionsApi.undo(id)
  actionEvents.emit('change', { action })
  return action
}

export async function actionHistory(limit = 50): Promise<ActionRecord[]> {
  if (!api.available || !api.signedIn) return []
  return (await actionsApi.list({ limit })).actions
}

// ---------- the listener's answer (code, never a model) ----------

// a yes is ONLY yes words and small fillers ("yeah, do it", "sure, go ahead, thanks"); anything more is not a yes
const YES_PART = "yes|yeah|yea|yep|yup|ya|sure|ok|okay|please do|do it|go ahead|go for it|confirm|confirmed|that's right|thats right|correct|sounds good|absolutely|definitely|of course|affirmative|perfect|great|right|alright|all right|please|thanks|thank you|now|it|that|then|so|oh|um|uh|i said|yes i'm sure|i'm sure"
const NO_PART = "no|nope|nah|cancel|cancel it|cancel that|don't|dont|do not|never mind|nevermind|stop|forget it|not now|skip it|leave it|negative|wait|hold on|not yet|thanks|thank you|no thanks|please|it|that|this|oh|um|uh|actually|i changed my mind|changed my mind"
const YES_RE = new RegExp(`^(?:${YES_PART})(?: (?:${YES_PART}))*$`)
const NO_RE = new RegExp(`^(?:${NO_PART})(?: (?:${NO_PART}))*$`)
const YES_START = /^(?:yes|yeah|yea|yep|yup|ya|sure|ok|okay|please do|do it|go ahead|go for it|confirm|confirmed|that's right|correct|sounds good|absolutely|definitely|of course|affirmative|perfect|alright|all right)\b/
const NO_START = /^(?:no|nope|nah|cancel|don't|do not|never ?mind|stop|forget it|not now|skip it|leave it|negative|wait|hold on|not yet|actually i changed my mind|i changed my mind)\b/

/**
 * yes = a plain yes ("yes", "yeah do it", "sure, go ahead"); no = a plain no; other = anything else (a change, a new
 * question): the proposal stays as it is and is never confirmed by it.
 */
export function classifyAnswer(said: string): 'yes' | 'no' | 'other' {
  const s = said
    .toLowerCase()
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || s.split(' ').length > 10) return 'other'
  if (NO_START.test(s) && NO_RE.test(s)) return 'no'
  if (YES_START.test(s) && YES_RE.test(s)) return 'yes'
  return 'other'
}
