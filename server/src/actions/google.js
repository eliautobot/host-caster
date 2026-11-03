// What the confirmed actions do in Google, and how they are undone. Each one is safe to try again: an event gets an
// id chosen here (from the action id), so a retry after an unknown outcome gets 409 and adopts the event already
// made; a task insert first looks for the task an earlier try may have made; patches set the same values again.
// Google's 429, 5xx and timeouts get up to 3 tries (0.4 s, 1.2 s, or Retry-After up to 3 s), then an honest failure.
import { googleClient, hasGoogleScope } from '../integrations/google-auth.js';
import { HttpError } from '../errors.js';
import { TYPES, invalid, isTimeZone } from './registry.js';

const MINUTE = 60_000;

/** The calendar event id for an action: base32hex (0-9, a-v), 5-1024 characters, the same on every try. */
export const eventIdOf = (actionId) => `hc${String(actionId).toLowerCase().replace(/[^0-9a-f]/g, '')}`;

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Google may have done it (the answer was lost or broken). */
const unknownOutcome = (err) =>
  err?.code === 'upstream_timeout' || err?.code === 'upstream_unreachable' || (err?.code === 'upstream_error' && (err.upstreamStatus ?? 0) >= 500);
const retryable = (err) => err?.code === 'upstream_rate_limited' || unknownOutcome(err);

/** An action that did not happen: a code and plain words for the listener. */
export class ActionFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Up to 3 tries of fn(try number) on Google's 429/5xx/timeouts. Returns { value, attempts }; throws the last error. */
async function withRetries(app, fn, counter) {
  const { backoffMs, retryAfterCapMs } = app.config.actions;
  for (let attempt = 1; ; attempt++) {
    counter.attempts = attempt;
    try {
      return await fn(attempt);
    } catch (err) {
      if (!retryable(err) || attempt >= 3) throw err;
      const base = backoffMs[attempt - 1] ?? 1200;
      const wait = err.retryAfterMs !== undefined ? Math.max(base, Math.min(retryAfterCapMs, err.retryAfterMs)) : base;
      await sleep(wait);
    }
  }
}

const SERVICE = { calendarEvents: 'Google Calendar', tasks: 'Google Tasks' };
const NOT_DONE = {
  'calendar.add': 'nothing was added',
  'calendar.update': 'the event was not changed',
  'calendar.delete': 'the event is still in your calendar',
  'task.add': 'nothing was added',
  'task.complete': 'the task is still open',
  'task.edit': 'the task was not changed',
  'task.delete': 'the task is still in your Google Tasks',
  'task.move': 'the task stayed where it was',
  'invite.respond': 'your answer was not sent',
};
const CHECK = Object.fromEntries(Object.keys(NOT_DONE).map((t) => [t, t.startsWith('task.') ? 'your Google Tasks' : 'your calendar']));

/** Any error from a try -> the plain failure the listener sees. */
function failureOf(type, err) {
  if (err instanceof ActionFailure) return err;
  const service = SERVICE[TYPES[type].service];
  const notDone = NOT_DONE[type];
  if (err?.code === 'upstream_rate_limited') return new ActionFailure('google_busy', `${service} asked to slow down, so ${notDone}. Try again in a minute.`);
  if (unknownOutcome(err)) return new ActionFailure('google_unavailable', `${service} did not answer, so ${notDone}.`);
  if (err?.code === 'scope_missing') return new ActionFailure('scope_missing', `Host-Caster is not allowed to change ${service} anymore, so ${notDone}. Reconnect Google to allow it.`);
  if (err?.code === 'google_not_connected' || err?.code === 'google_disabled') return new ActionFailure('google_not_connected', `Google is not connected anymore, so ${notDone}.`);
  if (err?.code === 'not_found' || err?.code === 'gone') {
    const what = type.startsWith('task.') ? 'That task is no longer in your Google Tasks' : 'That event is no longer in your calendar';
    return new ActionFailure('not_found', type.endsWith('.delete') ? `${what}, so there was nothing to delete.` : `${what}, so ${notDone}.`);
  }
  return new ActionFailure('google_refused', `${service} said no, so ${notDone}.`);
}

