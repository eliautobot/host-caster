// The writable part of the stand-in Google, shared by the server tests (fake-providers.js) and the app e2e
// (app/e2e/fixtures/agents-google.mjs): calendar events by id (insert with a client id -> 409 on a duplicate, PATCH,
// DELETE -> "cancelled"), the Tasks API (lists, tasks: list/get/insert/patch/delete) with the REAL shapes (captured
// from Google, see /tmp/hc-ag4-gshape), Gmail's "in:sent to:x" search, scope checks, and fault injection:
//   POST /fixture/faults { match: regex on "METHOD /gapi/path", status?, delayMs?, drop?: true|'before', count?, retryAfter? }
//     status: answer that status instead (after delayMs); drop: true = do it, then cut the connection (an answer
//     lost on the way: the write happened); drop: 'before' = cut without doing it; delayMs alone = do it, answer late.
//   GET /fixture/state: counts (events, tasks, inserts), the faults left and the request log. DELETE /fixture/faults.
import { randomBytes } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/';
const DAY = 86_400_000;

const send = (res, status, body, headers = {}) => {
  if (status === 204) {
    res.writeHead(204, headers);
    return res.end();
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', ...headers });
  res.end(JSON.stringify(body));
};
const gerr = (code, message, reason, extra = {}) => ({ error: { code, message, errors: [{ domain: 'global', reason, message }], ...extra } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const etag = () => `"${randomBytes(6).toString('base64url')}"`;
const iso = (ms) => new Date(ms).toISOString();
const dueOf = (ms) => `${iso(ms).slice(0, 10)}T00:00:00.000Z`;
/** a task id like Google's: base64url of 16 characters */
const taskId = (seed) => Buffer.from(String(seed).padEnd(16, '0').slice(0, 16)).toString('base64url');

export const TASK_LISTS = [
  { id: 'MTAzNzEyNDA4MjM0NTA2NDgwOTg6MDow', title: 'My Tasks' },
  { id: 'SG9tZUxpc3RmaXh0dXJlMDE', title: 'Home' },
];

/** Seeded Google Tasks: 5 open (2 lists), one done yesterday (hidden, like the phone app leaves it), one done long ago. */
export function seedTasks(now = Date.now()) {
  const [mine, home] = TASK_LISTS;
  const t = (listId, seed, title, extra = {}) => ({
    kind: 'tasks#task',
    id: taskId(seed),
    etag: etag(),
    title,
    updated: iso(now - 5 * DAY),
    selfLink: `https://www.googleapis.com/tasks/v1/lists/${listId}/tasks/${taskId(seed)}`,
    position: '00000000000000000000',
    status: 'needsAction',
    webViewLink: `https://tasks.google.com/task/${seed}?sa=6`,
    listId,
    ...extra,
  });
  return [
    t(mine.id, 'vendorQuotesDana', 'Send the three vendor quotes to Dana', { due: dueOf(now + 2 * DAY), notes: 'From the Q4 budget thread' }),
    t(mine.id, 'offsiteRoomBook1', 'Book the team offsite room', { position: '00000000000000000001' }),
    t(mine.id, 'reviewBudgetDraf', 'Review the Q4 budget draft', { due: dueOf(now + 7 * DAY), position: '00000000000000000002' }),
    t(home.id, 'carRegistration1', 'Renew the car registration', { due: dueOf(now + 10 * DAY) }),
    t(home.id, 'dryCleaningPick1', 'Pick up the dry cleaning', { position: '00000000000000000001' }),
    t(home.id, 'callPlumberDone1', 'Call the plumber', { status: 'completed', completed: iso(now - DAY), updated: iso(now - DAY), hidden: true }),
    t(mine.id, 'oldDoneTaskLong1', 'File the September expenses', { status: 'completed', completed: iso(now - 20 * DAY), updated: iso(now - 20 * DAY), hidden: true }),
  ];
}

/** Invitation shapes for the refusal paths (the listener's own event, one they are not on, cancelled, over). */
export function inviteVariants(invited, now = Date.now()) {
  const at = (ms) => ({ dateTime: iso(ms), timeZone: 'America/New_York' });
  const later = { start: at(now + 30 * 3_600_000), end: at(now + 31 * 3_600_000) };
  return [
    { ...structuredClone(invited), id: 'pastinvite0001', summary: 'Last week planning', start: at(now - 3 * 3_600_000), end: at(now - 2 * 3_600_000) },
    { ...structuredClone(invited), id: 'cancelledinvite01', status: 'cancelled', summary: 'Called off sync', ...later },
    {
      ...structuredClone(invited),
      id: 'myownevent0001',
      summary: 'My own planning',
      organizer: { email: 'me@example.com', self: true },
      creator: { email: 'me@example.com', self: true },
      attendees: [
        { email: 'me@example.com', self: true, organizer: true, responseStatus: 'accepted' },
        { email: 'dana@example.com', displayName: 'Dana Reyes', responseStatus: 'needsAction' },
      ],
      ...later,
    },
    { ...structuredClone(invited), id: 'notinvited00001', summary: 'Board meeting', attendees: invited.attendees.filter((a) => !a.self), ...later },
  ];
}

/**
 * @param {{ events?: object[], tasks?: object[], lists?: {id: string, title: string}[], sentTo?: string[],
 *   self?: string, now?: number }} [opts] events: the calendar the stand-in serves (shared array: writes show up in
 *   the caller's event list too)
 */
export function createGoogleWrites(opts = {}) {
  const now = opts.now ?? Date.now();
  const self = opts.self ?? 'me@example.com';
  const state = {
    events: opts.events ?? [],
    lists: (opts.lists ?? TASK_LISTS).map((l) => ({ ...l })),
    tasks: opts.tasks ?? seedTasks(now),
    sentTo: new Set((opts.sentTo ?? ['dana@example.com', 'priya.shah@example.com']).map((s) => s.toLowerCase())),
    faults: [],
    requests: [],
    inserts: { events: 0, tasks: 0 },
    /** every write body the stand-in got: { method, path, query, body } */
    writes: [],
  };

  const record = (method, path, status, extra = {}) => {
    state.requests.push({ method, path, status, at: Date.now(), ...extra });
    if (state.requests.length > 2000) state.requests.splice(0, state.requests.length - 2000);
  };

  function takeFault(method, path) {
    const key = `${method} ${path}`;
    const i = state.faults.findIndex((f) => f.re.test(key));
    if (i < 0) return undefined;
    const f = state.faults[i];
    f.left -= 1;
    if (f.left <= 0) state.faults.splice(i, 1);
    return f;
  }

  const words = (scope) => new Set(String(scope ?? '').split(/\s+/));
  const can = {
    calRead: (w) => w.has(`${SCOPE}calendar.readonly`) || w.has(`${SCOPE}calendar.events`) || w.has(`${SCOPE}calendar`),
    calWrite: (w) => w.has(`${SCOPE}calendar.events`) || w.has(`${SCOPE}calendar`),
    tasksRead: (w) => w.has(`${SCOPE}tasks`) || w.has(`${SCOPE}tasks.readonly`),
    tasksWrite: (w) => w.has(`${SCOPE}tasks`),
    gmailRead: (w) => w.has(`${SCOPE}gmail.readonly`),
  };
  const insufficient = () => ({
    status: 403,
    body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }], status: 'PERMISSION_DENIED' } },
  });
  const notFound = () => ({ status: 404, body: gerr(404, 'Not Found', 'notFound') });

  const listOf = (id) => (id === '@default' ? state.lists[0] : state.lists.find((l) => l.id === id));
  const publicTask = ({ listId, hidden, ...t }) => ({ ...t, ...(hidden ? { hidden: true } : {}) });
  const touchTask = (t) => {
    t.updated = iso(Date.now());
    t.etag = etag();
  };

  /** The Google routes this store answers: { status, body } or undefined (not ours). */
  function route(method, p, q, body, scope) {
    const w = words(scope);
    // ---- calendar: one event by id (the store's events win over the caller's fixed fixtures)
    const one = /^\/gapi\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p);
    if (one) {
      const id = decodeURIComponent(one[2]);
      const ev = state.events.find((e) => e.id === id);
      if (method === 'GET') {
        if (!ev) return undefined;
        if (!can.calRead(w)) return insufficient();
        // a big meeting: Google leaves the other guests out of what it sends
        if (ev.attendeesOmitted) return { status: 200, body: { ...ev, attendees: (ev.attendees ?? []).filter((a) => a.self) } };
        return { status: 200, body: ev };
      }
      if (!can.calWrite(w)) return insufficient();
      if (!ev) return notFound();
      if (method === 'DELETE') {
        if (ev.status === 'cancelled') return { status: 410, body: gerr(410, 'Resource has been deleted', 'deleted') };
        ev.status = 'cancelled';
        ev.updated = iso(Date.now());
        ev.etag = etag();
        return { status: 204 };
      }
      if (method === 'PATCH' || method === 'PUT') {
        if (ev.status === 'cancelled') return { status: 410, body: gerr(410, 'Resource has been deleted', 'deleted') };
        const patch = JSON.parse(body || '{}');
        // like Google: a guest can change only their own answer, never the guest list or anyone else's entry
        if (!ev.organizer?.self && patch.attendeesOmitted) {
          // only the listener's own entry comes back: it replaces theirs, everyone else stays
          const mine = patch.attendees ?? [];
          if (Object.keys(patch).some((k) => k !== 'attendees' && k !== 'attendeesOmitted') || mine.length !== 1 || !mine[0].self) {
            return { status: 403, body: gerr(403, 'Forbidden', 'forbidden') };
          }
          ev.attendees = (ev.attendees ?? []).map((a) => (a.self ? mine[0] : a));
          Object.assign(ev, { updated: iso(Date.now()), etag: etag() });
          return { status: 200, body: ev };
        }
        if (!ev.organizer?.self) {
          if (Object.keys(patch).some((k) => k !== 'attendees')) return { status: 403, body: gerr(403, 'Forbidden', 'forbidden') };
          const before = ev.attendees ?? [];
          const after = patch.attendees ?? before;
          const others = (list) => JSON.stringify(list.filter((a) => !a.self));
          if (after.length !== before.length || others(after) !== others(before) || after.filter((a) => a.self).length !== 1) {
            return { status: 403, body: gerr(403, 'You need to have writer access to this calendar.', 'requiredAccessLevel') };
          }
        }
        Object.assign(ev, patch, { updated: iso(Date.now()), etag: etag(), sequence: (ev.sequence ?? 0) + (patch.attendees ? 0 : 1) });
        return { status: 200, body: ev };
      }
      return undefined;
    }
    const evs = /^\/gapi\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(p);
    if (evs && method === 'POST') {
      if (!can.calWrite(w)) return insufficient();
      const b = JSON.parse(body || '{}');
      const id = b.id ?? randomBytes(13).toString('hex').replace(/[w-z]/g, 'a');
      if (!/^[a-v0-9]{5,1024}$/.test(id)) return { status: 400, body: gerr(400, 'Invalid resource id value.', 'invalid') };
      if (state.events.some((e) => e.id === id)) return { status: 409, body: gerr(409, 'The requested identifier already exists.', 'duplicate') };
      if (!b.start || !b.end) return { status: 400, body: gerr(400, 'Missing end time.', 'required') };
      const t = iso(Date.now());
      const ev = {
        kind: 'calendar#event',
        etag: etag(),
        id,
        status: 'confirmed',
        htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${self}`).toString('base64url')}`,
        created: t,
        updated: t,
        summary: b.summary,
        ...(b.description ? { description: b.description } : {}),
        ...(b.location ? { location: b.location } : {}),
        creator: { email: self, self: true },
        organizer: { email: self, self: true },
        start: b.start,
        end: b.end,
        iCalUID: `${id}@google.com`,
        sequence: 0,
        ...(b.attendees ? { attendees: b.attendees } : {}),
        reminders: { useDefault: true },
        eventType: 'default',
      };
      state.events.push(ev);
      state.inserts.events++;
      return { status: 200, body: ev };
    }

    // ---- Tasks
    if (p === '/gapi/tasks/v1/users/@me/lists' && method === 'GET') {
      if (!can.tasksRead(w)) return insufficient();
      const max = Math.min(1000, Number(q.maxResults) || 1000);
      const items = state.lists.slice(0, max).map((l) => ({
        kind: 'tasks#taskList',
        id: l.id,
        etag: `"${l.id.slice(0, 8)}"`,
        title: l.title,
        updated: iso(now - 30 * DAY),
        selfLink: `https://www.googleapis.com/tasks/v1/users/@me/lists/${l.id}`,
      }));
      return { status: 200, body: { kind: 'tasks#taskLists', etag: '"lists"', items } };
    }
    const oneList = /^\/gapi\/tasks\/v1\/users\/@me\/lists\/([^/]+)$/.exec(p);
    if (oneList && method === 'GET') {
      if (!can.tasksRead(w)) return insufficient();
      const l = listOf(decodeURIComponent(oneList[1]));
      return l ? { status: 200, body: { kind: 'tasks#taskList', id: l.id, title: l.title, updated: iso(now - 30 * DAY) } } : notFound();
    }
    const tasks = /^\/gapi\/tasks\/v1\/lists\/([^/]+)\/tasks$/.exec(p);
    if (tasks) {
      const list = listOf(decodeURIComponent(tasks[1]));
      if (method === 'GET') {
        if (!can.tasksRead(w)) return insufficient();
        if (!list) return notFound();
        const showCompleted = q.showCompleted !== 'false';
        const showHidden = q.showHidden === 'true';
        const showDeleted = q.showDeleted === 'true';
        const updatedMin = q.updatedMin ? Date.parse(q.updatedMin) : 0;
        const all = state.tasks.filter(
          (t) =>
            t.listId === list.id &&
            (showDeleted || !t.deleted) &&
            (showCompleted || t.status !== 'completed') &&
            (showHidden || !t.hidden) &&
            (!updatedMin || Date.parse(t.updated) >= updatedMin),
        );
        const max = Math.max(1, Math.min(100, Number(q.maxResults) || 20));
        const from = Number(q.pageToken ?? 0) || 0;
        const items = all.slice(from, from + max).map(publicTask);
        return { status: 200, body: { kind: 'tasks#tasks', etag: etag(), items, ...(from + max < all.length ? { nextPageToken: String(from + max) } : {}) } };
      }
      if (method === 'POST') {
        if (!can.tasksWrite(w)) return insufficient();
        if (!list) return notFound();
        const b = JSON.parse(body || '{}');
        if (!String(b.title ?? '').trim() && !b.notes) return { status: 400, body: gerr(400, 'Invalid task', 'invalid') };
        if (b.due !== undefined && !Number.isFinite(Date.parse(b.due))) return { status: 400, body: gerr(400, 'Invalid value for: due', 'invalid') };
        const seed = randomBytes(12).toString('base64url').slice(0, 16);
        const id = taskId(seed);
        const task = {
          kind: 'tasks#task',
          id,
          etag: etag(),
          title: String(b.title ?? ''),
          updated: iso(Date.now()),
          selfLink: `https://www.googleapis.com/tasks/v1/lists/${list.id}/tasks/${id}`,
          position: '00000000000000000000',
          ...(b.notes ? { notes: b.notes } : {}),
          status: 'needsAction',
          ...(b.due ? { due: dueOf(Date.parse(b.due)) } : {}),
          webViewLink: `https://tasks.google.com/task/${seed}?sa=6`,
          listId: list.id,
        };
        state.tasks.push(task);
        state.inserts.tasks++;
        return { status: 200, body: publicTask(task) };
      }
      return undefined;
    }
    const oneTask = /^\/gapi\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)$/.exec(p);
    if (oneTask) {
      const list = listOf(decodeURIComponent(oneTask[1]));
      const task = list && state.tasks.find((t) => t.listId === list.id && t.id === decodeURIComponent(oneTask[2]));
      if (method === 'GET') {
        if (!can.tasksRead(w)) return insufficient();
        return task ? { status: 200, body: publicTask(task) } : notFound();
      }
      if (!can.tasksWrite(w)) return insufficient();
      if (!task) return notFound();
      if (method === 'DELETE') {
        task.deleted = true;
        touchTask(task);
        return { status: 204 };
      }
      if (method === 'PATCH' || method === 'PUT') {
        if (task.deleted) return notFound();
        const b = JSON.parse(body || '{}');
        for (const [k, v] of Object.entries(b)) {
          if (['id', 'kind', 'etag', 'selfLink', 'webViewLink', 'updated', 'position'].includes(k)) continue;
          if (v === null) delete task[k];
          else if (k === 'due') task.due = dueOf(Date.parse(v));
          else task[k] = v;
        }
        if (b.status === 'completed' && !task.completed) task.completed = iso(Date.now());
        if (b.status === 'needsAction') {
          delete task.completed;
          delete task.hidden;
        }
        touchTask(task);
        return { status: 200, body: publicTask(task) };
      }
      return undefined;
    }

    // ---- Gmail: has the listener ever written to this address
    if (p === '/gapi/gmail/v1/users/me/messages' && method === 'GET' && /\bin:sent\b/i.test(q.q ?? '')) {
      if (!can.gmailRead(w)) return insufficient();
      const to = /\bto:(\S+)/i.exec(q.q ?? '')?.[1]?.toLowerCase();
      const known = to && state.sentTo.has(to);
      return { status: 200, body: known ? { messages: [{ id: `sent${Buffer.from(to).toString('hex').slice(0, 12)}`, threadId: 'sentthread01' }], resultSizeEstimate: 1 } : { resultSizeEstimate: 0 } };
    }
    return undefined;
  }

  /** The fault's answer instead of Google's (status + Google-like body; Retry-After when asked). */
  function faultAnswer(res, f) {
    const status = f.status;
    const body =
      status === 429
        ? gerr(429, 'Rate Limit Exceeded', 'rateLimitExceeded')
        : status >= 500
          ? gerr(status, 'Backend Error', 'backendError')
          : gerr(status, `Fault ${status}`, 'fault');
    send(res, status, body, f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {});
  }

  /**
   * Answers a /gapi request when it is the store's (or a fault matches). Returns true when it answered (or cut the
   * connection); false lets the caller's own handler answer. `scope` = the token's granted scopes (undefined =
   * unknown token: 401 for the store's routes).
   */
  async function serve(req, res, url, body, scope) {
    const method = req.method ?? 'GET';
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    const f = takeFault(method, p);
    if (f) {
      if (f.delayMs && (f.status || f.drop === 'before')) await sleep(f.delayMs);
      if (f.status) {
        record(method, p, f.status, { fault: true });
        faultAnswer(res, f);
        return true;
      }
      if (f.drop === 'before') {
        record(method, p, 0, { fault: true, dropped: 'before' });
        req.socket.destroy();
        return true;
      }
    }
    if (method !== 'GET') {
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        parsed = body;
      }
      state.writes.push({ method, path: p, query: q, body: parsed });
    }
    let out;
    if (scope === undefined) {
      out = route(method, p, q, body, 'probe') ? { status: 401, body: gerr(401, 'Invalid Credentials', 'authError') } : undefined;
    } else {
      out = route(method, p, q, body, scope);
    }
    if (!out) {
      // not the store's route: a delay still applies, a drop cuts it
      if (f?.drop) {
        record(method, p, 0, { fault: true, dropped: true });
        req.socket.destroy();
        return true;
      }
      if (f?.delayMs) await sleep(f.delayMs);
      return false;
    }
    if (f?.drop) {
      // it happened, but the answer never arrives
      record(method, p, out.status, { fault: true, dropped: true });
      req.socket.destroy();
      return true;
    }
    if (f?.delayMs) await sleep(f.delayMs);
    record(method, p, out.status);
    if (!res.destroyed) send(res, out.status, out.body);
    return true;
  }

  function snapshot() {
    const live = state.events.filter((e) => e.status !== 'cancelled');
    return {
      events: { total: state.events.length, active: live.length, cancelled: state.events.length - live.length },
      tasks: {
        total: state.tasks.length,
        open: state.tasks.filter((t) => !t.deleted && t.status !== 'completed').length,
        completed: state.tasks.filter((t) => !t.deleted && t.status === 'completed').length,
        deleted: state.tasks.filter((t) => t.deleted).length,
      },
      inserts: { ...state.inserts },
      faults: state.faults.map((f) => ({ match: f.re.source, left: f.left, ...(f.status ? { status: f.status } : {}), ...(f.delayMs ? { delayMs: f.delayMs } : {}), ...(f.drop ? { drop: f.drop } : {}) })),
      items: {
        events: state.events.map((e) => ({ id: e.id, summary: e.summary, status: e.status ?? 'confirmed', ...(e.attendees ? { attendees: e.attendees.map((a) => ({ email: a.email, responseStatus: a.responseStatus, ...(a.self ? { self: true } : {}), ...(a.comment ? { comment: a.comment } : {}) })) } : {}) })),
        tasks: state.tasks.map((t) => ({ id: t.id, listId: t.listId, title: t.title, status: t.status, ...(t.due ? { due: t.due } : {}), ...(t.deleted ? { deleted: true } : {}) })),
      },
      requests: state.requests.slice(-300),
    };
  }

  /** POST/DELETE /fixture/faults, GET /fixture/state. True when it answered. */
  function fixture(req, res, url, body) {
    const p = url.pathname;
    if (p === '/fixture/faults' && req.method === 'POST') {
      let b;
      try {
        b = JSON.parse(body || '{}');
        new RegExp(b.match);
      } catch {
        send(res, 400, { error: 'match must be a regex' });
        return true;
      }
      const list = Array.isArray(b) ? b : [b];
      for (const one of list) addFault(one);
      send(res, 200, { faults: state.faults.length });
      return true;
    }
    if (p === '/fixture/faults' && req.method === 'DELETE') {
      state.faults.length = 0;
      send(res, 200, { faults: 0 });
      return true;
    }
    if (p === '/fixture/state' && req.method === 'GET') {
      send(res, 200, snapshot());
      return true;
    }
    return false;
  }

  function addFault({ match, status, delayMs, drop, count = 1, retryAfter }) {
    state.faults.push({
      re: new RegExp(match),
      left: Math.max(1, Number(count) || 1),
      ...(status ? { status: Number(status) } : {}),
      ...(delayMs ? { delayMs: Number(delayMs) } : {}),
      ...(drop ? { drop: drop === 'before' ? 'before' : true } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
  }

  return { state, serve, fixture, snapshot, addFault, clearFaults: () => (state.faults.length = 0) };
}
