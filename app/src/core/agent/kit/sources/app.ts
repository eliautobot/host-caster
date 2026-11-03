// Tools that change only Host-Caster's own data (app-write): Your list, what the hosts remember, the next song,
// and undo. They run at once in a listener turn or for the listener's own AI app, never in the background, and
// every one can be undone. Titles and memories must be made of the listener's own words (grounded).
import { addCard, allCards, deleteCards } from '../../../memory/store';
import { cardToForget, draftFromWords, type MemoryChange } from '../../../memory/commands';
import { matchDone, parseTrackerCommand, tidyWhat } from '../../../tracker/commands';
import { addItem, allItems, dismiss, markDone, openItems, snooze, updateItem } from '../../../tracker/store';
import type { TrackedItem, TrackedKind } from '../../../types';
import { actionHistory, undoAction } from '../../../actions/engine';
import type { ActionRecord } from '../../../actions/types';
import { recentChanges, recordChange, undoChange } from '../changes';
import { isListenerTurn, OK, off, type AgentTool, type RunInfo, type ToolRun } from '../types';
import { cleanTitle } from '../../../actions/title';
import { dueOrRemind, whenCtx } from '../when';
import { findTask, googleTasks, pick } from './gtasks';
import type { GoogleTask } from '../../../tracker/api';
import { ASKED_NOT_ORDERED, askedNotOrdered, grounded, needList, NOT_GROUNDED, str } from './needs';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const s = (description: string) => ({ type: 'string', description });
const KINDS: TrackedKind[] = ['todo', 'deadline', 'bill', 'waiting'];

const fail = (message: string, what: string): ToolRun => ({ ok: false, content: { error: message }, what });

/** An open item by id, else by the listener's own words ("I sent the quotes"), else the model's words; several -> ask. */
async function itemFor(ref: unknown, said = ''): Promise<{ item?: TrackedItem; problem?: ToolRun }> {
  const r = str(ref, 160);
  if (!r) return { problem: fail('Say which item (its id from my_list, or its words).', 'Your list (which item?)') };
  const open = await openItems();
  const byId = (await allItems()).find((i) => i.id === r);
  if (byId) return { item: byId };
  // the listener's own "done" words, read the way the list always read them
  const cmd = said ? parseTrackerCommand(said, whenCtx()) : undefined;
  const theirs = cmd?.op === 'done' ? matchDone(cmd.words, open) : {};
  if (theirs.item) return { item: theirs.item };
  if (theirs.ambiguous) return { problem: fail(`More than one item fits: ${theirs.ambiguous.map((i) => `"${i.what}" (${i.id})`).join(', ')}. Ask the listener which one.`, 'Your list (which item?)') };
  const f = pick(r, open, (i) => i.id, (i) => i.what);
  if ('one' in f) return { item: f.one };
  if ('many' in f) return { problem: fail(`More than one item fits: ${f.many.map((i) => `"${i.what}" (${i.id})`).join(', ')}. Ask the listener which one.`, 'Your list (which item?)') };
  // "I sent the quotes": the done words the list already understood
  const done = matchDone(r, open);
  if (done.item) return { item: done.item };
  // not on Your list, but maybe an open Google task (added there, or not imported yet): say where it really is
  const elsewhere = await openGoogleTasksLike(r);
  if (elsewhere.length) {
    const found = elsewhere.map((t) => `"${t.title}" (task id ${t.id}${t.listTitle ? `, list ${t.listTitle}` : ''})`).join(', ');
    return { problem: fail(`Nothing on Your list matches "${r}", but the listener has it in Google Tasks: ${found}. Do what they asked to that Google task with the Google Tasks tools (complete it when they did it, delete it when they want it gone).`, 'Your list (in Google Tasks)') };
  }
  return { problem: fail(`Nothing on Your list matches "${r}". Read it with my_list.`, 'Your list (not found)') };
}

/** Open Google tasks that fit the words, when Google Tasks is connected (none when it is not, or unreachable). */
async function openGoogleTasksLike(ref: string): Promise<{ id: string; title: string; listTitle?: string }[]> {
  const { tasks } = await googleTasks().catch(() => ({ tasks: [] as GoogleTask[] }));
  const f = findTask(ref, tasks);
  return 'one' in f ? [f.one] : 'many' in f ? f.many : [];
}

const source = (run: RunInfo) => (run.env.turn === 'ai-app' ? { type: 'ai-app' as const, label: 'From your AI app' } : { type: 'you' as const, label: run.env.turn === 'chat' ? 'You said it in the chat' : 'You said it on a call' });