const unknownFailure = (type) =>
  new ActionFailure('unknown_outcome', `${SERVICE[TYPES[type].service]} did not answer, so Host-Caster cannot tell whether it went through. Check ${CHECK[type]} before asking again.`);

const client = (app, userId, type) => googleClient(app, userId, TYPES[type].service);

// ---- checks when the hosts propose ----------------------------------------------------------------------------------

const sameTitle = (a, b) =>
  String(a ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

const nameOf = (person) => String(person?.displayName || person?.email || '').trim();

/** Why the listener cannot answer this invitation (undefined when they can). */
export function inviteProblem(ev, now = Date.now()) {
  if (!ev || ev.status === 'cancelled') return 'That event was cancelled';
  const endRaw = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : ev.end?.date ? Date.parse(`${ev.end.date}T00:00:00Z`) : NaN;
  if (Number.isFinite(endRaw) && endRaw <= now) return 'That event is already over';
  const self = (ev.attendees ?? []).find((a) => a.self);
  if (ev.organizer?.self || self?.organizer) return 'That is your own event, so there is nothing to answer';
  if (!self) return 'You are not invited to that event';
  return undefined;
}

/** Why the listener cannot change or delete this event themselves (undefined when they can). */
export function ownEventProblem(ev) {
  if (!ev || ev.status === 'cancelled') return 'That event was already cancelled';
  const self = (ev.attendees ?? []).find((a) => a.self);
  const mine = ev.organizer?.self || self?.organizer || (!ev.organizer && !self);
  if (!mine) return "That is someone else's event, so only your answer to the invitation can change";
  return undefined;
}

/** The people Google tells about a change: every guest but the listener and rooms. */
export const guestsOf = (ev) => (ev.attendees ?? []).filter((a) => !a.self && !a.resource).length;

/** the guests' names as the listener knows them (the name Google shows, else the address), plain letters only, 3 at most */
export const guestNamesOf = (ev) =>
  (ev.attendees ?? [])
    .filter((a) => !a.self && !a.resource)
    .slice(0, 3)
    .map((a) => String(a.displayName || a.email || '').replace(/[^\p{L}\p{N} .@'-]/gu, '').trim().slice(0, 60))
    .filter(Boolean);

function ownEventContext(ev, tz) {
  const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
  return {
    title: String(ev.summary ?? '').trim().slice(0, 200) || 'the event',
    allDay,
    ...(allDay ? { startDate: ev.start.date } : { start: Date.parse(ev.start?.dateTime) }),
    tz: isTimeZone(tz) ? tz : isTimeZone(ev.start?.timeZone) ? ev.start.timeZone : 'UTC',
    guests: guestsOf(ev),
    guestNames: guestNamesOf(ev),
    ...(ev.recurringEventId ? { recurring: true } : {}),
  };
}

function inviteContext(ev, tz) {
  const organizer = nameOf(ev.organizer) || nameOf((ev.attendees ?? []).find((a) => a.organizer));
  const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
  return {
    title: String(ev.summary ?? '').trim().slice(0, 200) || 'the invitation',
    organizer: organizer.slice(0, 120),
    allDay,
    ...(allDay ? { startDate: ev.start.date } : { start: Date.parse(ev.start?.dateTime) }),
    tz: isTimeZone(tz) ? tz : isTimeZone(ev.start?.timeZone) ? ev.start.timeZone : 'UTC',
  };
}

const taskPath = (listId, taskId) => `/tasks/v1/lists/${enc(listId)}/tasks/${enc(taskId)}`;

/**
 * Checks a proposal against Google (the task exists and has that title, the invitation can be answered) and returns
 * what the words need. 403 scope_missing (with `service`) without the write scope.
 */
export async function prepare(app, userId, type, payload, { tz } = {}) {
  const service = TYPES[type].service;
  if (!hasGoogleScope(app, userId, service)) {
    throw new HttpError(403, 'scope_missing', 'Reconnect Google to allow this', { service });
  }
  const api = client(app, userId, type);
  const lookup = async (fn, field, message) => {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'not_found' || err.code === 'gone') throw invalid(field, message);
      if (err.code === 'scope_missing') throw new HttpError(403, 'scope_missing', 'Reconnect Google to allow this', { service });
      throw err;
    }
  };
  switch (type) {
    case 'calendar.add':
      return {};
    case 'task.add': {
      if (payload.listId === '@default') return {};
      const list = await lookup(() => api.get(`/tasks/v1/users/@me/lists/${enc(payload.listId)}`), 'listId', 'That list is not in your Google Tasks');
      return { listTitle: String(list.title ?? '').slice(0, 100) };
    }
    case 'task.complete':
    case 'task.edit': {
      const task = await lookup(() => api.get(taskPath(payload.listId, payload.taskId)), 'taskId', 'That task is not in your Google Tasks');
      if (task.deleted) throw invalid('taskId', 'That task is not in your Google Tasks');
      if (type === 'task.complete') {
        if (!sameTitle(task.title, payload.title)) throw invalid('title', 'That task has another title in your Google Tasks');
        if (task.status === 'completed') throw invalid('taskId', 'That task is already done');
        return {};
      }
      return { currentTitle: String(task.title ?? '').trim().slice(0, 200) };
    }
    case 'task.delete':
    case 'task.move': {
      const task = await lookup(() => api.get(taskPath(payload.listId, payload.taskId)), 'taskId', 'That task is not in your Google Tasks');
      if (task.deleted) throw invalid('taskId', 'That task is not in your Google Tasks');
      if (!sameTitle(task.title, payload.title)) throw invalid('title', 'That task has another title in your Google Tasks');
      if (type === 'task.delete') return {};
      const lists = await lookup(() => api.get('/tasks/v1/users/@me/lists'), 'toListId', 'Your Google Tasks lists could not be read');
      const titleOf = (id) => (lists.items ?? []).find((l) => l.id === id)?.title;
      const fromTitle = payload.listId === '@default' ? (lists.items ?? [])[0]?.title : titleOf(payload.listId);
      const toTitle = titleOf(payload.toListId);
      if (!toTitle) throw invalid('toListId', 'That list is not in your Google Tasks');
      return { fromTitle: String(fromTitle ?? '').slice(0, 100), toTitle: String(toTitle).slice(0, 100) };
    }
    case 'calendar.update':
    case 'calendar.delete': {
      const ev = await lookup(
        () => api.get(`/calendar/v3/calendars/${enc(payload.calendarId)}/events/${enc(payload.eventId)}`),
        'eventId',
        'That event is not in your calendar',
      );
      const problem = ownEventProblem(ev);
      if (problem) throw invalid('eventId', problem);
      if (type === 'calendar.delete' && !sameTitle(ev.summary, payload.title)) throw invalid('title', 'That event has another title in your calendar');
      return ownEventContext(ev, tz);
    }
    case 'invite.respond': {
      const ev = await lookup(
        () => api.get(`/calendar/v3/calendars/${enc(payload.calendarId)}/events/${enc(payload.eventId)}`),
        'eventId',
        'That event is not in your calendar',
      );
      const problem = inviteProblem(ev);
      if (problem) throw invalid('eventId', problem);
      return inviteContext(ev, tz);
    }
    default:
      throw invalid('type', 'Unknown action');
  }
}

// ---- execute --------------------------------------------------------------------------------------------------------

const eventPath = (calendarId, eventId) => `/calendar/v3/calendars/${enc(calendarId)}/events/${enc(eventId)}`;

/** start/end for Google: days for an all-day event, stamps with the zone otherwise (the other field cleared). */
function whenBody(p) {
  return p.allDay
    ? { start: { date: p.start, dateTime: null, timeZone: null }, end: { date: p.end, dateTime: null, timeZone: null } }
    : { start: { dateTime: p.start, timeZone: p.timeZone, date: null }, end: { dateTime: p.end, timeZone: p.timeZone, date: null } };
}

/** gone already (an earlier try landed, or the listener did it): the delete is done either way */
const alreadyGone = (err) => err?.code === 'not_found' || err?.code === 'gone';

function eventBody(id, p) {
  const when = p.allDay
    ? { start: { date: p.start }, end: { date: p.end } }
    : { start: { dateTime: p.start, timeZone: p.timeZone }, end: { dateTime: p.end, timeZone: p.timeZone } };
  return {
    id,
    summary: p.title,
    ...when,
    ...(p.location ? { location: p.location } : {}),
    ...(p.notes ? { description: p.notes } : {}),
  };
}

const listIdOf = (task, fallback) => /\/lists\/([^/]+)\/tasks\//.exec(String(task?.selfLink ?? ''))?.[1] ?? fallback;

/** A task an earlier, unanswered insert may have made: same title (+ due), updated since that try began. */
async function findTask(api, p, since, timeoutMs) {
  let pageToken;
  for (let page = 0; page < 3; page++) {
    const res = await api.call('GET', `/tasks/v1/lists/${enc(p.listId)}/tasks`, {
      params: { showCompleted: 'true', showHidden: 'true', updatedMin: new Date(since).toISOString(), maxResults: 100, pageToken },
      timeoutMs,
    });
    const hit = (res.items ?? []).find((t) => !t.deleted && sameTitle(t.title, p.title) && (p.due ? String(t.due ?? '').slice(0, 10) === p.due : !t.due));
    if (hit) return hit;
    pageToken = res.nextPageToken;
    if (!pageToken) return undefined;
  }
  return undefined;
}

function withAnswer(attendee, responseStatus, comment) {
  const out = { ...attendee, responseStatus };
  if (comment === null) delete out.comment;
  else if (comment !== undefined) out.comment = comment;
  return out;
}

/**
 * The PATCH body for the listener's answer: the guest list exactly as Google gave it with only the self entry
 * changed. When Google left guests out of the event (attendeesOmitted), only the self entry goes back with
 * attendeesOmitted: true, so nobody is dropped from the list.
 */
function answerPatch(ev, responseStatus, comment) {
  if (ev.attendeesOmitted) {
    return { attendees: ev.attendees.filter((a) => a.self).map((a) => withAnswer(a, responseStatus, comment)), attendeesOmitted: true };
  }
  return { attendees: ev.attendees.map((a) => (a.self ? withAnswer(a, responseStatus, comment) : a)) };
}

const EXECUTE = {
  async 'calendar.add'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const id = eventIdOf(action.id);
    const path = '/calendar/v3/calendars/primary/events';
    const adopt = async () => {
      const ev = await api.call('GET', `${path}/${id}`, { timeoutMs });
      if (ev.status === 'cancelled') throw new ActionFailure('google_refused', 'Google Calendar already had this event and it was deleted, so nothing was added.');
      return ev;
    };
    let ev;
    try {
      ev = await withRetries(
        app,
        async () => {
          try {
            return await api.call('POST', path, { params: { sendUpdates: 'none' }, body: eventBody(id, p), timeoutMs });
          } catch (err) {
            // an earlier try made it (its answer was lost): the same id comes back as 409
            if (err.code === 'upstream_conflict') return adopt();
            throw err;
          }
        },
        counter,
      );
    } catch (err) {
      if (!unknownOutcome(err)) throw err;
      // the last try may have landed: look once more before saying it did not
      try {
        ev = await adopt();
      } catch (err2) {
        if (err2.code === 'not_found') throw failureOf(action.type, err);
        if (err2 instanceof ActionFailure) throw err2;
        throw unknownFailure(action.type);
      }
    }
    return {
      result: { eventId: ev.id ?? id, ...(ev.htmlLink ? { link: ev.htmlLink } : {}) },
      undo: { calendarId: 'primary', eventId: ev.id ?? id },
    };
  },

  async 'task.add'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const body = { title: p.title, ...(p.notes ? { notes: p.notes } : {}), ...(p.due ? { due: `${p.due}T00:00:00.000Z` } : {}) };
    const firstTry = Date.now();
    let unsure = false;
    let task;
    try {
      task = await withRetries(
        app,
        async () => {
          if (unsure) {
            const found = await findTask(api, p, firstTry - MINUTE, timeoutMs);
            if (found) return found;
          }
          try {
            return await api.call('POST', `/tasks/v1/lists/${enc(p.listId)}/tasks`, { body, timeoutMs });
          } catch (err) {
            if (unknownOutcome(err)) unsure = true;
            throw err;
          }
        },
        counter,
      );
    } catch (err) {
      if (!unsure) throw err;
      let found;
      try {
        found = await findTask(api, p, firstTry - MINUTE, timeoutMs);
      } catch {
        throw unknownFailure(action.type);
      }
      if (!found) throw failureOf(action.type, err);
      task = found;
    }
    const listId = listIdOf(task, p.listId);
    return {
      result: { taskId: task.id, listId, ...(task.webViewLink ? { link: task.webViewLink } : {}) },
      undo: { listId, taskId: task.id },
    };
  },

  async 'task.complete'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const task = await withRetries(app, () => api.call('PATCH', taskPath(p.listId, p.taskId), { body: { status: 'completed' }, timeoutMs }), counter);
    return {
      result: { taskId: p.taskId, listId: p.listId, ...(task.webViewLink ? { link: task.webViewLink } : {}) },
      undo: { listId: p.listId, taskId: p.taskId, patch: { status: 'needsAction', completed: null } },
    };
  },

  async 'task.edit'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const before = await withRetries(app, () => api.call('GET', taskPath(p.listId, p.taskId), { timeoutMs }), counter);
    if (before.deleted) throw new ActionFailure('not_found', 'That task is no longer in your Google Tasks, so the task was not changed.');
    const patch = {};
    const prev = {};
    if (p.title !== undefined) {
      patch.title = p.title;
      prev.title = before.title ?? '';
    }
    if (p.due !== undefined) {
      patch.due = p.due ? `${p.due}T00:00:00.000Z` : null;
      prev.due = before.due ?? null;
    }
    if (p.notes !== undefined) {
      patch.notes = p.notes;
      prev.notes = before.notes ?? null;
    }
    const task = await withRetries(app, () => api.call('PATCH', taskPath(p.listId, p.taskId), { body: patch, timeoutMs }), counter);
    return {
      result: { taskId: p.taskId, listId: p.listId, ...(task.webViewLink ? { link: task.webViewLink } : {}) },
      undo: { listId: p.listId, taskId: p.taskId, patch: prev },
    };
  },

  async 'task.delete'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const before = await withRetries(app, () => api.call('GET', taskPath(p.listId, p.taskId), { timeoutMs }), counter);
    if (before.deleted) throw new ActionFailure('not_found', 'That task is no longer in your Google Tasks, so there was nothing to delete.');
    try {
      await withRetries(app, () => api.call('DELETE', taskPath(p.listId, p.taskId), { timeoutMs }), counter);
    } catch (err) {
      if (!alreadyGone(err) || counter.attempts < 2) throw err;
    }
    // Google gives no way back for a deleted task: Undo puts back a copy (title, notes, due date, done or not)
    const copy = { title: before.title ?? '', ...(before.notes ? { notes: before.notes } : {}), ...(before.due ? { due: before.due } : {}), ...(before.status === 'completed' ? { status: 'completed' } : {}) };
    return { result: { taskId: p.taskId, listId: listIdOf(before, p.listId) }, undo: { listId: listIdOf(before, p.listId), copy } };
  },

  async 'task.move'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const task = await withRetries(
      app,
      async (attempt) => {
        try {
          return await api.call('POST', `${taskPath(p.listId, p.taskId)}/move`, { params: { destinationTasklist: p.toListId }, timeoutMs });
        } catch (err) {
          // an earlier try moved it (its answer was lost): it is in the other list now
          if (attempt > 1 && alreadyGone(err)) return api.call('GET', taskPath(p.toListId, p.taskId), { timeoutMs });
          throw err;
        }
      },
      counter,
    );
    const taskId = task?.id ?? p.taskId;
    return {
      result: { taskId, listId: p.toListId, ...(task?.webViewLink ? { link: task.webViewLink } : {}) },
      undo: { listId: p.toListId, taskId, back: p.listId },
    };
  },

  async 'calendar.update'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const path = eventPath(p.calendarId, p.eventId);
    const before = await withRetries(app, () => api.call('GET', path, { timeoutMs }), counter);
    const problem = ownEventProblem(before);
    if (problem) throw new ActionFailure('event_changed', `${problem}, so the event was not changed.`);
    const patch = {};
    const prev = {};
    if (p.title !== undefined) {
      patch.summary = p.title;
      prev.summary = before.summary ?? '';
    }
    if (p.location !== undefined) {
      patch.location = p.location ?? '';
      prev.location = before.location ?? '';
    }
    if (p.start !== undefined) {
      Object.assign(patch, whenBody(p));
      prev.start = before.start;
      prev.end = before.end;
    }
    // guests get the new time from Google (the read-back said so); an event without guests tells no one
    const sendUpdates = guestsOf(before) > 0 ? 'all' : 'none';
    const ev = await withRetries(app, () => api.call('PATCH', path, { params: { sendUpdates }, body: patch, timeoutMs }), counter);
    return {
      result: { eventId: p.eventId, ...(ev.htmlLink ? { link: ev.htmlLink } : {}) },
      undo: { calendarId: p.calendarId, eventId: p.eventId, patch: prev, sendUpdates },
    };
  },

  async 'calendar.delete'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const path = eventPath(p.calendarId, p.eventId);
    const before = await withRetries(app, () => api.call('GET', path, { timeoutMs }), counter);
    const problem = ownEventProblem(before);
    if (problem) throw new ActionFailure('event_changed', `${problem}, so nothing was deleted.`);
    const guests = guestsOf(before);
    try {
      await withRetries(app, () => api.call('DELETE', path, { params: { sendUpdates: guests > 0 ? 'all' : 'none' }, timeoutMs }), counter);
    } catch (err) {
      if (!alreadyGone(err) || counter.attempts < 2) throw err;
    }
    // with guests, Google already told them it is cancelled: there is no honest undo
    return { result: { eventId: p.eventId }, ...(guests > 0 ? {} : { undo: { calendarId: p.calendarId, eventId: p.eventId } }) };
  },

  async 'invite.respond'(app, api, action, counter, timeoutMs) {
    const p = action.payload;
    const path = `/calendar/v3/calendars/${enc(p.calendarId)}/events/${enc(p.eventId)}`;
    const ev = await withRetries(app, () => api.call('GET', path, { timeoutMs }), counter);
    const problem = inviteProblem(ev);
    if (problem) throw new ActionFailure('event_changed', `${problem}, so your answer was not sent.`);
    const self = ev.attendees.find((a) => a.self);
    const prev = { responseStatus: self.responseStatus ?? 'needsAction', comment: self.comment ?? null };
    // the same guest list, only the listener's own answer (and note) changed; Google tells the organizer
    const out = await withRetries(app, () => api.call('PATCH', path, { body: answerPatch(ev, p.response, p.note), timeoutMs }), counter);
    return {
      result: { eventId: p.eventId, ...(out.htmlLink || ev.htmlLink ? { link: out.htmlLink || ev.htmlLink } : {}) },
      undo: { calendarId: p.calendarId, eventId: p.eventId, prev },
    };
  },
};

