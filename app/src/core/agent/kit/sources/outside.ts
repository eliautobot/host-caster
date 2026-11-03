// Tools that change another account (outside-write): Google Tasks, Google Calendar, invitations, Notion. Google
// changes never run from the model: the tool sends the payload to the actions engine (the server checks it again and
// writes the summary), the reply ends with code's exact read-back, and only the listener's yes or tap runs it
// (approval.ts). "Allowed without asking" (auto, level 2) confirms at once, only in a listener turn.
import { confirmBy, doneLine, failedLine, invites, linkItem, problemLine } from '../../../actions/callin';
import { allItems } from '../../../tracker/store';
import { propose } from '../../../actions/engine';
import type { ActionOrigin, ActionRecord, ServerActionType } from '../../../actions/types';
import { answerFromWords, inviteChoices } from '../../../actions/understand';
import { getEmail } from '../../../context/sources';
import { getSettings } from '../../../db';
import { heldInvite, heldLine, pickHeld, type HeldInvite } from '../../../tracker/held';
import type { EmailSummary } from '../../../types';
import { sendAsk } from '../../../radio/notionWrite';
import type { CalendarEvent } from '../../../types';
import { isListenerTurn, OK, off, type AgentTool, type Policy, type RunInfo, type ToolRun } from '../types';
import { cleanTitle } from '../../../actions/title';
import { tidyWhat } from '../../../tracker/commands';
import { isoWithOffset, wallAt, zonedToUtc } from '../../../actions/when';
import { eventTime, dueOrRemind, whenCtx } from '../when';
import { findList, findTask, forgetGoogleTasks, googleTasks, pick } from './gtasks';
import { ASKED_NOT_ORDERED, askedNotOrdered, contentWords, FIX, grounded, mentioned, needGoogle, needServer, NOT_GROUNDED, NOT_NAMED, str, tooManyAsks } from './needs';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const s = (description: string) => ({ type: 'string', description });
const fail = (message: string, what: string): ToolRun => ({ ok: false, content: { error: message }, what });

export const READ_BACK_NOTE =
  'NOT DONE YET. The app reads read_back to the listener word for word right after your reply and waits for their yes. Do not repeat it, do not say it is done, do not ask the question yourself. If they asked for more in this turn (a reminder, a second change), do that now with its tool.';

const originOf = (run: RunInfo): ActionOrigin => (run.env.turn === 'ai-app' ? 'ai-app' : run.env.turn === 'chat' ? 'chat' : run.env.turn === 'call' ? 'call' : 'call-in');

/** The result of a run (approved now, or "allowed without asking"): code's own done or failed words. */
export function ranRun(final: ActionRecord | undefined, fallback: ActionRecord): ToolRun {
  const a = final ?? fallback;
  const done = final?.status === 'done';
  return {
    ok: done,
    content: { status: done ? 'done' : (final?.status ?? 'not_reached'), said: done ? doneLine(a) : failedLine(final) },
    what: `${done ? 'Done' : 'Not done'}: ${a.summary.slice(0, 50)}`,
    effect: { kind: 'ran', action: final ?? { ...fallback, status: 'failed' } },
  };
}

/**
 * Proposes one action (or runs it when the listener allowed it without asking). `older`: what to do when the server
 * does not know the action type yet (an older self-hosted server).
 */