const listAdd: AgentTool = {
  name: 'list_add',
  title: 'Add to Your list or set a reminder',
  group: 'Your list',
  description:
    "Add something to the listener's own list in Host-Caster (Your list), with an optional due day or reminder time. This is also how you remind them: \"remind me to call Mom at 6\", \"remind me the day before\" (give the day before as the time); the hosts remind them on air and the app shows it. Use the listener's words.",
  parameters: obj(
    {
      what: s('what to do, in the listener\'s words ("buy batteries")'),
      due: s('a due day ("Friday", "2026-11-06"), or a time for a reminder ("tomorrow at 9 AM", "Thursday at 9 AM" for the day before Friday); optional'),
      kind: { type: 'string', enum: KINDS, description: 'todo (default), deadline, bill or waiting (waiting on someone)' },
    },
    ['what'],
  ),
  kind: 'app-write',
  core: true,
  keywords: ['remind', 'reminder', 'add', 'list', 'to do', 'todo', 'note', 'later'],
  available: needList,
  async run(args, run) {
    if (askedNotOrdered(run, str(args.what, 160))) return fail(ASKED_NOT_ORDERED, 'Your list (a question)');
    const words = cleanTitle(str(args.what, 160), run.heard, 'task');
    if (!words) return fail(NOT_GROUNDED, 'Your list (not added)');
    // the list talks to the listener: "renew my license" -> "Renew your license"
    const what = tidyWhat(words);
    const when = args.due ? dueOrRemind(str(args.due, 80), whenCtx()) : undefined;
    if (when && 'error' in when) return fail(`${when.error} Nothing was added; ask for the day.`, 'Your list (no day)');
    const kind = KINDS.includes(args.kind as TrackedKind) ? (args.kind as TrackedKind) : 'todo';
    const { item, op } = await addItem({ what, kind, ...(when ? { due: when.due, dueAllDay: when.dueAllDay, ...(when.remindAt ? { remindAt: when.remindAt } : {}) } : {}), source: source(run) });
    if (op === 'skipped') return { ok: true, content: { status: 'already_on_the_list', item: item.what, id: item.id }, what: 'Your list: already there' };
    const change = await recordChange(`Added "${item.what}" to Your list`, { op: 'list-remove', id: item.id });
    const tasksOn = run.env.connections.actions?.tasks && run.env.google?.tasks !== false;
    return {
      ok: true,
      content: {
        status: 'added',
        item: item.what,
        id: item.id,
        ...(when ? { [when.remindAt ? 'reminder' : 'due']: when.spoken } : {}),
        change_id: change.id,
        ...(tasksOn ? { google_tasks: 'Their Google Tasks are connected: unless they said only Your list, also call google_task_add now with the same words and due day. The app reads it back and asks them; do not ask about it yourself.' } : {}),
      },
      what: `Your list: added "${item.what.slice(0, 40)}"`,
      effect: { kind: 'changed', change },
      ...(tasksOn ? {} : { said: `Okay, it's on your list: ${item.what}${when ? `, ${when.remindAt ? 'with a reminder' : 'due'} ${when.spoken}` : ''}.` }),
    };
  },
};

/** One list change with its undo (the item as it was). */
async function changeItem(
  ref: unknown,
  what: (i: TrackedItem) => string,
  fn: (i: TrackedItem) => Promise<TrackedItem | undefined>,
  said = '',
  done?: (i: TrackedItem) => string,
  env?: RunInfo['env'],
): Promise<ToolRun> {
  const { item, problem } = await itemFor(ref, said);
  if (!item) return problem!;
  const next = await fn(item);
  if (!next) return fail('That item is gone.', 'Your list (gone)');
  const change = await recordChange(what(item), { op: 'list-restore', item });
  // a Google task too: linked, or an open one with the same words (it came from an email and from Google Tasks)
  const twinId = item.gtask?.taskId ?? (env ? await googleTwin(item.what, env) : undefined);
  const gtask = twinId ? { also_google_task: { task_id: twinId, note: 'It is a Google task too: also call the matching google_task tool now with this task_id. The app reads it back and asks them; do not ask about it yourself.' } } : {};
  return {
    ok: true,
    content: { status: next.status, item: next.what, id: next.id, change_id: change.id, ...gtask },
    what: what(item).slice(0, 60),
    effect: { kind: 'changed', change },
    // a Google task too: the model still has to propose its change, so no closing words yet
    ...(!twinId && done ? { said: done(next) } : {}),
  };
}

