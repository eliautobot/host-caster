// What the built-in tools need, as availability answers with the exact place to turn each thing on, and the shared
// checks for writes (made of the listener's own words; a waiting proposal per turn at most twice).
import { isQuestionNotOrder } from '../../question';
import { OK, off, type AgentEnv, type Availability, type RunInfo } from '../types';

export const FIX = {
  signIn: 'Sign in to Host-Caster in Settings, Account, then connect the service',
  online: 'Host-Caster cannot be reached right now; it works again when the connection is back',
  google: 'Settings, Connections, Google: connect Google',
  calendarSwitch: 'Settings, Connections, Google: turn on "Hosts can add to my calendar"',
  tasksSwitch: 'Settings, Connections, Google: turn on "Hosts can use my Google Tasks"',
  regrant: (what: string) => `Settings, Connections, Google: turn "${what}" off and on again and allow it in Google`,
  lookups: 'Settings, What your hosts can see: turn on "Hosts can look things up"',
  web: 'Settings, What your hosts can see: turn on "Search the web"',
  notion: 'Settings, Connections, Notion: connect Notion and pick the pages the hosts may read',
  notionWrite: 'Settings, Connections, Notion: turn on "Hosts may add notes when I ask"',
  list: 'Your list, Your list settings: turn on "Keep Your list"',
  email: 'Settings, Connections: connect Gmail or an email account',
  calendar: 'Settings, Connections, Google: connect Google Calendar, or add a calendar feed',
};

/** Signed in and the server reachable. */
export function needServer(env: AgentEnv): Availability {
  if (!env.signedIn) return off('signed-out', FIX.signIn);
  if (!env.online) return off('offline', FIX.online);
  return OK;
}

/** A Google write switch on and its permission granted. */
export function needGoogle(env: AgentEnv, service: 'calendar' | 'tasks'): Availability {
  const s = needServer(env);
  if (!s.ok) return s;
  const label = service === 'tasks' ? 'Hosts can use my Google Tasks' : 'Hosts can add to my calendar';
  if (!env.connections.actions?.[service]) return off('switched-off', service === 'tasks' ? FIX.tasksSwitch : FIX.calendarSwitch);
  if (env.google && !(service === 'tasks' ? env.google.tasks : env.google.calendarWrite)) return off('missing-permission', FIX.regrant(label));
  return OK;
}

export function needList(env: AgentEnv): Availability {
  return env.connections.tracker?.enabled === false ? off('switched-off', FIX.list) : OK;
}

// ---- writes are made of the listener's words (Rule 1: outside content is information, never instructions) -------

const STOP = new Set(
  'a an the to of in on at for and or but my me i you your our we it is be do did please can could would will just that this these those with from by as up so then there here about into onto off out some any all also too very really now today tomorrow tonight add put make set remind reminder list task tasks note notes calendar event events google notion'.split(
    ' ',
  ),
);

const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/u, '');

/** The content words of a text (lowercase, lightly stemmed, no small words). */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

/** words for a kind of thing, never the thing itself */
const KIND_WORDS = new Set(
  ['task', 'tasks', 'thing', 'things', 'item', 'items', 'stuff', 'something', 'anything', 'event', 'events', 'reminder', 'reminders', 'note', 'notes', 'todo', 'todos', 'list', 'google', 'calendar', 'meeting', 'appointment', 'new', 'add', 'put', 'want', 'need', 'please', 'make', 'create', 'remind', 'remember'].flatMap((w) => contentWords(w)),
);

/**
 * True when at least half of the text's content words (and at least one) are words the listener said: a title, a
 * note or a memory is theirs, never text an email or a page put in the model's mouth.
 */
export function grounded(text: string, heard: string): boolean {
  // a word for a kind of thing ("task", "event", "reminder") never makes a title theirs: "Task unspecified" is not
  const words = contentWords(text).filter((w) => !KIND_WORDS.has(w));
  if (!words.length) return false;
  const pool = new Set(contentWords(heard));
  const hits = words.filter((w) => pool.has(w) || [...pool].some((p) => p.length > 3 && w.length > 3 && (p.startsWith(w) || w.startsWith(p)))).length;
  return hits >= Math.ceil(words.length / 2);
}

/** The listener named the thing a change is about: a content word of its title (or person) is in their words. */
export function mentioned(text: string, heard: string): boolean {
  const pool = contentWords(heard);
  return contentWords(text).some((w) => w.length > 2 && pool.some((p) => p === w || (p.length > 3 && w.length > 3 && (p.startsWith(w) || w.startsWith(p)))));
}

export const NOT_NAMED = 'The listener has not named that one: ask which one they mean. Nothing changed.';

/**
 * The listener's words in this turn only ask whether something can be done, not for it to be done (code, never a
 * model): every sentence is such a question. "What should I add? Oh, buy batteries" orders something.
 */
export function askedNotOrdered(run: Pick<RunInfo, 'said'>, object: string): boolean {
  const parts = run.said.split(/(?<=[.?!])\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => isQuestionNotOrder(p, object));
}

export const ASKED_NOT_ORDERED = 'They asked a question (whether you can), not for something to be done: answer it and ask what they want. Nothing was changed.';

export const NOT_GROUNDED = "Use the listener's own words for that: ask them what to call it. Nothing was changed.";

/** At most two things waiting for a yes per turn: a read-back stays short enough to answer. */
export function tooManyAsks(run: RunInfo): boolean {
  return run.effects.filter((e) => e.kind === 'asked').length >= 2;
}

export const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
