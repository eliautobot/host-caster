// The read-only server calls Your list needs (Google Tasks, known senders, what is granted). Background work uses
// only these: it can not even import the calls that propose or run an action (core/actions/api.ts).
import { request } from '../api/client'
import type { ActionsStatus } from '../actions/types'

export interface GoogleTask {
  id: string
  listId: string
  listTitle?: string
  title: string
  notes?: string
  due?: string
  status: 'needsAction' | 'completed'
  completed?: string
  updated?: string
  link?: string
}

const T = { timeoutMs: 20_000 }

export const trackerApi = {
  status: () => request<ActionsStatus>('GET', '/api/actions/status', undefined, T),
  tasks: () => request<{ lists: { id: string; title: string }[]; tasks: GoogleTask[] }>('GET', '/api/google/tasks', undefined, T),
  knownSenders: (emails: string[]) => request<{ known: Record<string, boolean> }>('POST', '/api/google/known-senders', { emails }, T),
}