const listComplete: AgentTool = {
  name: 'list_complete',
  title: 'Tick off on Your list',
  group: 'Your list',
  description: 'Mark an item on Your list as done (the listener did it).',
  parameters: obj({ item: s('the item id from my_list, or its words') }, ['item']),
  kind: 'app-write',
  core: true,
  keywords: ['done', 'did', 'finished', 'sent', 'paid', 'tick', 'check off', 'completed', 'mark'],
  available: needList,
  run: (args, run) => changeItem(args.item, (i) => `Ticked off "${i.what}"`, (i) => markDone(i.id, 'call-in'), run.said, (i) => `Nice, that's ticked off: ${i.what}.`, run.env),
};

const listDismiss: AgentTool = {
  name: 'list_dismiss',
  title: 'Dismiss from Your list',
  group: 'Your list',
  description: 'Take an item off Your list without doing it (the listener does not need it any more). It never comes back on its own.',
  parameters: obj({ item: s('the item id from my_list, or its words') }, ['item']),
  kind: 'app-write',
  core: true,
  keywords: ['dismiss', 'remove', 'take off', 'drop', 'delete', 'never mind', 'clear'],
  available: needList,
  run: (args, run) => changeItem(args.item, (i) => `Dismissed "${i.what}"`, (i) => dismiss(i.id), '', (i) => `Okay, that's off your list: ${i.what}.`, run.env),
};

const listEdit: AgentTool = {
  name: 'list_edit',
  title: 'Change an item on Your list',
  group: 'Your list',
  description: 'Change an item on Your list: its words, its due day or reminder time, or snooze it until later.',
  parameters: obj(
    {
      item: s('the item id from my_list, or its words'),
      what: s('new words; optional'),
      due: s('new due day or reminder time ("Friday", "tomorrow at 9 AM"), or "none" to remove it; optional'),
      snooze_until: s('hide it until then ("next Monday"); optional'),
    },
    ['item'],
  ),
  kind: 'app-write',
  keywords: ['rename', 'change', 'due', 'snooze', 'push', 'move', 'reminder'],
  available: needList,
  async run(args, run) {
    const what = str(args.what, 160) ? cleanTitle(str(args.what, 160), run.heard, 'task') : '';
    if (what === undefined) return fail(NOT_GROUNDED, 'Your list (not changed)');
    const dueWords = str(args.due, 80);
    const when = dueWords && !/^(none|no|remove|clear)$/i.test(dueWords) ? dueOrRemind(dueWords, whenCtx()) : undefined;
    if (when && 'error' in when) return fail(`${when.error} Nothing was changed.`, 'Your list (no day)');
    const later = str(args.snooze_until, 80) ? dueOrRemind(str(args.snooze_until, 80), whenCtx()) : undefined;
    if (later && 'error' in later) return fail(`${later.error} Nothing was changed.`, 'Your list (no day)');
    if (!what && !dueWords && !later) return fail('Say what to change: the words, the due day or a snooze.', 'Your list (nothing to change)');
    return changeItem(
      args.item,
      (i) => `Changed "${i.what}" on Your list`,
      async (i) => {
        const patch: Partial<TrackedItem> = {};
        if (what) patch.what = what;
        if (dueWords) Object.assign(patch, when ? { due: when.due, dueAllDay: when.dueAllDay, remindAt: when.remindAt } : { due: undefined, dueAllDay: undefined, remindAt: undefined });
        const next = Object.keys(patch).length ? await updateItem(i.id, patch) : i;
        if (later && next) return snooze(i.id, later.remindAt ?? Date.parse(`${later.due}T08:00:00`));
        return next;
      },
      '',
      (i) => `Done, I updated it: ${i.what}${when ? `, ${when.remindAt ? 'reminder' : 'due'} ${when.spoken}` : ''}${later ? `, snoozed to ${later.spoken}` : ''}.`,
    );
  },
};

/** "You like jazz" -> "that you like jazz"; a card that is not a sentence about them -> ": Vegetarian" */
const aboutYou = (t: string) => {
  const s = t.trim().replace(/[.!]+$/, '');
  return /^(?:You|Your)\b/.test(s) ? ` that ${s.charAt(0).toLowerCase()}${s.slice(1)}` : `: ${s}`;
};