async function offer(type: ServerActionType, payload: Record<string, unknown>, run: RunInfo, policy: Policy, older?: () => Promise<ToolRun>): Promise<ToolRun> {
  if (tooManyAsks(run)) return fail('One thing at a time: ask about the rest after the listener answers the read-back.', 'Waiting (one at a time)');
  const r = await propose(type, payload, { origin: originOf(run), said: run.said });
  if (!r.ok && r.problem === 'not-allowed' && older) return older();
  if (!r.ok) return fail(`${problemLine(r.problem, r.service, r.message)} Nothing changed.`, `Not possible: ${type}`);
  if (type.startsWith('task.')) {
    forgetGoogleTasks();
    // the same thing on Your list: linked, so a done Google task is mirrored there (and closing one closes both)
    const item = await listItemFor(type, payload).catch(() => undefined);
    if (item) await linkItem(r.action.id, item).catch(() => undefined);
  }
  if (policy === 'auto' && r.action.level === 2 && isListenerTurn(run.env.turn)) return ranRun(await confirmBy(r.action, 'auto').catch(() => undefined), r.action);
  return {
    ok: true,
    content: { status: 'waiting_for_yes', action_id: r.action.id, read_back: r.action.summary, note: READ_BACK_NOTE },
    what: `Asked: ${r.action.summary.slice(0, 60)}`,
    effect: { kind: 'asked', action: r.action },
  };
}

/** The Your list item a Google task action is about: its mirror (complete), or the open item with the same words (add). */
async function listItemFor(type: ServerActionType, payload: Record<string, unknown>): Promise<string | undefined> {
  const items = await allItems();
  if (type === 'task.add') return items.find((i) => i.status === 'open' && !i.gtask && i.what.toLowerCase() === String(payload.title ?? '').toLowerCase())?.id;
  if (type === 'task.complete') return items.find((i) => i.gtask?.taskId === payload.taskId)?.id;
  return undefined;
}

/** A tool that offers one Google action; `build` turns the model's arguments into the payload (or a problem). */
function googleTool(
  def: Omit<AgentTool, 'kind' | 'available' | 'run' | 'group'> & { service: 'calendar' | 'tasks'; type: ServerActionType },
  build: (args: Record<string, unknown>, run: RunInfo) => Promise<Record<string, unknown> | ToolRun>,
): AgentTool {
  const { service, type, ...rest } = def;
  return {
    ...rest,
    group: service === 'tasks' ? 'Google Tasks' : 'Google Calendar',
    kind: 'outside-write',
    available: (env) => needGoogle(env, service),
    async run(args, run) {
      const p = await build(args, run);
      return isRun(p) ? p : offer(type, p, run, run.policy);
    },
  };
}

// ---- Google Tasks -----------------------------------------------------------------------------------------------

async function taskRef(ref: unknown, run: RunInfo): Promise<{ listId: string; taskId: string; title: string } | ToolRun> {
  const r = str(ref, 200);
  if (!r) return fail('Say which task (its task_id from google_tasks, or its words).', 'Google Tasks (which task?)');
  const { tasks } = await googleTasks();
  const f = findTask(r, tasks);
  if ('one' in f) {
    if (!mentioned(f.one.title, run.heard)) return fail(NOT_NAMED, 'Google Tasks (not named)');
    // what they said in this turn fits another open task as well: they have to say which ("the call the bank task")
    if (mentioned(f.one.title, run.said)) {
      const fit = (t: string) => contentWords(t).filter((w) => contentWords(run.said).includes(w)).length;
      const mine = fit(f.one.title);
      const rivals = tasks.filter((t) => t.id !== f.one.id && t.status !== 'completed' && fit(t.title) >= mine);
      if (rivals.length) return fail(`What the listener said fits more than one task: "${f.one.title}", ${rivals.slice(0, 4).map((t) => `"${t.title}"`).join(', ')}. Ask which one. Nothing changed.`, 'Google Tasks (which task?)');
    }
    return { listId: f.one.listId, taskId: f.one.id, title: f.one.title };
  }
  if ('many' in f) return fail(`More than one task fits: ${f.many.map((t) => `"${t.title}" (${t.listTitle ?? 'list'})`).join(', ')}. Ask which one.`, 'Google Tasks (which task?)');
  const some = tasks.filter((t) => t.status !== 'completed').slice(0, 8).map((t) => `"${t.title}" (${t.id})`);
  return fail(`No open Google task matches "${r}".${some.length ? ` Some open tasks: ${some.join(', ')}.` : ''} Use one of these, read them all with google_tasks, or ask which one.`, 'Google Tasks (not found)');
}

