import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localUser, makeApp } from './helpers.js';

async function setup(t) {
  const { app } = await makeApp(t);
  const u = await localUser(app);
  const conn = (await u.call('POST', '/api/connectors', { name: 'ChatGPT' })).json();
  const token = new URL(conn.url).pathname.split('/').pop();
  let id = 0;
  const rpc = (method, params, headers = {}) =>
    app.inject({
      method: 'POST',
      url: `/mcp/${token}`,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
      payload: { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) },
    });
  const callTool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).json().result;
  return { app, conn, token, rpc, callTool, ...u };
}

test('connectors: create with a copy-able URL, list again, rename, delete', async (t) => {
  const { app, conn, call } = await setup(t);
  assert.match(conn.url, /^http:\/\/localhost:8660\/mcp\/aw_[A-Za-z0-9_-]{32}$/);
  assert.equal(conn.name, 'ChatGPT');
  const list = (await call('GET', '/api/connectors')).json().connectors;
  assert.equal(list.length, 1);
  assert.equal(list[0].url, conn.url, 'owner can copy the URL again');
  assert.doesNotMatch(JSON.stringify(app.db.prepare('SELECT token_hash, token_enc FROM connector_tokens').get()), new RegExp(new URL(conn.url).pathname.split('/').pop()));
  assert.equal((await call('PATCH', `/api/connectors/${conn.id}`, { name: 'Claude' })).json().name, 'Claude');
  assert.equal((await call('DELETE', `/api/connectors/${conn.id}`)).statusCode, 204);
  assert.equal((await call('GET', '/api/connectors')).json().connectors.length, 0);
});

test('MCP: initialize, notifications, ping, tools/list, unknown method, bad token, GET', async (t) => {
  const { app, rpc, token } = await setup(t);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.statusCode, 200);
  assert.match(init.headers['content-type'], /application\/json/);
  const r = init.json().result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
  assert.equal(r.serverInfo.name, 'hostcaster');
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).json().result.protocolVersion, '2025-11-25');

  const note = await app.inject({
    method: 'POST',
    url: `/mcp/${token}`,
    headers: { 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(note.statusCode, 202);
  assert.equal(note.body, '');
  assert.deepEqual((await rpc('ping')).json().result, {});

  const tools = (await rpc('tools/list')).json().result.tools;
  assert.deepEqual(tools.map((x) => x.name), ['now_playing', 'list_hosts', 'send_note_to_hosts', 'queue_segment', 'request_song', 'add_life_event']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20);
  }
  assert.equal((await rpc('nope/nope')).json().error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'rm_rf' })).json().error.code, -32602);

  const bad = await app.inject({ method: 'POST', url: '/mcp/aw_notarealtokenatallxxxxxxxx', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(bad.statusCode, 404);
  assert.equal(bad.json().error.code, -32001);
  assert.equal((await app.inject({ method: 'GET', url: `/mcp/${token}` })).statusCode, 405);

  const batch = await app.inject({
    method: 'POST',
    url: `/mcp/${token}`,
    payload: [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }],
  });
  assert.deepEqual(batch.json(), [{ jsonrpc: '2.0', id: 'a', result: {} }]);
});

test('MCP tools land in the inbox; the client polls and consumes them', async (t) => {
  const { callTool, call } = await setup(t);
  assert.match((await callTool('now_playing', {})).content[0].text, /Nothing is playing/);
  await call('POST', '/api/now-playing', { station: 'Host-Caster 88.1', track: { title: 'Night Drive', artist: 'The Signals' }, hosts: ['Maya', 'Jules'], onAir: true, speaking: 'Maya' });
  const np = await callTool('now_playing', {});
  assert.equal(np.content[0].text, 'Host-Caster 88.1 is playing "Night Drive" by The Signals. Hosts: Maya, Jules. Maya is talking on air.');
  assert.equal(np.structuredContent.track.title, 'Night Drive');

  assert.match((await callTool('list_hosts', {})).content[0].text, /No hosts/);
  await call('PUT', '/api/sync', { rev: 0, doc: { hosts: [{ id: 'h1', name: 'Maya', tagline: 'Bright mornings', personality: 'Sunny' }] } });
  assert.equal((await callTool('list_hosts', {})).content[0].text, 'Maya: Bright mornings');

  assert.equal((await callTool('send_note_to_hosts', { text: 'I passed my exam!' })).isError, undefined);
  await callTool('queue_segment', { text: 'Tell the story of the band', hostName: 'Maya' });
  await callTool('request_song', { query: 'Bohemian Rhapsody' });
  await callTool('add_life_event', { title: "Mom's birthday", date: '2026-11-03', yearly: true });

  const bad = await callTool('add_life_event', { title: 'x', date: 'tomorrow' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /YYYY-MM-DD/);
  assert.equal((await callTool('send_note_to_hosts', {})).isError, true);
  assert.equal((await callTool('send_note_to_hosts', { text: 'x', until: '2000-01-01' })).isError, true);

  const { items } = (await call('GET', '/api/inbox')).json();
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [
    ['note', 'I passed my exam!'],
    ['segment', 'Tell the story of the band'],
    ['song_request', 'Bohemian Rhapsody'],
    ['life_event', "Mom's birthday"],
  ]);
  assert.equal(items[0].source, 'ChatGPT');
  assert.ok(items[0].until > Date.now(), 'notes expire after a day by default');
  assert.equal(items[1].hostName, 'Maya');
  assert.equal(items[3].date, '2026-11-03');
  assert.equal(items[3].yearly, true);

  assert.equal((await call('POST', '/api/inbox/consume', { ids: [items[1].id, items[2].id] })).json().consumed, 2);
  assert.deepEqual((await call('GET', '/api/inbox')).json().items.map((i) => i.kind), ['note', 'life_event']);
  assert.equal((await call('DELETE', `/api/inbox/${items[3].id}`)).statusCode, 204);
  assert.equal((await call('GET', '/api/inbox')).json().items.length, 1);
});

test('MCP data is per user and revoked tokens stop working', async (t) => {
  const { app, callTool, call, conn, rpc } = await setup(t);
  await callTool('send_note_to_hosts', { text: 'secret plans' });
  const other = await localUser(app, 'other@example.com');
  assert.equal((await other.call('GET', '/api/inbox')).json().items.length, 0);
  await call('DELETE', `/api/connectors/${conn.id}`);
  assert.equal((await rpc('ping')).statusCode, 404);
});