/** An open Google task with the same words as a Your list item (when the listener's Google Tasks are on). */
async function googleTwin(what: string, env: RunInfo['env']): Promise<string | undefined> {
  if (!env.connections.actions?.tasks || env.google?.tasks === false) return undefined;
  const words = what.trim().toLowerCase();
  const { tasks } = await googleTasks().catch(() => ({ tasks: [] as { id: string; title: string; status?: string }[] }));
  return tasks.find((t) => t.status !== 'completed' && t.title.trim().toLowerCase() === words)?.id;
}

const memorySource = (run: RunInfo) => (run.env.turn === 'ai-app' ? ('app' as const) : ('callin' as const));

const memoryRemember: AgentTool = {
  name: 'memory_remember',
  title: 'Remember something',
  group: 'What you remember',
  description: 'Remember something the listener told you about themselves, their plans, people or likes, when they ask you to remember it. In their words.',
  parameters: obj({ text: s('what to remember, in the listener\'s words ("my sister Ana visits next weekend")') }, ['text']),
  kind: 'app-write',
  core: true,
  keywords: ['remember', 'note that', 'keep in mind', 'my favorite', 'i like', 'i love'],
  available: () => OK,
  async run(args, run) {
    const text = str(args.text, 200);
    if (askedNotOrdered(run, text)) return fail(ASKED_NOT_ORDERED, 'Memory (a question)');
    if (!text || !grounded(text, run.heard)) return fail(NOT_GROUNDED, 'Memory (not saved)');
    const d = draftFromWords(text, Date.now());
    const plan = await addCard({ ...d, source: memorySource(run), asked: true, learnedAt: Date.now() });
    if (!plan.put) return fail(`Not saved: ${plan.refused ?? 'that cannot be kept'}.`, 'Memory (refused)');
    const change = await recordChange(`Remembered "${plan.put.text}"`, { op: 'memory-remove', id: plan.put.id });
    const mem: MemoryChange = { op: plan.updated ? 'updated' : 'remembered', text: plan.put.text, cardId: plan.put.id, from: run.env.turn === 'ai-app' ? 'app' : 'call' };
    return {
      ok: true,
      content: { status: mem.op, text: plan.put.text, change_id: change.id },
      what: `Memory: ${mem.op}`,
      effect: { kind: 'memory', change: mem },
      said: `Got it, I'll remember${aboutYou(plan.put.text)}.`,
    };
  },
};

const memoryForget: AgentTool = {
  name: 'memory_forget',
  title: 'Forget something',
  group: 'What you remember',
  description: 'Forget one thing you remember about the listener, when they ask you to.',
  parameters: obj({ text: s('words of the memory to forget, or "that" for the last thing they told you') }, ['text']),
  kind: 'app-write',
  keywords: ['forget', 'wrong', 'not true', 'no longer'],
  available: () => OK,
  async run(args) {
    // "forget that": the last thing learned
    const words = str(args.text, 200).replace(/^(?:it|that|this|what i (?:just )?said|the last (?:thing|one)|last one)$/i, '');
    const card = cardToForget(await allCards(), words, Date.now());
    if (!card) return fail(words ? `Nothing you remember matches "${words}".` : 'There is nothing recent to forget.', 'Memory (not found)');
    await deleteCards([card.id]);
    const change = await recordChange(`Forgot "${card.text}"`, { op: 'memory-restore', card });
    return { ok: true, said: `Okay, I've forgotten${aboutYou(card.text)}.`, content: { status: 'forgotten', text: card.text, change_id: change.id }, what: 'Memory: forgot one', effect: { kind: 'memory', change: { op: 'forgot', text: card.text, cardId: card.id, from: 'call' } } };
  },
};

const playSong: AgentTool = {
  name: 'play_song',
  title: 'Play a song next',
  group: 'Music',
  description: 'Queue a song from the listener\'s music library to play next (after a call: right after it). Find it with music_search first, or give the words.',
  parameters: obj({ track_id: s('the track id from music_search; optional'), query: s('song and artist words when there is no id') }),
  kind: 'app-write',
  core: true,
  keywords: ['play', 'song', 'next', 'queue', 'put on', 'music'],
  available: (env) => {
    const c = env.music?.canQueue();
    return c === true ? OK : off('unavailable', typeof c === 'string' ? c : 'Songs can only be queued while Host-Caster plays your music');
  },
  async run(args, run) {
    const r = await run.env.music!.queue(str(args.query, 120), str(args.track_id, 200) || undefined);
    if (!r?.found) return fail(`"${str(args.query, 60) || 'That song'}" is not in the music library, so it cannot play.`, 'Music (not found)');
    const plays = run.env.turn === 'call' ? 'right after this call' : 'next';
    return { ok: true, said: `You got it: ${r.found.title}${r.found.artist ? ` by ${r.found.artist}` : ''} plays ${plays}.`, content: { status: 'queued', title: r.found.title, artist: r.found.artist, plays }, what: `Music: queued "${r.found.title}"`, effect: { kind: 'song', request: r } };
  },
};