async function listRef(ref: unknown): Promise<string | ToolRun | undefined> {
  const r = str(ref, 100);
  if (!r) return undefined;
  const { lists } = await googleTasks();
  const f = findList(r, lists);
  if ('one' in f) return f.one.id;
  return fail(`There is no Google Tasks list called "${r}". The lists are: ${lists.map((l) => l.title).join(', ')}.`, 'Google Tasks (which list?)');
}

const isRun = (v: unknown): v is ToolRun => typeof v === 'object' && v !== null && 'content' in v && 'what' in v;

function dueArg(v: unknown): { due?: string } | ToolRun {
  const w = str(v, 80);
  if (!w) return {};
  const d = dueOrRemind(w, whenCtx());
  if ('error' in d) return fail(`${d.error} Nothing changed; ask for the day.`, 'Google Tasks (no day)');
  return { due: d.due.slice(0, 10) };
}

const taskArg = s('the task_id from google_tasks, or the task\'s words');

const taskTools: AgentTool[] = [
  googleTool(
    {
      name: 'google_task_add',
      title: 'Add a Google task',
      keywords: ['add', 'task', 'tasks', 'google', 'to do', 'todo', 'buy', 'remind'],
      core: true,
      service: 'tasks',
      type: 'task.add',
      description: "Add a task to the listener's Google Tasks (asks first). Use the listener's words.",
      parameters: obj({ title: s("the task, in the listener's words"), due: s('a due day ("Friday"); optional'), notes: s('optional'), list: s('a list name; optional (default: their first list)') }, ['title']),
      level: 2,
    },
    async (args, run) => {
      if (askedNotOrdered(run, str(args.title, 200))) return fail(ASKED_NOT_ORDERED, 'Google Tasks (a question)');
      const words = cleanTitle(str(args.title, 200), run.heard, 'task');
      if (!words) return fail(NOT_GROUNDED, 'Google Tasks (not added)');
      const title = tidyWhat(words);
      const due = dueArg(args.due);
      if (isRun(due)) return due;
      const listId = await listRef(args.list);
      if (isRun(listId)) return listId;
      const notes = str(args.notes, 500);
      return { title, ...due, ...(notes && grounded(notes, run.heard) ? { notes } : {}), ...(listId ? { listId } : {}) };
    },
  ),
  googleTool(
    {
      name: 'google_task_edit',
      title: 'Change a Google task',
      keywords: ['rename', 'change', 'due', 'date', 'task', 'push', 'note'],
      core: true,
      service: 'tasks',
      type: 'task.edit',
      description: 'Rename a Google task, change or remove its due day, or replace its notes (asks first).',
      parameters: obj({ task: taskArg, title: s('new title; optional'), due: s('new due day, or "none" to remove it; optional'), notes: s('new notes; optional') }, ['task']),
      level: 2,
    },
    async (args, run) => {
      const t = await taskRef(args.task, run);
      if (isRun(t)) return t;
      const out: Record<string, unknown> = { listId: t.listId, taskId: t.taskId };
      if (str(args.title, 200)) {
        const title = cleanTitle(str(args.title, 200), run.heard, 'task');
        if (!title) return fail(NOT_GROUNDED, 'Google Tasks (not changed)');
        out.title = title;
      }
      const dueWords = str(args.due, 80);
      if (/^(none|no|remove|clear)$/i.test(dueWords)) out.due = null;
      else if (dueWords) {
        const due = dueArg(dueWords);
        if (isRun(due)) return due;
        out.due = due.due;
      }
      const notes = str(args.notes, 500);
      if (notes) out.notes = notes;
      if (Object.keys(out).length === 2) return fail('Say what to change: the title, the due day or the notes.', 'Google Tasks (nothing to change)');
      return out;
    },
  ),
  googleTool(
    {
      name: 'google_task_complete',
      title: 'Complete a Google task',
      keywords: ['done', 'did', 'finished', 'mark', 'tick', 'check off', 'completed', 'task'],
      core: true,
      service: 'tasks',
      type: 'task.complete',
      description: 'Mark a Google task as done (asks first).',
      parameters: obj({ task: taskArg }, ['task']),
      level: 2,
    },
    async (args, run) => taskRef(args.task, run),
  ),
  googleTool(
    {
      name: 'google_task_delete',
      title: 'Delete a Google task',
      keywords: ['delete', 'remove', 'dismiss', 'take off', 'drop', 'task', 'clear'],
      core: true,
      service: 'tasks',
      type: 'task.delete',
      description: 'Delete a Google task (asks first; Undo puts back a copy).',
      parameters: obj({ task: taskArg }, ['task']),
      level: 2,
    },
    async (args, run) => taskRef(args.task, run),
  ),
  googleTool(
    {
      name: 'google_task_move',
      title: 'Move a Google task to another list',
      keywords: ['move', 'list', 'another list', 'task'],
      core: true,
      service: 'tasks',
      type: 'task.move',
      description: 'Move a Google task to another of the listener\'s lists (asks first).',
      parameters: obj({ task: taskArg, to_list: s('the list name or list_id to move it to') }, ['task', 'to_list']),
      level: 2,
    },
    async (args, run) => {
      const t = await taskRef(args.task, run);
      if (isRun(t)) return t;
      const to = await listRef(args.to_list);
      if (isRun(to)) return to;
      if (!to) return fail('Say which list to move it to.', 'Google Tasks (which list?)');
      if (to === t.listId) return fail('It is already in that list.', 'Google Tasks (same list)');
      return { ...t, toListId: to };
    },
  ),
];

