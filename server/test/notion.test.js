import assert from 'node:assert/strict';
import test from 'node:test';
import { checkId } from '../src/integrations/notion/api.js';
import { cleanWriteText, editedWhen, pageSummary, rowsSummary, stampOf, writeBlock } from '../src/integrations/notion/text.js';
import { bullet, heading, para, startFakeNotion, todo } from './fake-notion.js';
import { appPkce, bindingCookieOf, localUser, makeApp } from './helpers.js';

/** Signed-in web user who connects Notion through the whole browser round trip. */
async function connectedWeb(t, extraEnv = {}) {
  const notion = await startFakeNotion(t);
  const { app } = await makeApp(t, { ...notion.env, ...extraEnv });
  const u = await localUser(app);
  const start = await u.call('POST', '/api/notion/start', { return: '/settings/connections' });
  assert.equal(start.statusCode, 200, start.body);
  const startUrl = new URL(start.json().url);
  const go = await app.inject({ method: 'GET', url: `${startUrl.pathname}${startUrl.search}`, headers: { cookie: u.cookie } });
  assert.equal(go.statusCode, 302);
  const consent = new URL(go.headers.location);
  assert.equal(consent.origin + consent.pathname, `${notion.base}/v1/oauth/authorize`);
  assert.equal(consent.searchParams.get('owner'), 'user');
  assert.equal(consent.searchParams.get('client_id'), 'notion-client');
  assert.equal(consent.searchParams.get('redirect_uri'), 'http://localhost:8660/auth/notion/callback');
  const bind = bindingCookieOf(go);
  const cb = await app.inject({
    method: 'GET',
    url: `/auth/notion/callback?state=${encodeURIComponent(consent.searchParams.get('state'))}&code=good-code`,
    headers: { cookie: `${u.cookie}; ${bind}` },
  });
  return { notion, app, u, cb, consent, bind };
}

test('not configured: the card says so and connect refuses', async (t) => {
  const { app } = await makeApp(t);
  const u = await localUser(app);
  assert.deepEqual((await u.call('GET', '/api/notion/status')).json(), { configured: false, connected: false });
  const start = await u.call('POST', '/api/notion/start', {});
  assert.equal(start.statusCode, 409);
  assert.equal(start.json().error.code, 'notion_not_configured');
  // signed out: nothing
  assert.equal((await app.inject({ method: 'GET', url: '/api/notion/status' })).statusCode, 401);
});

test('web connect: consent round trip, token sealed, workspace shown, no token ever returned', async (t) => {
  const { app, u, cb, notion } = await connectedWeb(t);
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, 'http://localhost:8660/#/settings/connections?notion=connected');
  const tokenCall = notion.log.find((l) => l.path === '/v1/oauth/token');
  assert.equal(tokenCall.body.redirect_uri, 'http://localhost:8660/auth/notion/callback');
  const status = (await u.call('GET', '/api/notion/status')).json();
  assert.equal(status.connected, true);
  assert.equal(status.workspace.name, "Sam's Space");
  assert.equal(status.settings.writesOn, true);
  assert.equal(status.settings.recapOn, false);
  assert.doesNotMatch(JSON.stringify(status), /ntn-/);
  const row = app.db.prepare('SELECT tokens_enc FROM notion_links').get();
  assert.doesNotMatch(row.tokens_enc, /ntn-/);
});