/** The listener's own words ask to undo something (code, never a model): "undo that", "put it back", "take that back". */
export function asksUndo(said: string): boolean {
  return /\b(?:undo|un-?do|revert|reverse|restore|scratch that|take (?:it|that|this) back|(?:put|bring|add) (?:it|that|this|them) back|change (?:it|that) back|make it (?:like|how) it was)\b/i.test(said);
}

const UNDONE: Partial<Record<ActionRecord['type'], string>> = {
  'task.add': 'is out of your Google Tasks again',
  'task.complete': 'is open again in your Google Tasks',
  'task.edit': 'has its old details back',
  'task.delete': 'is back in your Google Tasks',
  'task.move': 'is back in its old list',
  'calendar.add': 'is off your calendar again',
  'calendar.update': 'has its old time and details back',
  'calendar.delete': 'is back on your calendar',
  'invite.respond': 'has your earlier answer back',
  'notion.add': 'is off your Notion page again',
};

const WINDOW_MS = 3 * 3600_000;

/** Undoes the newest thing done in another account (Google, Notion) this conversation: only on the listener's word. */
async function undoOutside(a: ActionRecord, run: RunInfo): Promise<ToolRun> {
  if (!isListenerTurn(run.env.turn) || !asksUndo(run.said)) return fail('Only the listener can undo a change in their accounts, when they ask for it. Nothing was undone.', 'Undo (not asked)');
  // other people were told about it: undoing tells them again, so that stays a tap on its card
  if (a.level === 3) return fail('Google told other people about that one, so undoing it tells them again: they can tap Undo on its card if they want that. Nothing was undone.', 'Undo (others were told)');
  const done = await undoAction(a.id).catch(() => undefined);
  const title = String(a.payload.title ?? a.payload.text ?? '').slice(0, 80) || 'That';
  if (done?.status !== 'undone') {
    const why = done?.error?.message ?? 'it did not work';
    return { ok: false, content: { error: `Not undone: ${why}` }, what: 'Undo (did not work)', effect: { kind: 'said', line: `Sorry, I could not undo that: ${why}`, fact: `UNDO FAILED: ${why}` } };
  }
  const line = `Done, I undid it: "${title}" ${UNDONE[a.type] ?? 'is back the way it was'}.`;
  return { ok: true, content: { status: 'undone', what: a.summary }, what: `Undid: ${a.summary.slice(0, 50)}`, effect: { kind: 'said', line, fact: `UNDONE (true): ${a.summary}` } };
}

const undoTool: AgentTool = {
  name: 'undo_change',
  title: 'Undo a change',
  group: 'Your list',
  description:
    'Undo the last change made in this conversation, when the listener asks: on Your list, in what you remember, or one they said yes to in Google or Notion (or the one with this change_id or action_id).',
  parameters: obj({ change_id: s('the change_id or action_id from a tool result; optional (default: the last one)') }),
  kind: 'app-write',
  keywords: ['undo', 'revert', 'restore', 'back'],
  available: () => OK,
  async run(args, run) {
    const id = str(args.change_id, 60) || str(args.action_id, 60) || undefined;
    const since = run.startedAt - WINDOW_MS;
    // the newest of: an app change, or an action done in another account (by its id when one was named)
    const outside = (await actionHistory(10).catch(() => [] as ActionRecord[])).filter((a) => a.status === 'done' && a.undoable && (a.executedAt ?? a.createdAt) >= since && (!id || a.id === id));
    const app = id && outside.length ? [] : await recentChanges(since).catch(() => []);
    const last = outside[0];
    if (last && (!app[0] || (last.executedAt ?? last.createdAt) > app[0].at || id === last.id)) return undoOutside(last, run);
    const u = await undoChange(id, since);
    return u ? { ok: true, content: { status: 'undone', what: u.what }, what: `Undid: ${u.what.slice(0, 50)}`, said: u.line } : fail('There is no change to undo.', 'Undo (nothing)');
  },
};

export function appTools(): AgentTool[] {
  return [listAdd, listComplete, listDismiss, listEdit, memoryRemember, memoryForget, playSong, undoTool];
}
