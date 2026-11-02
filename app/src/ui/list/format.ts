// Plain words for Your list and the actions cards (pure, tested in format.test.ts).
import type { ActionRecord } from '@/core/actions';
import type { TrackedItem, TrackedKind } from '@/core/types';

const DAY = 86_400_000;

export const KIND_LABEL: Record<TrackedKind, string> = {
  todo: 'To do',
  waiting: 'Waiting',
  deadline: 'Deadline',
  bill: 'Bill',
  delivery: 'Delivery',
  invite: 'Invitation',
  prepare: 'To prepare',
};

export type ListFilter = 'all' | 'todo' | 'waiting' | 'deadline' | 'bill' | 'invite' | 'done';

export const FILTERS: { value: ListFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'todo', label: 'To do' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'deadline', label: 'Deadlines' },
  { value: 'bill', label: 'Bills' },
  { value: 'invite', label: 'Invitations' },
  { value: 'done', label: 'Done' },
];

const FILTER_KINDS: Record<Exclude<ListFilter, 'all' | 'done'>, TrackedKind[]> = {
  todo: ['todo', 'prepare'],
  waiting: ['waiting', 'delivery'],
  deadline: ['deadline'],
  bill: ['bill'],
  invite: ['invite'],
};

/** Items a filter shows: everything not done (snoozed last), or only the done ones. */
export function applyFilter(items: TrackedItem[], f: ListFilter): TrackedItem[] {
  if (f === 'done') return items.filter((i) => i.status === 'done').sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt));
  const live = items.filter((i) => i.status === 'open' || i.status === 'snoozed');
  return f === 'all' ? live : live.filter((i) => FILTER_KINDS[f].includes(i.kind));
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

function dayWords(ms: number, now: number): string {
  const diff = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function timeWords(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
}

/** "Today", "Tomorrow, 3 PM", "Fri, Nov 6", or "Overdue: Fri, Oct 30" (overdue = shown in red). */
export function dueLabel(i: Pick<TrackedItem, 'due' | 'remindAt' | 'status'>, now = Date.now()): { text: string; overdue: boolean } | undefined {
  let ms: number | undefined;
  let timed = false;
  if (i.remindAt) {
    ms = i.remindAt;
    timed = true;
  } else if (i.due && /^\d{4}-\d{2}-\d{2}$/.test(i.due)) {
    const [y, m, d] = i.due.split('-').map(Number);
    ms = new Date(y!, m! - 1, d!).getTime();
  } else if (i.due) {
    const t = Date.parse(i.due);
    if (Number.isNaN(t)) return undefined;
    ms = t;
    timed = true;
  }
  if (ms === undefined) return undefined;
  const words = dayWords(ms, now);
  const text = timed ? `${words}, ${timeWords(ms)}` : words;
  const overdue = i.status !== 'done' && (timed ? ms < now : startOfDay(ms) < startOfDay(now));
  if (overdue) return { text: `Overdue: ${text.replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}`, overdue: true };
  return { text: i.remindAt ? `Reminder ${text.replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}` : text, overdue: false };
}

/** When a snoozed item comes back, in a few words ("tomorrow, 9 AM"). */
export function untilWords(ms: number, now = Date.now()): string {
  const words = dayWords(ms, now);
  return `${/^(Today|Tomorrow|Yesterday)$/.test(words) ? words.toLowerCase() : words}, ${timeWords(ms)}`;
}

/** Snooze choices: in 3 hours (when that is still today), tomorrow at 9, next Monday at 9. */
export function snoozeChoices(now = Date.now()): { label: string; until: number }[] {
  const d = new Date(now);
  const out: { label: string; until: number }[] = [];
  const later = Math.ceil((now + 3 * 3_600_000) / 900_000) * 900_000;
  if (startOfDay(later) === startOfDay(now)) out.push({ label: 'Later today', until: later });
  out.push({ label: 'Tomorrow', until: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9).getTime() });
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  out.push({ label: 'Next week', until: new Date(d.getFullYear(), d.getMonth(), d.getDate() + toMonday, 9).getTime() });
  return out;
}

/** "Waiting on Dana", "With Dana Reyes" (to-dos), "From Northwind Billing" (bills, invitations, deadlines) */
export function whoLine(i: Pick<TrackedItem, 'who' | 'kind'>): string | undefined {
  if (!i.who) return undefined;
  if (i.kind === 'waiting') return `Waiting on ${i.who}`;
  if (i.kind === 'todo' || i.kind === 'prepare') return `With ${i.who}`;
  return `From ${i.who}`;
}

/** What the open-source button says, by where the item came from. */
export function openLabel(i: Pick<TrackedItem, 'source'>): string {
  switch (i.source.type) {
    case 'email':
      return 'Open the email';
    case 'event':
      return 'Open in Google Calendar';
    case 'notion':
      return 'Open in Notion';
    case 'gtask':
      return 'Open in Google Tasks';
    default:
      return 'Open';
  }
}

/** "4:59", "0:07" (never below 0:00) */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** No em dashes anywhere in what the listener reads. */
export const plain = (s: string): string => s.replace(/\s*[\u2014\u2013]\s*/g, ', ');

/** One status line for the actions history. */
export function statusLine(a: Pick<ActionRecord, 'status' | 'error'>): { text: string; tone: 'ok' | 'danger' | 'neutral' | 'warm' } {
  const why = a.error?.message ? plain(a.error.message).replace(/\.$/, '') : '';
  switch (a.status) {
    case 'done':
      return { text: 'Done', tone: 'ok' };
    case 'undo_failed':
      return { text: why ? `Done (could not undo: ${why})` : 'Done (could not undo)', tone: 'ok' };
    case 'failed':
      return { text: why ? `Not done: ${why}` : 'Not done', tone: 'danger' };
    case 'undone':
      return { text: 'Undone', tone: 'neutral' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'neutral' };
    case 'expired':
      return { text: 'Expired', tone: 'neutral' };
    case 'proposed':
      return { text: 'Waiting for your answer', tone: 'warm' };
    default:
      return { text: 'Working on it', tone: 'warm' };
  }
}

/** Undo is offered for done, undoable actions up to 7 days old. */
export function canUndo(a: Pick<ActionRecord, 'status' | 'undoable' | 'executedAt' | 'createdAt'>, now = Date.now()): boolean {
  return a.status === 'done' && a.undoable && now - (a.executedAt ?? a.createdAt) < 7 * DAY;
}