/**
 * Runs a confirmed action. Returns { ok: true, result, undo, attempts } or { ok: false, code, message, attempts }
 * (never throws).
 */
export async function runAction(app, userId, action) {
  const counter = { attempts: 0 };
  try {
    const api = client(app, userId, action.type);
    const out = await EXECUTE[action.type](app, api, action, counter, app.config.actions.googleTimeoutMs);
    return { ok: true, ...out, attempts: Math.max(1, counter.attempts) };
  } catch (err) {
    const f = failureOf(action.type, err);
    if (!(err instanceof ActionFailure) && !(err instanceof HttpError)) app.log.error({ err }, 'action failed');
    return { ok: false, code: f.code, message: f.message, attempts: Math.max(1, counter.attempts) };
  }
}

// ---- undo -----------------------------------------------------------------------------------------------------------

const UNDO = {
  async 'calendar.add'(app, api, undo, counter, timeoutMs) {
    try {
      await withRetries(app, () => api.call('DELETE', `/calendar/v3/calendars/${enc(undo.calendarId)}/events/${enc(undo.eventId)}`, { params: { sendUpdates: 'none' }, timeoutMs }), counter);
    } catch (err) {
      // already gone (the listener deleted it): undone either way
      if (err.code !== 'not_found' && err.code !== 'gone') throw err;
    }
  },
  async 'task.add'(app, api, undo, counter, timeoutMs) {
    try {
      await withRetries(app, () => api.call('DELETE', taskPath(undo.listId, undo.taskId), { timeoutMs }), counter);
    } catch (err) {
      if (err.code !== 'not_found' && err.code !== 'gone') throw err;
    }
  },
  async 'task.complete'(app, api, undo, counter, timeoutMs) {
    await withRetries(app, () => api.call('PATCH', taskPath(undo.listId, undo.taskId), { body: undo.patch, timeoutMs }), counter);
  },
  async 'task.edit'(app, api, undo, counter, timeoutMs) {
    await withRetries(app, () => api.call('PATCH', taskPath(undo.listId, undo.taskId), { body: undo.patch, timeoutMs }), counter);
  },
  async 'task.delete'(app, api, undo, counter, timeoutMs) {
    await withRetries(app, () => api.call('POST', `/tasks/v1/lists/${enc(undo.listId)}/tasks`, { body: undo.copy, timeoutMs }), counter);
  },
  async 'task.move'(app, api, undo, counter, timeoutMs) {
    await withRetries(app, () => api.call('POST', `${taskPath(undo.listId, undo.taskId)}/move`, { params: { destinationTasklist: undo.back }, timeoutMs }), counter);
  },
  async 'calendar.update'(app, api, undo, counter, timeoutMs) {
    await withRetries(app, () => api.call('PATCH', eventPath(undo.calendarId, undo.eventId), { params: { sendUpdates: undo.sendUpdates ?? 'none' }, body: undo.patch, timeoutMs }), counter);
  },
  async 'calendar.delete'(app, api, undo, counter, timeoutMs) {
    // an event the listener deleted stays in Google's bin for a while: confirmed again, it is back as it was
    await withRetries(app, () => api.call('PATCH', eventPath(undo.calendarId, undo.eventId), { params: { sendUpdates: 'none' }, body: { status: 'confirmed' }, timeoutMs }), counter);
  },
  async 'invite.respond'(app, api, undo, counter, timeoutMs) {
    const path = `/calendar/v3/calendars/${enc(undo.calendarId)}/events/${enc(undo.eventId)}`;
    const ev = await withRetries(app, () => api.call('GET', path, { timeoutMs }), counter);
    if (ev.status === 'cancelled') return; // nothing left to answer
    if (!(ev.attendees ?? []).some((a) => a.self)) return;
    await withRetries(app, () => api.call('PATCH', path, { body: answerPatch(ev, undo.prev.responseStatus, undo.prev.comment), timeoutMs }), counter);
  },
};