test('callback: another browser, another account, a replayed state or a denial never connect', async (t) => {
  const notion = await startFakeNotion(t);
  const { app } = await makeApp(t, notion.env);
  const a = await localUser(app, 'a@example.com');
  const b = await localUser(app, 'b@example.com');
  const begin = async () => {
    const url = new URL((await a.call('POST', '/api/notion/start', {})).json().url);
    const go = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { cookie: a.cookie } });
    return { state: new URL(go.headers.location).searchParams.get('state'), bind: bindingCookieOf(go) };
  };
  // no binding cookie (someone else's browser)
  let f = await begin();
  let cb = await app.inject({ method: 'GET', url: `/auth/notion/callback?state=${encodeURIComponent(f.state)}&code=good-code`, headers: { cookie: a.cookie } });
  assert.match(cb.headers.location, /notion=state_invalid/);
  // the same browser but signed in as someone else
  f = await begin();
  cb = await app.inject({ method: 'GET', url: `/auth/notion/callback?state=${encodeURIComponent(f.state)}&code=good-code`, headers: { cookie: `${b.cookie}; ${f.bind}` } });
  assert.match(cb.headers.location, /notion=state_invalid/);
  // denied on Notion
  f = await begin();
  cb = await app.inject({ method: 'GET', url: `/auth/notion/callback?state=${encodeURIComponent(f.state)}&error=access_denied`, headers: { cookie: `${a.cookie}; ${f.bind}` } });
  assert.match(cb.headers.location, /notion=access_denied/);
  // a used ticket cannot start again
  const url = new URL((await a.call('POST', '/api/notion/start', {})).json().url);
  await app.inject({ method: 'GET', url: url.pathname + url.search });
  const again = await app.inject({ method: 'GET', url: url.pathname + url.search });
  assert.match(again.headers.location, /notion=link_expired/);
  assert.equal((await a.call('GET', '/api/notion/status')).json().connected, false);
  assert.equal((await b.call('GET', '/api/notion/status')).json().connected, false);
});

test('phone app: deep link code + the app verifier finish the connection', async (t) => {
  const notion = await startFakeNotion(t);
  const { app } = await makeApp(t, notion.env);
  const u = await localUser(app);
  const { verifier, challenge } = appPkce();
  assert.equal((await u.call('POST', '/api/notion/start', { app: true })).json().error.code, 'app_outdated');
  const url = new URL((await u.call('POST', '/api/notion/start', { app: true, cc: challenge })).json().url);
  // the system browser has no session cookie
  const go = await app.inject({ method: 'GET', url: url.pathname + url.search });
  const state = new URL(go.headers.location).searchParams.get('state');
  const cb = await app.inject({ method: 'GET', url: `/auth/notion/callback?state=${encodeURIComponent(state)}&code=good-code`, headers: { cookie: bindingCookieOf(go) } });
  const back = new URL(cb.headers.location);
  assert.equal(back.protocol, 'hostcaster:');
  assert.equal(back.host, 'notion');
  const code = back.searchParams.get('code');
  assert.equal((await u.call('GET', '/api/notion/status')).json().connected, false);
  const wrong = await u.call('POST', '/api/notion/finish', { code, verifier: appPkce().verifier });
  assert.equal(wrong.statusCode, 400);
  // the code was used up by the wrong verifier: start over
  const url2 = new URL((await u.call('POST', '/api/notion/start', { app: true, cc: challenge })).json().url);
  const go2 = await app.inject({ method: 'GET', url: url2.pathname + url2.search });
  const state2 = new URL(go2.headers.location).searchParams.get('state');
  const cb2 = await app.inject({ method: 'GET', url: `/auth/notion/callback?state=${encodeURIComponent(state2)}&code=good-code`, headers: { cookie: bindingCookieOf(go2) } });
  const ok = await u.call('POST', '/api/notion/finish', { code: new URL(cb2.headers.location).searchParams.get('code'), verifier });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().connected, true);
});