// ---- Google Calendar --------------------------------------------------------------------------------------------

const splitId = (id: string): { calendarId: string; eventId: string } | undefined => {
  const i = id.indexOf(':');
  if (i <= 0) return /^[A-Za-z0-9_-]{5,300}$/.test(id) ? { calendarId: 'primary', eventId: id } : undefined;
  return { calendarId: id.slice(0, i), eventId: id.slice(i + 1) };
};

/** One of the listener's own events (next two weeks) by id or words; an id from calendar_search is taken as is. */
async function eventRef(ref: unknown, run: RunInfo): Promise<{ calendarId: string; eventId: string; title?: string; at?: Pick<CalendarEvent, 'start' | 'end' | 'allDay'> } | ToolRun> {
  const r = str(ref, 300);
  if (!r) return fail('Say which event (its id from calendar_search, or its words).', 'Calendar (which event?)');
  const events = (await invites().catch(() => [] as CalendarEvent[])).filter((e) => e.source === 'google' && (e.organizerSelf || !e.attendees?.length));
  const f = pick(r, events, (e) => e.id, (e) => e.title);
  if ('one' in f) {
    if (!mentioned(f.one.title, run.heard)) return fail(NOT_NAMED, 'Calendar (not named)');
    const id = splitId(f.one.id);
    if (id) return { ...id, title: f.one.title, at: { start: f.one.start, end: f.one.end, allDay: f.one.allDay } };
  }
  if ('many' in f) return fail(`More than one event fits: ${f.many.map((e) => `"${e.title}" (${new Date(e.start).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })})`).join(', ')}. Ask which one.`, 'Calendar (which event?)');
  // an id from calendar_search (further ahead): the server checks it is the listener's own event, and its title
  const id = splitId(r);
  if (id && !/\s/.test(r)) return id;
  return fail(`None of the listener's own events in the next two weeks matches "${r}". Find it with calendar_search, or ask which one.`, 'Calendar (not found)');
}

const whenArgs = {
  start: s('when it starts: words ("Friday at 3 PM", "tomorrow") or an ISO day or time'),
  end: s('when it ends; optional'),
  minutes: { type: 'number', description: 'how long, in minutes; optional (default 60)' },
};