const UNDO_FAILED = {
  'calendar.add': 'so the event is still in your calendar',
  'task.add': 'so the task is still in your Google Tasks',
  'task.complete': 'so the task is still marked done',
  'task.edit': 'so the task keeps its new details',
  'task.delete': 'so the task is still deleted',
  'task.move': 'so the task stays in its new list',
  'calendar.update': 'so the event keeps its new details',
  'calendar.delete': 'so the event is still deleted',
  'invite.respond': 'so your answer stays as it is',
};

/** Undoes a done action. { ok: true } or { ok: false, code: 'undo_failed', message } (never throws). */
export async function undoAction(app, userId, type, undo) {
  const counter = { attempts: 0 };
  try {
    const api = client(app, userId, type);
    await UNDO[type](app, api, undo, counter, app.config.actions.googleTimeoutMs);
    return { ok: true };
  } catch (err) {
    const service = SERVICE[TYPES[type].service];
    if (err?.code === 'not_found' || err?.code === 'gone') {
      const what = type.startsWith('task.') ? 'That task is no longer in your Google Tasks' : 'That event is no longer in your calendar';
      return { ok: false, code: 'undo_failed', message: `${what}, so there is nothing to undo.` };
    }
    const why =
      err?.code === 'scope_missing'
        ? `Host-Caster is not allowed to change ${service} anymore`
        : err?.code === 'upstream_rate_limited'
          ? `${service} asked to slow down`
          : err?.code === 'upstream_error' && (err.upstreamStatus ?? 500) < 500
            ? `${service} said no`
            : `${service} did not answer`;
    return { ok: false, code: 'undo_failed', message: `${why}, ${UNDO_FAILED[type]}.` };
  }
}
