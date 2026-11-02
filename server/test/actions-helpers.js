// Shared setup for the actions tests: an app against the stand-in Google (fake-providers.js + fake-google-store.js),
// a listener signed in with Google and the scopes asked for, and short helpers for propose / confirm / execute.
import assert from 'node:assert/strict';
import { GOOGLE_SCOPES } from '../src/auth/providers.js';
import { startFakeProviders } from './fake-providers.js';
import { cookieOf, makeApp, oauth } from './helpers.js';

export const ALL_SCOPES = ['calendar', 'gmail', 'calendarEvents', 'tasks'];

/** fast retries by default (the timing test sets its own) */
export const FAST = { ACTIONS_BACKOFF_MS: '20,40', ACTIONS_GOOGLE_TIMEOUT_MS: '400' };

export function clientFor(app, cookie) {
  const call = (method, url, payload) =>
    app.inject({ method, url, headers: { cookie, 'x-hostcaster': '1', ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}) });
  const propose = (type, payload, extra = {}) => call('POST', '/api/actions/propose', { type, payload, origin: 'call-in', ...extra });
  const confirm = (action, { via = 'tap', hash = action.payloadHash } = {}) => call('POST', `/api/actions/${action.id}/confirm`, { payloadHash: hash, via });
  const execute = (action, token, payload = action.payload) => call('POST', `/api/actions/${action.id}/execute`, { token, payload });
  /** propose -> confirm -> execute; returns the final action (asserting each step answered) */
  async function run(type, payload, extra = {}) {
    const p = await propose(type, payload, extra);
    assert.equal(p.statusCode, 201, p.body);
    const c = await confirm(p.json().action);
    assert.equal(c.statusCode, 200, c.body);
    assert.ok(c.json().token, 'a token');
    const e = await execute(p.json().action, c.json().token);
    assert.equal(e.statusCode, 200, e.body);
    return e.json().action;
  }
  return { call, propose, confirm, execute, run, cookie };
}

/** Signs a Google user in (sub) with the short scopes given. */
export async function googleUser(app, sub, scopes = ALL_SCOPES) {
  const { cb } = await oauth(app, 'google', { code: `${sub}|openid email profile ${scopes.map((s) => GOOGLE_SCOPES[s]).join(' ')}|1` });
  const cookie = cookieOf(cb);
  assert.ok(cookie, `signed in ${sub}`);
  return clientFor(app, cookie);
}

export async function setup(t, { scopes = ALL_SCOPES, env = {} } = {}) {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, { ...fake.env, ...FAST, ...env });
  const user = await googleUser(app, 'gina', scopes);
  return { app, fake, store: fake.writes, ...user };
}

/** a timed event `hours` from now (whole hour), one hour long, as the app would send it */
export function timedEvent(hours = 26, extra = {}) {
  const start = Math.ceil((Date.now() + hours * 3_600_000) / 3_600_000) * 3_600_000;
  return {
    title: 'Dentist',
    allDay: false,
    start: new Date(start).toISOString().replace('.000Z', 'Z'),
    end: new Date(start + 3_600_000).toISOString().replace('.000Z', 'Z'),
    timeZone: 'America/New_York',
    ...extra,
  };
}

/** a day `days` from today (UTC) as "YYYY-MM-DD" */
export const dayFromNow = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export const seeded = (store, title) => store.state.tasks.find((t) => t.title === title);
export const writesTo = (store, method, re) => store.state.writes.filter((w) => w.method === method && re.test(w.path));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