test('read: chosen pages and databases become short text; checked to-dos and other pages stay out', async (t) => {
  const { app, u, notion } = await connectedWeb(t);
  const groceries = notion.addPage('Groceries', [todo('oat milk'), todo('eggs'), todo('old thing', true), heading('Weekend'), bullet('farmers market'), para('Remember the bags.')]);
  notion.addPage('Private diary', [para('secret')]);
  const tasks = notion.addSource('Tasks', [
    { properties: { Name: { type: 'title', title: [{ plain_text: 'Plan trip' }] }, Status: { type: 'status', status: { name: 'In progress' } } } },
    { properties: { Name: { type: 'title', title: [{ plain_text: 'Old finished task' }] }, Status: { type: 'status', status: { name: 'Done' } } } },
    { properties: { Name: { type: 'title', title: [{ plain_text: 'Ticked task' }] }, Done: { type: 'checkbox', checkbox: true } } },
  ]);
  const pages = (await u.call('GET', '/api/notion/pages')).json().items;
  assert.ok(pages.some((p) => p.title === 'Groceries' && p.type === 'page'));
  assert.ok(pages.some((p) => p.title === 'Tasks' && p.type === 'data_source'));
  assert.ok(!pages.some((p) => p.title === 'Plan trip'), 'database rows are not offered on their own');
  const put = await u.call('PUT', '/api/notion/settings', { read: [{ id: groceries, type: 'page' }, { id: tasks, type: 'data_source' }] });
  assert.equal(put.statusCode, 200, put.body);
  const ctx = (await u.call('GET', '/api/notion/context')).json();
  assert.equal(ctx.notes.length, 2);
  const g = ctx.notes.find((n) => n.title === 'Groceries');
  assert.match(g.text, /Open to-dos: oat milk; eggs\./);
  assert.match(g.text, /Weekend: farmers market/);
  assert.doesNotMatch(g.text, /old thing/);
  assert.equal(g.edited, 'today');
  assert.equal(typeof g.editedAt, 'number');
  // the listener's zone comes with the request; an unknown one falls back instead of failing
  const zoned = await u.call('GET', '/api/notion/context?tz=Not%2FAZone');
  assert.equal(zoned.statusCode, 200, zoned.body);
  assert.equal(zoned.json().notes.find((n) => n.title === 'Groceries').edited, 'today');
  assert.match(ctx.notes.find((n) => n.title === 'Tasks').text, /Plan trip \(Status: In progress\)/);
  assert.doesNotMatch(ctx.notes.find((n) => n.title === 'Tasks').text, /Old finished|Ticked/);
  assert.doesNotMatch(JSON.stringify(ctx), /secret/);
  // cached: a second read does not call Notion
  const before = notion.log.length;
  await u.call('GET', '/api/notion/context');
  assert.equal(notion.log.length, before);
  // a bad id never reaches Notion
  assert.equal((await u.call('PUT', '/api/notion/settings', { read: [{ id: '../../v1/users', type: 'page' }] })).statusCode, 400);
});

test('write: a Host-Caster page under the chosen one, one block per ask, log, undo only that block', async (t) => {
  const { app, u, notion } = await connectedWeb(t);
  const home = notion.addPage('Home', [para('my own words')]);
  // no page chosen yet: a kind failure in the log
  let w = (await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'oat milk', source: 'call' })).json();
  assert.equal(w.ok, false);
  assert.equal(w.code, 'notion_no_page');
  const put = (await u.call('PUT', '/api/notion/settings', { write: { id: home, mode: 'new' } })).json();
  assert.equal(put.settings.write.title, 'Host-Caster');
  assert.equal(put.settings.write.parentTitle, 'Home');
  const ours = notion.pages.get(put.settings.write.id);
  assert.equal(ours.parent.page_id, home);
  // choosing the same parent again keeps that page (no second Host-Caster page)
  const again = (await u.call('PUT', '/api/notion/settings', { write: { id: home, mode: 'new' } })).json();
  assert.equal(again.settings.write.id, ours.id);

  const res = await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'oat milk\n', source: 'call', tz: 'America/New_York' });
  assert.equal(res.statusCode, 201, res.body);
  w = res.json();
  assert.equal(w.ok, true);
  assert.equal(w.pageTitle, 'Host-Caster');
  const added = ours.blocks.at(-1);
  assert.equal(added.type, 'to_do');
  assert.equal(added.to_do.rich_text[0].text.content, 'oat milk');
  assert.match(added.to_do.rich_text[1].text.content, /on air, \w{3} \d+, \d+:\d\d [AP]M/);
  const note = (await u.call('POST', '/api/notion/write', { kind: 'note', text: 'Idea: a podcast about maps', source: 'app', ref: 'inbox:42' })).json();
  // the same ask (another device picked up the same inbox item) is answered, not written again
  const twice = (await u.call('POST', '/api/notion/write', { kind: 'note', text: 'Idea: a podcast about maps', source: 'app', ref: 'inbox:42' })).json();
  assert.equal(twice.duplicate, true);
  assert.equal(twice.ok, true);
  assert.equal(twice.activity.id, note.activity.id);
  assert.equal(ours.blocks.at(-1).type, 'paragraph');
  assert.match(ours.blocks.at(-1).paragraph.rich_text[1].text.content, /via your AI app/);
  // the listener's own page is untouched
  assert.equal(notion.pages.get(home).blocks[0].paragraph.rich_text[0].plain_text, 'my own words');

  const log = (await u.call('GET', '/api/notion/activity')).json().items;
  assert.deepEqual(log.map((a) => [a.source, a.kind, a.text, a.status]), [
    ['app', 'note', 'Idea: a podcast about maps', 'done'],
    ['call', 'todo', 'oat milk', 'done'],
    ['call', 'todo', 'oat milk', 'failed'],
  ]);
  assert.equal(log[2].canUndo, false);
  assert.doesNotMatch(JSON.stringify(log), /blockId/);

  const undo = (await u.call('POST', `/api/notion/activity/${w.activity.id}/undo`)).json();
  assert.equal(undo.activity.status, 'undone');
  assert.equal(added.in_trash, true);
  assert.equal(ours.blocks.find((b) => b.type === 'paragraph' && b.paragraph.rich_text[0].text?.content === 'Idea: a podcast about maps').in_trash, false);
  // twice is fine; a failed one cannot be undone; another account cannot touch it
  assert.equal((await u.call('POST', `/api/notion/activity/${w.activity.id}/undo`)).json().activity.status, 'undone');
  assert.equal((await u.call('POST', `/api/notion/activity/${log[2].id}/undo`)).statusCode, 409);
  const other = await localUser(app, 'other@example.com');
  assert.equal((await other.call('POST', `/api/notion/activity/${note.activity.id}/undo`)).statusCode, 404);
});

