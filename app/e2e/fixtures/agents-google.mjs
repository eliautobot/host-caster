// A stand-in Google for the host agents e2e: OAuth through the shared fake (server/test/fake-providers.js), and
// Calendar + Gmail from the REAL API shapes in server/test/fixtures/google (scrubbed), moved to "now": the Q4 budget
// review invitation (description, 3 guests besides the listener, Meet, attachment) in about 90 minutes, Dana's
// email about it, the invitation email, and the listener's own dentist appointment tomorrow.
// Writes (round 4 actions) come from the shared store in server/test/fake-google-store.js: events by id (insert with
// a client id, 409 on a duplicate, PATCH attendees, DELETE -> "cancelled"), Google Tasks (2 lists, 5 open tasks incl.
// "Send the three vendor quotes to Dana"), Gmail "in:sent to:x", and fault injection for e2e/stress:
//   POST /fixture/faults { match: regex on "METHOD /gapi/path", status|delayMs|drop, count }, GET /fixture/state.
import { createServer, request as httpRequest } from 'node:http';
import { createGoogleWrites } from '../../../server/test/fake-google-store.js';
import { FX_CAL, FX_MAIL, startFakeProviders } from '../../../server/test/fake-providers.js';

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const at = (ms) => ({ dateTime: new Date(ms).toISOString(), timeZone: 'America/New_York' });