function timeOf(args: Record<string, unknown>): { allDay: boolean; start: string; end: string; timeZone: string } | ToolRun {
  const w = eventTime(str(args.start, 80), str(args.end, 80) || undefined, typeof args.minutes === 'number' ? args.minutes : undefined, whenCtx());
  if (!w.ok) return fail(`${w.message} Nothing changed; ask for the day and time.`, 'Calendar (time?)');
  return { allDay: w.when.allDay, start: w.when.start, end: w.when.end, timeZone: w.when.tz };
}

/**
 * "Move my dentist to Friday": a new DAY without a time (and without "all day") keeps the event's own time of day and
 * length on that day; an all-day event, a new time, or an end the listener gave are used as they are.
 */
export function sameTimeOnDay(
  when: { allDay: boolean; start: string; end: string; timeZone: string },
  at: Pick<CalendarEvent, 'start' | 'end' | 'allDay'> | undefined,
  startWords: string,
  endWords: string,
): { allDay: boolean; start: string; end: string; timeZone: string } {
  if (!when.allDay || !at || at.allDay || endWords || /\b(all[- ]?day|whole day)\b/i.test(startWords)) return when;
  const [y, m, d] = when.start.split('-').map(Number);
  if (!y || !m || !d) return when;
  const tz = when.timeZone;
  const was = wallAt(at.start, tz);
  const startMs = zonedToUtc({ y, m, d, h: was.h, mi: was.mi }, tz);
  const length = Math.max(15 * 60_000, (at.end ?? at.start + 3_600_000) - at.start);
  return { allDay: false, start: isoWithOffset(startMs, tz), end: isoWithOffset(startMs + length, tz), timeZone: tz };
}