test('write: off switch, bad input, and a per-hour cap', async (t) => {
  const { u, notion } = await connectedWeb(t);
  const home = notion.addPage('Home');
  await u.call('PUT', '/api/notion/settings', { write: { id: home, mode: 'direct' }, writesOn: false });
  let w = (await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'x', source: 'call' })).json();
  assert.equal(w.code, 'notion_writes_off');
  assert.equal(notion.pages.get(home).blocks.length, 0);
  await u.call('PUT', '/api/notion/settings', { writesOn: true });
  assert.equal((await u.call('POST', '/api/notion/write', { kind: 'delete', text: 'x', source: 'call' })).statusCode, 400);
  assert.equal((await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'x', source: 'mcp' })).statusCode, 400);
  assert.equal((await u.call('POST', '/api/notion/write', { kind: 'todo', text: '   ', source: 'call' })).statusCode, 400);
  for (let i = 0; i < 30; i++) await u.call('POST', '/api/notion/write', { kind: 'todo', text: `item ${i}`, source: 'call' });
  w = (await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'one too many', source: 'call' })).json();
  assert.equal(w.code, 'rate_limited');
  assert.equal(notion.pages.get(home).blocks.length, 30);
});

test('tokens: refreshed once on 401; a refused refresh says connect again', async (t) => {
  const { app, u, notion } = await connectedWeb(t);
  const home = notion.addPage('Home');
  await u.call('PUT', '/api/notion/settings', { write: { id: home, mode: 'direct' } });
  notion.state.expireAll = true;
  const w = (await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'after refresh', source: 'call' })).json();
  assert.equal(w.ok, true);
  assert.ok(notion.log.some((l) => l.path === '/v1/oauth/token' && l.body.grant_type === 'refresh_token'));
  const row = app.db.prepare('SELECT tokens_enc FROM notion_links').get();
  assert.doesNotMatch(row.tokens_enc, /ntn-/);
  // Notion refuses the refresh (access removed in Notion): a kind failure that asks to connect again
  notion.state.expireAll = true;
  notion.state.refuseRefresh = true;
  const w2 = (await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'x', source: 'call' })).json();
  assert.equal(w2.ok, false);
  assert.equal(w2.code, 'notion_disconnected');
  assert.equal(w2.activity.status, 'failed');
});

