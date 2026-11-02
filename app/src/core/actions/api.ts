// The server half of the actions engine (server/src/actions): propose -> confirm (one-time token bound to the exact
// payload) -> execute -> log -> undo.
import { request } from '../api/client'
import type { ActionOrigin, ActionRecord, ActionsStatus, ServerActionType } from './types'
import type { GoogleTask } from '../tracker/api'

export type { GoogleTask } from '../tracker/api'

const T = { timeoutMs: 20_000 }

export const actionsApi = {
  status: () => request<ActionsStatus>('GET', '/api/actions/status'),
  propose: (body: { type: ServerActionType; payload: Record<string, unknown>; origin: ActionOrigin; said?: string; ref?: string; tz?: string }) =>
    request<{ action: ActionRecord }>('POST', '/api/actions/propose', body, T),
  confirm: (id: string, body: { payloadHash: string; via: 'call-in' | 'tap' | 'ai-app' }) =>
    request<{ action: ActionRecord; token?: string }>('POST', `/api/actions/${encodeURIComponent(id)}/confirm`, body, T),
  execute: (id: string, body: { token: string; payload: Record<string, unknown> }) =>
    request<{ action: ActionRecord }>('POST', `/api/actions/${encodeURIComponent(id)}/execute`, body, { timeoutMs: 45_000 }),
  get: (id: string) => request<{ action: ActionRecord }>('GET', `/api/actions/${encodeURIComponent(id)}`, undefined, T),
  list: (q: { limit?: number; status?: string } = {}) =>
    request<{ actions: ActionRecord[] }>('GET', `/api/actions?limit=${q.limit ?? 50}${q.status ? `&status=${encodeURIComponent(q.status)}` : ''}`, undefined, T),
  cancel: (id: string) => request<{ action: ActionRecord }>('POST', `/api/actions/${encodeURIComponent(id)}/cancel`, {}, T),
  undo: (id: string) => request<{ action: ActionRecord }>('POST', `/api/actions/${encodeURIComponent(id)}/undo`, {}, { timeoutMs: 45_000 }),
  tasks: () => request<{ lists: { id: string; title: string }[]; tasks: GoogleTask[] }>('GET', '/api/google/tasks', undefined, T),
  knownSenders: (emails: string[]) => request<{ known: Record<string, boolean> }>('POST', '/api/google/known-senders', { emails }, T),
}