const calendarTools: AgentTool[] = [
  googleTool(
    {
      name: 'calendar_add',
      title: 'Add an event',
      keywords: ['add', 'book', 'schedule', 'put', 'calendar', 'event', 'meeting', 'appointment', 'lunch', 'dinner'],
      core: true,
      service: 'calendar',
      type: 'calendar.add',
      description: "Put an event on the listener's Google Calendar (asks first; nobody is invited). Use the listener's words.",
      parameters: obj({ title: s("the event, in the listener's words"), ...whenArgs, location: s('optional'), notes: s('optional') }, ['title', 'start']),
      level: 2,
    },
    async (args, run) => {
      if (askedNotOrdered(run, str(args.title, 120))) return fail(ASKED_NOT_ORDERED, 'Calendar (a question)');
      const title = cleanTitle(str(args.title, 120), run.heard, 'event');
      if (!title) return fail(NOT_GROUNDED, 'Calendar (not added)');
      const when = timeOf(args);
      if (isRun(when)) return when;
      const location = str(args.location, 200);
      const notes = str(args.notes, 500);
      return { title, ...when, ...(location && grounded(location, run.heard) ? { location } : {}), ...(notes && grounded(notes, run.heard) ? { notes } : {}) };
    },
  ),
  googleTool(
    {
      name: 'calendar_update',
      title: 'Move or change an event',
      keywords: ['move', 'reschedule', 'rename', 'change', 'push', 'earlier', 'later', 'event', 'meeting', 'appointment'],
      core: true,
      service: 'calendar',
      type: 'calendar.update',
      description: "Move one of the listener's own events to another time, rename it or change its place (asks first; when it has guests, Google tells them).",
      parameters: obj({ event: s('the event id from calendar_search, or its words'), title: s('new title; optional'), ...whenArgs, start: s('new start ("Friday at 3 PM"); optional'), location: s('new place; optional') }, ['event']),
      level: 2,
    },
    async (args, run) => {
      const ev = await eventRef(args.event, run);
      if (isRun(ev)) return ev;
      const out: Record<string, unknown> = { calendarId: ev.calendarId, eventId: ev.eventId };
      if (str(args.title, 120)) {
        const title = cleanTitle(str(args.title, 120), run.heard, 'event');
        if (!title) return fail(NOT_GROUNDED, 'Calendar (not changed)');
        out.title = title;
      }
      if (str(args.start, 80)) {
        const when = timeOf(args);
        if (isRun(when)) return when;
        Object.assign(out, sameTimeOnDay(when, ev.at, str(args.start, 80), str(args.end, 80)));
      }
      const location = str(args.location, 200);
      if (location) out.location = location;
      if (Object.keys(out).length === 2) return fail('Say what to change: the time, the title or the place.', 'Calendar (nothing to change)');
      return out;
    },
  ),
  googleTool(
    {
      name: 'calendar_delete',
      title: 'Delete or cancel an event',
      keywords: ['cancel', 'delete', 'remove', 'clear', 'event', 'meeting', 'appointment'],
      core: true,
      service: 'calendar',
      type: 'calendar.delete',
      description: "Delete one of the listener's own events (asks first; when it has guests, Google tells them it is cancelled).",
      parameters: obj({ event: s('the event id from calendar_search, or its words'), title: s('its title, when you give an id') }, ['event']),
      level: 2,
    },
    async (args, run) => {
      const ev = await eventRef(args.event, run);
      if (isRun(ev)) return ev;
      const title = ev.title ?? str(args.title, 200);
      if (!ev.title && !mentioned(title, run.heard)) return fail(NOT_NAMED, 'Calendar (not named)');
      if (!title) return fail('Give the event\'s title too.', 'Calendar (title?)');
      return { calendarId: ev.calendarId, eventId: ev.eventId, title };
    },
  ),
  googleTool(
    {
      name: 'invite_answer',
      title: 'Answer an invitation',
      keywords: ['accept', 'decline', 'rsvp', 'maybe', 'invitation', 'invite', 'going', 'attend'],
      core: true,
      service: 'calendar',
      type: 'invite.respond',
      description: 'Answer an invitation someone sent the listener: yes, no or maybe. Call it when they ask: it prepares the answer and the app asks them before it is sent (the organizer sees it).',
      parameters: obj({ event: s('the invitation\'s event id, or its words'), answer: { type: 'string', enum: ['yes', 'no', 'maybe'] }, note: s("a short note to the organizer in the listener's words; optional") }, ['event', 'answer']),
      level: 3,
    },
    async (args, run) => {
      const response = { yes: 'accepted', no: 'declined', maybe: 'tentative' }[str(args.answer, 10).toLowerCase()];
      if (!response) return fail('Say the answer: yes, no or maybe.', 'Invitation (answer?)');
      // the answer is the listener's: their words say it (never an email's "accept this")
      if (answerIn(run.heard) !== response) return fail('Ask the listener whether they are going (yes, no or maybe). Nothing was answered.', 'Invitation (answer not said)');
      const calendar = await invites().catch(() => [] as CalendarEvent[]);
      const choices = inviteChoices(calendar);
      const f = pick(str(args.event, 300), choices, (c) => c.id, (c) => `${c.title} ${c.organizer ?? ''}`);
      if ('many' in f) return fail(`More than one invitation fits: ${f.many.map((c) => `"${c.title}"`).join(', ')}. Ask which one.`, 'Invitation (which?)');
      if (!('one' in f)) {
        const open = choices.slice(0, 5).map((c) => `"${c.title}"${c.organizer ? ` from ${c.organizer}` : ''} (${c.id})`);
        const held = await heldWords(run.heard, calendar);
        if (held) {
          return {
            ok: false,
            content: { status: 'not_in_calendar', note: 'The app tells the listener why, word for word, right after your reply. Do not say it yourself and do not say you cannot accept it.' },
            what: 'Invitation (held in the mail)',
            effect: { kind: 'said', line: held, fact: `INVITATION ONLY IN THE MAIL: ${held} Nothing was answered.` },
          };
        }
        return fail(
          open.length ? `No invitation matches "${str(args.event, 80)}". The open invitations are: ${open.join(', ')}. Use one of these, or ask which one.` : 'That invitation is not in the calendar, so it cannot be answered from here. Nothing was answered.',
          'Invitation (not found)',
        );
      }
      const only = choices.length === 1 && /\b(?:invit\w*|rsvp|meeting)\b/i.test(run.heard);
      if (!only && !mentioned(`${f.one.title} ${f.one.organizer ?? ''}`, run.heard)) return fail(NOT_NAMED, 'Invitation (not named)');
      const id = splitId(f.one.id);
      if (!id) return fail('That invitation cannot be answered from here.', 'Invitation (no id)');
      const note = str(args.note, 300);
      return { ...id, response, ...(note && grounded(note, run.heard) ? { note } : {}) };
    },
  ),
];