test('recap: off by default, once a day when on', async (t) => {
  const { u, notion } = await connectedWeb(t);
  const home = notion.addPage('Home');
  await u.call('PUT', '/api/notion/settings', { write: { id: home, mode: 'direct' } });
  assert.equal((await u.call('POST', '/api/notion/recap', { day: '2026-10-31', text: 'Today on air' })).json().code, 'recap_off');
  await u.call('PUT', '/api/notion/settings', { recapOn: true });
  const r = (await u.call('POST', '/api/notion/recap', { day: '2026-10-31', text: 'Today on air: 12 breaks' })).json();
  assert.equal(r.ok, true);
  assert.equal((await u.call('POST', '/api/notion/recap', { day: '2026-10-31', text: 'again' })).json().code, 'recap_done');
  assert.equal(notion.pages.get(home).blocks.length, 1);
  assert.match(notion.pages.get(home).blocks[0].paragraph.rich_text[1].text.content, /Host-Caster recap/);
});

test('disconnect and account deletion revoke the token and forget everything', async (t) => {
  const { app, u, notion } = await connectedWeb(t);
  const home = notion.addPage('Home');
  await u.call('PUT', '/api/notion/settings', { write: { id: home, mode: 'direct' } });
  await u.call('POST', '/api/notion/write', { kind: 'todo', text: 'x', source: 'call' });
  const del = await u.call('DELETE', '/api/notion');
  assert.equal(del.statusCode, 204);
  assert.equal(notion.revoked.length, 1);
  assert.equal((await u.call('GET', '/api/notion/status')).json().connected, false);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM notion_activity').get().n, 0);
  assert.equal(notion.pages.get(home).blocks.length, 1, 'what was added stays in their Notion');
  // CSRF: a cookie write without the header is refused
  const csrf = await app.inject({ method: 'DELETE', url: '/api/notion', headers: { cookie: u.cookie } });
  assert.equal(csrf.statusCode, 403);

  // account deletion
  const { app: app2, u: u2, notion: n2 } = await connectedWeb(t);
  const gone = await u2.call('DELETE', '/api/me');
  assert.equal(gone.statusCode, 204);
  assert.equal(n2.revoked.length, 1);
  assert.equal(app2.db.prepare('SELECT COUNT(*) AS n FROM notion_links').get().n, 0);
});

test('text helpers', () => {
  assert.equal(checkId('0123456789abcdef0123456789ABCDEF'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.throws(() => checkId('../users/me'));
  assert.equal(pageSummary([]), '');
  const long = Array.from({ length: 40 }, (_, i) => ({ id: String(i), ...todo(`task number ${i} with some words`) }));
  const s = pageSummary(long, 300);
  assert.ok(s.length <= 300);
  assert.match(s, /^Open to-dos: task number 0/);
  assert.equal(rowsSummary([]), '');
  assert.equal(cleanWriteText('a\u0000b\n\nc', 10), 'a b c');
  assert.equal(cleanWriteText('x'.repeat(50), 10).length, 10);
  assert.equal(stampOf(Date.UTC(2026, 9, 31, 19, 42), 'America/New_York'), 'Oct 31, 3:42 PM');
  assert.equal(stampOf(Date.UTC(2026, 9, 31, 19, 42), 'Not/AZone'), 'Oct 31, 7:42 PM');
  assert.equal(editedWhen(Date.now()), 'today');
  assert.equal(editedWhen(Date.now() - 30 * 86_400_000), undefined);
  // 4 PM in New York, asked at 10:26 PM the same evening (already the next day in UTC)
  const afternoon = Date.UTC(2026, 9, 31, 20, 0);
  const evening = Date.UTC(2026, 10, 1, 2, 26);
  assert.equal(editedWhen(afternoon, evening, 'America/New_York'), 'today');
  assert.equal(editedWhen(afternoon, evening, 'UTC'), 'yesterday');
  assert.equal(editedWhen(afternoon - 2 * 86_400_000, evening, 'America/New_York'), '2 days ago');
  assert.equal(editedWhen(afternoon, evening, 'Not/AZone'), editedWhen(afternoon, evening));
  assert.equal(writeBlock('todo', 'a', 's', 'call').to_do.checked, false);
  // a page the hosts read and write: what they added reads back without its gray "on air, <time>" stamp
  const withPlain = (b) => ({ ...b, [b.type]: { ...b[b.type], rich_text: b[b.type].rich_text.map((x) => ({ ...x, plain_text: x.text.content })) } });
  const added = [withPlain(writeBlock('todo', 'buy batteries', 'Oct 31, 11:17 PM', 'call')), withPlain(writeBlock('note', 'call mom', 'Oct 31, 9:00 PM', 'app'))];
  assert.equal(pageSummary(added), 'Open to-dos: buy batteries. call mom');
  // the listener's own gray text stays
  assert.equal(pageSummary([{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'gray but mine', annotations: { color: 'gray' } }] } }]), 'gray but mine');
});

