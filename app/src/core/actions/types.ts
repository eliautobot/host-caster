// The fixed list of things the hosts can do (Rule 2: the AI proposes, the listener confirms, the APP acts).
// Level 1 = the listener's own space, no confirmation (only from their own words): Your list, app reminders, Notion.
// Level 2 = asks first, only their accounts. Level 3 = asks first and reads back exactly, other people will see it.
// Anything else (payments, purchases, mail, sharing, inviting people, other people's events) does not exist here.

export type ServerActionType =
  | 'calendar.add'
  | 'calendar.update'
  | 'calendar.delete'
  | 'task.add'
  | 'task.complete'
  | 'task.edit'
  | 'task.delete'
  | 'task.move'
  | 'invite.respond'
  | 'notion.add'
export type LocalActionType = 'list.add' | 'reminder.add'
export type ActionType = ServerActionType | LocalActionType

export const LEVEL: Record<ActionType, 1 | 2 | 3> = {
  'list.add': 1,
  'reminder.add': 1,
  'calendar.add': 2,
  // 3 when the event has guests (the server decides from Google's answer)
  'calendar.update': 2,
  'calendar.delete': 2,
  'task.add': 2,
  'task.complete': 2,
  'task.edit': 2,
  'task.delete': 2,
  'task.move': 2,
  'invite.respond': 3,
  'notion.add': 2,
}

export const SERVER_TYPES: readonly ServerActionType[] = ['calendar.add', 'calendar.update', 'calendar.delete', 'task.add', 'task.complete', 'task.edit', 'task.delete', 'task.move', 'invite.respond', 'notion.add']

export interface CalendarAddPayload {
  title: string
  allDay: boolean
  start: string
  end: string
  timeZone: string
  location?: string
  notes?: string
}
export interface TaskAddPayload {
  title: string
  notes?: string
  due?: string
  listId?: string
}
export interface TaskCompletePayload {
  listId: string
  taskId: string
  title: string
}
export interface TaskEditPayload {
  listId: string
  taskId: string
  title?: string
  due?: string | null
  notes?: string
}
export type RsvpAnswer = 'accepted' | 'declined' | 'tentative'
export interface InviteRespondPayload {
  calendarId: string
  eventId: string
  response: RsvpAnswer
  note?: string
}

export type PayloadOf<T extends ServerActionType> = T extends 'calendar.add'
  ? CalendarAddPayload
  : T extends 'task.add'
    ? TaskAddPayload
    : T extends 'task.complete'
      ? TaskCompletePayload
      : T extends 'task.edit'
        ? TaskEditPayload
        : InviteRespondPayload

export type ActionOrigin = 'call-in' | 'call' | 'chat' | 'ai-app' | 'app'
/** who confirmed: the listener's yes (call-in, call, chat), a tap, or their "allowed without asking" (auto, level 2) */
export type ConfirmVia = 'call-in' | 'call' | 'chat' | 'tap' | 'auto'
export type ActionStatus = 'proposed' | 'confirmed' | 'executing' | 'done' | 'failed' | 'cancelled' | 'expired' | 'undone' | 'undo_failed'

/** What the server keeps and returns (see .work/ag4-spec.md). */
export interface ActionRecord {
  id: string
  type: ServerActionType
  level: 1 | 2 | 3
  origin: ActionOrigin
  status: ActionStatus
  /** exactly what will happen, in plain words (the card and the read-back) */
  summary: string
  /** level 3: who will see it ("Dana Reyes, the organizer, will see your answer") */
  others?: string
  payload: Record<string, unknown>
  payloadHash: string
  createdAt: number
  expiresAt: number
  confirmedAt?: number
  confirmedVia?: ConfirmVia
  executedAt?: number
  result?: { link?: string; eventId?: string; taskId?: string; listId?: string; pageTitle?: string }
  error?: { code: string; message: string }
  undoable: boolean
  undoneAt?: number
}

export interface ActionsStatus {
  calendarWrite: boolean
  tasks: boolean
  caps?: { perDay: number; proposalsPerDay: number }
  used?: number
}