/** yes / no / maybe in the listener's words ("accept", "I can't make it", "tell Dana yes"). */
function answerIn(heard: string): string | undefined {
  const a = answerFromWords(heard);
  if (a) return a;
  const s = heard.toLowerCase();
  if (/\bmaybe\b/.test(s)) return 'tentative';
  if (/\b(?:no|nope)\b/.test(s)) return 'declined';
  if (/\b(?:yes|yeah|yep)\b/.test(s)) return 'accepted';
  return undefined;
}

/** Why an invitation is not in the calendar: Google holds one from a new sender in the mail (it says who). */
async function heldWords(heard: string, calendar: CalendarEvent[]): Promise<string | undefined> {
  const settings = await getSettings().catch(() => undefined);
  const mail = settings?.connections.email?.gmail ? await getEmail(settings.connections.email).catch(() => [] as EmailSummary[]) : [];
  const held = mail.map((m) => heldInvite(m, calendar)).filter((x): x is HeldInvite => Boolean(x));
  const p = pickHeld(heard, held);
  return p ? heldLine(p.held) : undefined;
}

// ---- Notion (append only, to the page the listener chose: allowed without asking, ask first, or off) ---------------

const notionAdd: AgentTool = {
  name: 'notion_add',
  title: 'Add to Notion',
  keywords: ['notion', 'note', 'jot', 'write down', 'page'],
  group: 'Notion',
  description: "Add a to-do or a note to the Notion page the listener picked for the hosts. Use the listener's words.",
  parameters: obj({ kind: { type: 'string', enum: ['todo', 'note'] }, text: s("the to-do or the note, in the listener's words") }, ['kind', 'text']),
  kind: 'outside-write',
  level: 2,
  defaultPolicy: 'auto',
  available(env) {
    const s0 = needServer(env);
    if (!s0.ok) return s0;
    if (!env.server?.notionLinked) return off('not-connected', FIX.notion);
    if (env.server.notionWrite === false) return off('switched-off', FIX.notionWrite);
    return OK;
  },
  async run(args, run) {
    const text = str(args.text, 400);
    if (askedNotOrdered(run, text)) return fail(ASKED_NOT_ORDERED, 'Notion (a question)');
    if (!text || !grounded(text, run.heard)) return fail(NOT_GROUNDED, 'Notion (not added)');
    const kind = args.kind === 'note' ? 'note' : 'todo';
    // the same way as Google: proposed (read back, the listener says yes), or confirmed at once when allowed without asking
    return offer('notion.add', { kind, text }, run, run.policy, async () => {
      // a server without Notion actions writes straight away, only where the listener allowed it without asking
      if (run.policy !== 'auto') return fail('This Host-Caster server cannot ask first for Notion notes yet: set "Add to Notion" to "Without asking", or update the server.', 'Notion (server too old)');
      const w = await sendAsk({ kind, text }, run.env.turn === 'ai-app' ? 'app' : 'call');
      return w.ok
        ? { ok: true, content: { status: 'added', page: w.pageTitle, text }, what: `Notion: added to ${w.pageTitle ?? 'the page'}`, effect: { kind: 'notion', write: w } }
        : fail(`Not added to Notion: ${w.problem ?? 'it did not work'}.`, 'Notion (not added)');
    });
  },
};

export function outsideTools(): AgentTool[] {
  return [...taskTools, ...calendarTools, notionAdd];
}