test('notion.add as an action: proposed with a read-back, runs only after a yes, logged, undo trashes only that block', async (t) => {
  const { app, u, notion } = await connectedWeb(t);
  const home = notion.addPage('Home', [para('my own words')]);
  const put = (await u.call('PUT', '/api/notion/settings', { write: { id: home, mode: 'new' } })).json();
  const ours = notion.pages.get(put.settings.write.id);
  const before = ours.blocks.length;
  // strict payload: only a to-do or a note, the listener's words
  assert.equal((await u.call('POST', '/api/actions/propose', { type: 'notion.add', payload: { kind: 'page', text: 'x' }, origin: 'call' })).statusCode, 400);
  assert.equal((await u.call('POST', '/api/actions/propose', { type: 'notion.add', payload: { kind: 'todo', text: 'x', pageId: home }, origin: 'call' })).statusCode, 400);
  const p = await u.call('POST', '/api/actions/propose', { type: 'notion.add', payload: { kind: 'todo', text: 'Order the oat milk' }, origin: 'call', said: 'put order the oat milk in Notion', tz: 'America/New_York' });
  assert.equal(p.statusCode, 201, p.body);
  const a = p.json().action;
  assert.equal(a.level, 2);
  assert.equal(a.summary, 'Add "Order the oat milk" as a to-do to your Notion page "Host-Caster".');
  // nothing written by proposing
  assert.equal(ours.blocks.length, before);
  // an AI app never confirms
  assert.equal((await u.call('POST', `/api/actions/${a.id}/confirm`, { via: 'ai-app', payloadHash: a.payloadHash })).statusCode, 400);
  const c = (await u.call('POST', `/api/actions/${a.id}/confirm`, { via: 'call', payloadHash: a.payloadHash })).json();
  assert.ok(c.token);
  const ex = (await u.call('POST', `/api/actions/${a.id}/execute`, { token: c.token, payload: a.payload })).json();
  assert.equal(ex.action.status, 'done', JSON.stringify(ex));
  assert.equal(ours.blocks.length, before + 1);
  assert.equal(ours.blocks.at(-1).type, 'to_do');
  assert.equal(ours.blocks.at(-1).to_do.rich_text[0].text.content, 'Order the oat milk');
  assert.match(ours.blocks.at(-1).to_do.rich_text[1].text.content, /on air/);
  assert.equal(ex.action.undoable, true);
  const log = (await u.call('GET', '/api/notion/activity')).json().items;
  assert.equal(log[0].text, 'Order the oat milk');
  // undo: only that block goes to the trash
  const un = (await u.call('POST', `/api/actions/${a.id}/undo`, {})).json();
  assert.equal(un.action.status, 'undone', JSON.stringify(un));
  assert.equal(ours.blocks.filter((b) => !b.archived && !b.in_trash).length, before);
  assert.equal(notion.pages.get(home).blocks[0].paragraph.rich_text[0].plain_text, 'my own words');
  assert.equal((await u.call('GET', '/api/notion/activity')).json().items[0].status, 'undone');
  // writes switched off: the proposal itself is refused with the reason
  await u.call('PUT', '/api/notion/settings', { writesOn: false });
  const off = await u.call('POST', '/api/actions/propose', { type: 'notion.add', payload: { kind: 'note', text: 'An idea' }, origin: 'chat' });
  assert.equal(off.statusCode, 403);
  assert.equal(off.json().error.code, 'notion_writes_off');
});