export async function startAgentsGoogle(port) {
  const fake = await startFakeProviders({ after: () => undefined });
  const log = [];
  const now = Date.now();
  const startAt = Math.ceil((now + 90 * 60_000) / (15 * 60_000)) * 15 * 60_000;
  const invited = { ...FX_CAL.invited, summary: 'Q4 budget review', start: at(startAt), end: at(startAt + 3_600_000), updated: new Date(now - 3_600_000).toISOString() };
  const dentist = { ...FX_CAL.withAttendee, id: 'dentist0fixture', start: at(now + 26 * 3_600_000), end: at(now + 27 * 3_600_000) };
  const lunch = {
    ...FX_CAL.withAttendee,
    id: 'lunch0fixture',
    summary: 'Team lunch',
    location: 'Cafe Uno',
    // organized by a colleague (a move of the listener's own event is not news to them)
    organizer: { email: 'priya.shah@example.com', displayName: 'Priya Shah' },
    creator: { email: 'priya.shah@example.com', displayName: 'Priya Shah' },
    attendees: [
      { email: 'priya.shah@example.com', displayName: 'Priya Shah', organizer: true, responseStatus: 'accepted' },
      { email: 'me@example.com', self: true, responseStatus: 'accepted' },
    ],
    start: at(now + 4 * 3_600_000),
    end: at(now + 5 * 3_600_000),
    updated: new Date(now - 3_600_000).toISOString(),
  };
  const events = [invited, dentist, lunch].map((e) => ({ status: 'confirmed', updated: new Date(now - 3_600_000).toISOString(), ...e }));
  // the same events array: what the actions add, answer or delete shows up in the calendar reads below
  const writes = createGoogleWrites({ events, now, self: 'me@example.com' });
  // Gmail history for the heads-up watch: each mail added later gets the next history id
  let historyId = 1000;
  const history = [];
  const mails = {
    [FX_MAIL.dana.id]: { ...structuredClone(FX_MAIL.dana), internalDate: String(now - 2 * 3_600_000) },
    [FX_MAIL.invite.id]: { ...structuredClone(FX_MAIL.invite), internalDate: String(now - 3 * 3_600_000) },
  };
  // the event is today: Dana's mail says so too (the fixture text said "on Monday"), the invitation names today's date
  const hm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
  const today = `${new Date(startAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} ${hm(startAt)} - ${hm(startAt + 3_600_000)}`;
  const swap = (b64, from, to) => Buffer.from(Buffer.from(b64, 'base64url').toString('utf8').replace(from, to)).toString('base64url');
  const walk = (part, fn) => {
    fn(part);
    for (const c of part.parts ?? []) walk(c, fn);
  };
  const danaCopy = mails[FX_MAIL.dana.id];
  danaCopy.snippet = danaCopy.snippet.replace(/ on Monday/g, ' today');
  walk(danaCopy.payload, (p) => {
    if (p.body?.data) p.body.data = swap(p.body.data, / on Monday/g, ' today');
  });
  const inviteCopy = mails[FX_MAIL.invite.id];
  inviteCopy.payload.headers = inviteCopy.payload.headers.map((h) => (h.name === 'Subject' ? { ...h, value: h.value.replace(/Mon Nov 9, 2026 2pm - 3pm/, today) } : h));
  // the invitation email links to THIS event (its eid carries the event id)
  const eid = Buffer.from(`${invited.id} me@example.com`).toString('base64url');
  for (const p of mails[FX_MAIL.invite.id].payload.parts[0].parts) {
    if (p.body?.data) p.body.data = Buffer.from(Buffer.from(p.body.data, 'base64url').toString('utf8').replace(/eid=[A-Za-z0-9_-]+/, `eid=${eid}`)).toString('base64url');
  }

  // opt-in extras (POST /fixture/extras): a public holiday calendar (read-only, with Election Day), the Google
  // Calendar's own time zone, and an invitation Google holds in Gmail (a new sender, no event on the calendar)
  const extras = { holiday: false, held: false, timeZone: undefined };
  const HOLIDAY_CAL = 'en.usa#holiday@group.v.calendar.google.com';
  const dayIso = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const holidayEvents = [
    { kind: 'calendar#event', id: '20261103_election', status: 'confirmed', summary: 'Election Day', description: 'Public holiday', eventType: 'default', start: { date: dayIso(now + 20 * 3_600_000) }, end: { date: dayIso(now + 44 * 3_600_000) }, updated: new Date(now - 86_400_000).toISOString(), organizer: { email: HOLIDAY_CAL, displayName: 'Holidays in United States', self: true }, transparency: 'transparent', visibility: 'public' },
  ];
  const heldMail = {
    id: 'held0invite0mail',
    threadId: 'held0invite0thread',
    labelIds: ['UNREAD', 'INBOX'],
    snippet: 'Jordan Blake has invited you to HC RSVP test. Reply for me@example.com. Invitation from Google Calendar.',
    internalDate: String(now - 30 * 60_000),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Jordan Blake <jordan.blake@example.org>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: `Invitation from an unknown sender: HC RSVP test @ ${today} (EST) (me@example.com)` },
        { name: 'Date', value: new Date(now - 30 * 60_000).toUTCString() },
      ],
      body: { size: 90, data: Buffer.from('Jordan Blake has invited you to HC RSVP test. Reply for me@example.com to answer.').toString('base64url') },
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/fixture/extras' && req.method === 'POST') {
      Object.assign(extras, JSON.parse((await readBody(req)) || '{}'));
      if (extras.held) mails[heldMail.id] = heldMail;
      else delete mails[heldMail.id];
      return json(res, 200, { extras });
    }
    if (p.startsWith('/fixture/')) {
      if (writes.fixture(req, res, url, await readBody(req))) return;
      return json(res, 404, { error: 'no such fixture route' });
    }
    if (!p.startsWith('/gapi/')) {
      // OAuth (consent, token, userinfo, revoke) from the shared fake
      const fwd = httpRequest({ host: '127.0.0.1', port: fake.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      req.pipe(fwd);
      return;
    }
    log.push({ path: p, query: Object.fromEntries(url.searchParams), method: req.method });
    const body = await readBody(req);
    // reads stay as before (no read scope checks here); writes, Tasks and "in:sent" check the token's real scopes
    const granted = fake.scopeOf(req.headers.authorization);
    const scope = `${granted ?? ''} https://www.googleapis.com/auth/calendar.readonly`;
    if (await writes.serve(req, res, url, body, scope)) return;
    if (p === '/gapi/calendar/v3/users/me/calendarList') {
      const items = [{ id: 'me@example.com', summary: 'me@example.com', summaryOverride: 'Work', primary: true, accessRole: 'owner', ...(extras.timeZone ? { timeZone: extras.timeZone } : {}) }];
      if (extras.holiday) items.push({ id: HOLIDAY_CAL, summary: 'Holidays in United States', accessRole: 'reader', timeZone: 'America/New_York' });
      return json(res, 200, { items });
    }
    const holiday = /^\/gapi\/calendar\/v3\/calendars\/([^/]+)\/events/.exec(p);
    if (holiday && decodeURIComponent(holiday[1]) === HOLIDAY_CAL) {
      if (!extras.holiday) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
      const one = /\/events\/([^/]+)$/.exec(p);
      if (one) {
        const ev = holidayEvents.find((e) => e.id === decodeURIComponent(one[1]));
        return ev ? json(res, 200, ev) : json(res, 404, { error: { code: 404, message: 'Not Found' } });
      }
      const updatedMin = Date.parse(url.searchParams.get('updatedMin') ?? '') || 0;
      return json(res, 200, { items: holidayEvents.filter((e) => !updatedMin || Date.parse(e.updated) >= updatedMin) });
    }
    const one = /^\/gapi\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p);
    if (one) {
      const ev = events.find((e) => e.id === decodeURIComponent(one[2]));
      return ev ? json(res, 200, ev) : json(res, 404, { error: { code: 404, message: 'Not Found' } });
    }
    if (/^\/gapi\/calendar\/v3\/calendars\/[^/]+\/events$/.test(p)) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const min = Date.parse(url.searchParams.get('timeMin') ?? '') || 0;
      const max = Date.parse(url.searchParams.get('timeMax') ?? '') || Infinity;
      // the watch: only what changed since updatedMin, cancelled ones too (like Google: deleted ones always come back)
      const updatedMin = Date.parse(url.searchParams.get('updatedMin') ?? '') || 0;
      const items = events.filter((e) => {
        if (updatedMin ? Date.parse(e.updated) < updatedMin : e.status === 'cancelled') return false;
        // an all-day event (one the actions added) starts at local midnight
        const s = Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00`);
        const hay = JSON.stringify([e.summary, e.description, e.attendees, e.organizer]).toLowerCase();
        return s >= min - 3_600_000 && s <= max && (!q || q.split(/\s+/).every((w) => hay.includes(w)));
      });
      return json(res, 200, { items });
    }
    if (p === '/gapi/gmail/v1/users/me/profile') return json(res, 200, { emailAddress: 'me@example.com', historyId: String(historyId) });
    if (p === '/gapi/gmail/v1/users/me/history') {
      const from = Number(url.searchParams.get('startHistoryId'));
      const added = history.filter((h) => h.id > from).map((h) => ({ id: String(h.id), messagesAdded: [{ message: { id: h.mail, labelIds: mails[h.mail].labelIds } }] }));
      return json(res, 200, { historyId: String(historyId), history: added });
    }
    if (p === '/gapi/gmail/v1/users/me/messages') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const ids = Object.values(mails)
        .filter((m) => /is:unread/.test(q) || JSON.stringify(m).toLowerCase().includes(q.replace(/-in:\S+/g, '').replace(/\w+:/g, '').trim().split(/\s+/)[0] ?? ''))
        .map((m) => ({ id: m.id, threadId: m.threadId }));
      return json(res, 200, { messages: ids, resultSizeEstimate: ids.length });
    }
    const att = /^\/gapi\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(p);
    if (att) {
      const ics = `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:${invited.iCalUID}\r\nSUMMARY:Q4 budget review\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
      return json(res, 200, { data: Buffer.from(ics).toString('base64url'), size: ics.length });
    }
    const msg = /^\/gapi\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p);
    if (msg) return mails[msg[1]] ? json(res, 200, mails[msg[1]]) : json(res, 404, { error: { code: 404, message: 'Not Found' } });
    const thread = /^\/gapi\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(p);
    if (thread) {
      if (thread[1] === FX_MAIL.thread.id) return json(res, 200, url.searchParams.get('format') === 'minimal' ? { messages: FX_MAIL.thread.messages.map((m) => ({ id: m.id })) } : FX_MAIL.thread);
      const m = Object.values(mails).find((x) => x.threadId === thread[1]);
      return m ? json(res, 200, { id: thread[1], messages: [m] }) : json(res, 404, { error: { code: 404, message: 'Not Found' } });
    }
    return json(res, 404, { error: { code: 404, message: `fixture: no ${p}` } });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const env = {
    GOOGLE_CLIENT_ID: 'g-id',
    GOOGLE_CLIENT_SECRET: 'g-secret',
    GOOGLE_AUTH_URL: `${base}/google/auth`,
    GOOGLE_TOKEN_URL: `${base}/google/token`,
    GOOGLE_USERINFO_URL: `${base}/google/userinfo`,
    GOOGLE_REVOKE_URL: `${base}/google/revoke`,
    GOOGLE_API_BASE: `${base}/gapi`,
  };
  const touch = (e) => (e.updated = new Date().toISOString());
  const find = (id) => events.find((e) => e.id === id);
  /** A mail arriving now (a plain-text Gmail message). */
  const addMail = ({ id, from, subject, text, labels = ['UNREAD', 'INBOX'], headers = [] }) => {
    mails[id] = {
      id,
      threadId: `t-${id}`,
      labelIds: labels,
      snippet: text.slice(0, 120),
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date().toUTCString() }, ...headers],
        body: { data: Buffer.from(text).toString('base64url'), size: text.length },
      },
    };
    history.push({ id: ++historyId, mail: id });
  };
  const changes = {
    /** cancels an event (Google keeps it as "cancelled"); its organizer's note comes as a calendar notification */
    cancel(id, note) {
      const e = find(id);
      e.status = 'cancelled';
      touch(e);
      if (note) addMail({ id: `cancel-${id}`, from: 'Google Calendar <calendar-notification@google.com>', subject: `Canceled event: ${e.summary}`, text: `${e.summary} has been canceled. Note from the organizer: ${note}` });
    },
    move(id, deltaMs) {
      const e = find(id);
      e.start = at(Date.parse(e.start.dateTime) + deltaMs);
      e.end = at(Date.parse(e.end.dateTime) + deltaMs);
      touch(e);
    },
    add(ev) {
      events.push({ status: 'confirmed', updated: new Date().toISOString(), ...ev });
    },
    addMail,
  };
  return { env, log, invited, startAt, changes, at, writes, base, close: () => new Promise((r) => server.close(r)) };
}
