// The hosts' lookups: tool calls through the AI proxy (OpenAI-compatible, Anthropic), a model without tools, the
// server lookups (Google from real API shapes, a web page through the egress guard, SearXNG), the log and the caps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readablePage } from '../src/agent/readable.js';
import { webSearchFrom } from '../src/config.js';
import { FX_CAL, startFakeProviders } from './fake-providers.js';
import { cookieOf, makeApp, oauth } from './helpers.js';

const S = (s) => `https://www.googleapis.com/auth/${s}.readonly`;

async function signedIn(t, { scopes = ['calendar', 'gmail'], env = {} } = {}) {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, { ...fake.env, ALLOW_PRIVATE_FETCH: 'true', ...env });
  const { cb } = await oauth(app, 'google', { code: `gina|openid ${scopes.map(S).join(' ')}|1` });
  const cookie = cookieOf(cb);
  const call = (method, url, payload) =>
    app.inject({ method, url, headers: { cookie, 'x-hostcaster': '1', ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}) });
  const tool = (name, args, extra = {}) => call('POST', '/api/agent/tool', { name, args, host: 'Maya', purpose: 'research', ...extra });
  return { app, fake, call, tool };
}

const TOOLS = [{ name: 'email_search', description: 'Search the mail', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];

test('AI proxy: native tool calls round trip on an OpenAI-compatible brain', async (t) => {
  const { fake, call } = await signedIn(t);
  await call('PUT', '/api/secrets/brain:tl', { value: 'sk-good' });
  const brain = { id: 'tl', kind: 'openai', preset: 'openrouter', baseUrl: `${fake.base}/openai/v1`, model: 'tooler' };
  const first = await call('POST', '/api/ai/chat', { brain, system: 'Research.', messages: [{ role: 'user', content: 'Who is coming?' }], tools: TOOLS, maxTokens: 200 });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().toolCalls, [{ id: 'call_1', name: 'email_search', args: { query: 'budget' } }]);
  const sent = JSON.parse(fake.log.findLast((l) => l.path === '/openai/v1/chat/completions').body);
  assert.equal(sent.tools[0].function.name, 'email_search');
  assert.equal(sent.response_format, undefined);
  const second = await call('POST', '/api/ai/chat', {
    brain,
    system: 'Research.',
    messages: [
      { role: 'user', content: 'Who is coming?' },
      { role: 'assistant', content: '', toolCalls: first.json().toolCalls },
      { role: 'tool', toolCallId: 'call_1', name: 'email_search', content: '{"emails":[{"from":"Dana"}]}' },
    ],
    tools: TOOLS,
    maxTokens: 200,
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().text, 'found:call_1:{"emails":[{"from":"');
  const sent2 = JSON.parse(fake.log.findLast((l) => l.path === '/openai/v1/chat/completions').body);
  assert.equal(sent2.messages[2].tool_calls[0].function.arguments, '{"query":"budget"}');
  assert.equal(sent2.messages[3].role, 'tool');
});

test('AI proxy: a model without tools answers tools_unsupported; Anthropic tool_use round trip', async (t) => {
  const { fake, call } = await signedIn(t);
  await call('PUT', '/api/secrets/brain:nt', { value: 'sk-good' });
  const res = await call('POST', '/api/ai/chat', {
    brain: { id: 'nt', kind: 'openai', preset: 'ollama', baseUrl: `${fake.base}/openai/v1`, model: 'notools' },
    system: 's',
    messages: [{ role: 'user', content: 'x' }],
    tools: TOOLS,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'tools_unsupported');

  await call('PUT', '/api/secrets/brain:an', { value: 'sk-ant-good' });
  const brain = { id: 'an', kind: 'anthropic', baseUrl: `${fake.base}/anthropic`, model: 'claude-x' };
  const first = await call('POST', '/api/ai/chat', { brain, system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().text, 'Let me check.');
  assert.deepEqual(first.json().toolCalls, [{ id: 'toolu_1', name: 'email_search', args: { query: 'budget' } }]);
  const second = await call('POST', '/api/ai/chat', {
    brain,
    system: 's',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'Let me check.', toolCalls: first.json().toolCalls },
      { role: 'tool', toolCallId: 'toolu_1', name: 'email_search', content: 'nothing found' },
    ],
    tools: TOOLS,
  });
  assert.equal(second.json().text, 'claude-found:toolu_1:nothing found');
  const sent = JSON.parse(fake.log.findLast((l) => l.path === '/anthropic/v1/messages').body);
  assert.equal(sent.tools[0].input_schema.type, 'object');
  assert.equal(sent.messages[1].content[1].type, 'tool_use');
  assert.equal(sent.messages[2].content[0].type, 'tool_result');
  // bad tool messages are refused
  const bad = await call('POST', '/api/ai/chat', { brain, system: 's', messages: [{ role: 'tool', content: 'x' }] });
  assert.equal(bad.statusCode, 400);
});

test('lookups: a calendar event in full, calendar and mail search, an email, a thread (real API shapes)', async (t) => {
  const { tool, call } = await signedIn(t);
  const st = (await call('GET', '/api/agent/status')).json();
  assert.equal(st.tools.calendar, true);
  assert.equal(st.tools.gmail, true);
  assert.equal(st.tools.web, false);

  const ev = await tool('calendar_event', { id: `primary@x:${FX_CAL.invited.id}` });
  assert.equal(ev.statusCode, 200, ev.body);
  const e = ev.json().result;
  assert.equal(e.organizer, 'Dana Reyes');
  assert.equal(e.guests, 4);
  assert.equal(e.invitation, true);
  assert.equal(e.video, 'Google Meet');
  assert.deepEqual(e.attachments, ['Q4 vendor quotes.xlsx']);
  assert.match(ev.json().what, /^Calendar event: HC fixture: Q4 budget review/);

  const found = (await tool('calendar_search', { query: 'budget' })).json().result.events;
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].attendees.map((a) => a.name), ['Dana Reyes', 'Mike Chen', 'Priya Shah', 'Me']);

  const mails = (await tool('email_search', { query: 'budget' })).json().result.emails;
  assert.deepEqual(mails.map((m) => m.from), ['Dana Reyes', 'Dana Reyes']);
  const read = await tool('email_read', { id: mails.find((m) => m.subject.startsWith('Re:')).id });
  assert.equal(read.statusCode, 200, read.body);
  assert.match(read.json().result.text, /bring the vendor numbers/);
  assert.equal(read.json().result.messagesInThread, 2);

  const thread = await tool('email_thread', { id: '18f00000000000aa' });
  assert.equal(thread.statusCode, 200, thread.body);
  assert.equal(thread.json().result.count, 2);
  assert.match(thread.json().result.messages[1].text, /vendor numbers/);

  const inv = (await tool('email_read', { id: '18f0000000000001' })).json().result;
  assert.equal(inv.invitation.eventId, 'abc0demo0event0q4r0001');

  // ids are checked before anything reaches Google
  assert.equal((await tool('email_read', { id: '../../x' })).statusCode, 400);
  assert.equal((await tool('nope', {})).json().error.code, 'unknown_tool');

  const log = (await call('GET', '/api/agent/lookups')).json().lookups;
  assert.ok(log.length >= 6);
  assert.equal(log[0].host, 'Maya');
  assert.equal(log.some((l) => l.what.startsWith('Email: "Re: Q4 budget review" from Dana Reyes')), true);
});

test('lookups: a linked page as readable text; sign-in pages and private addresses refused', async (t) => {
  const { tool, fake } = await signedIn(t);
  const page = await tool('open_link', { url: `${fake.base}/page/article` });
  assert.equal(page.statusCode, 200, page.body);
  const r = page.json().result;
  assert.equal(r.title, 'Vendor prices rise 4% | Example News');
  assert.equal(r.site, 'Example News');
  assert.match(r.text, /raised prices by about four percent/);
  assert.doesNotMatch(r.text, /newsletter|track\(|All rights/);
  assert.match((await tool('open_link', { url: `${fake.base}/page/private` })).json().result.error, /sign-in/);
  assert.equal((await tool('open_link', { url: 'file:///etc/passwd' })).statusCode, 400);

  // without ALLOW_PRIVATE_FETCH the egress guard refuses the same local page
  const strict = await signedIn(t, { env: { ALLOW_PRIVATE_FETCH: 'false' } });
  const refused = await strict.tool('open_link', { url: `${strict.fake.base}/page/article` });
  assert.equal(refused.statusCode >= 400, true);
});

test('web search: SearXNG on a self-hosted server; off when no provider', async (t) => {
  const fake = await startFakeProviders(t);
  const { tool, call } = await signedIn(t, { env: { SEARXNG_URL: `${fake.base}/searx` } });
  assert.equal((await call('GET', '/api/agent/status')).json().tools.web, true);
  const res = await tool('web_search', { query: 'q4 budgets' });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().result.results, /1\. Q4 budgets: what to expect: Most firms plan flat budgets\./);
  assert.equal(res.json().result.sources[0].url, 'https://news.example.com/q4');

  assert.deepEqual(webSearchFrom({}, false).provider, '');
  assert.equal(webSearchFrom({ BRAVE_SEARCH_API_KEY: 'k', TAVILY_API_KEY: 't', WEB_SEARCH_PROVIDER: 'tavily' }, false).provider, 'tavily');
  assert.equal(webSearchFrom({ BRAVE_SEARCH_API_KEY: 'k' }, false).provider, 'brave');
  assert.equal(webSearchFrom({ SEARXNG_URL: 'http://s', WEB_SEARCH_PROVIDER: 'off' }, false).provider, '');
  assert.equal(webSearchFrom({ SEARXNG_URL: 'http://s' }, true).provider, 'hostcaster');
});

test('caps: lookups per day and web searches per day; device lookups are logged; the log clears', async (t) => {
  const fake = await startFakeProviders(t);
  const { tool, call } = await signedIn(t, { env: { AGENT_LOOKUPS_PER_DAY: '3', AGENT_WEB_SEARCHES_PER_DAY: '1', SEARXNG_URL: `${fake.base}/searx` } });
  assert.equal((await tool('web_search', { query: 'a' })).statusCode, 200);
  const web2 = await tool('web_search', { query: 'b' });
  assert.equal(web2.statusCode, 429);
  assert.equal(web2.json().error.code, 'web_search_limit');
  const dev = await call('POST', '/api/agent/lookups', { items: [{ tool: 'weather', what: 'Weather: Tampa, Saturday', host: 'Leo' }, { tool: 'rm_rf', what: 'x' }] });
  assert.equal(dev.json().saved, 1);
  assert.equal((await tool('calendar_search', { query: 'budget' })).statusCode, 200);
  const over = await tool('calendar_search', { query: 'budget' });
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error.code, 'lookups_limit');
  const st = (await call('GET', '/api/agent/status')).json();
  assert.deepEqual(st.used, { lookups: 3, webSearches: 1 });
  const log = (await call('GET', '/api/agent/lookups')).json().lookups;
  assert.equal(log.find((l) => l.tool === 'weather').where, 'device');
  assert.equal((await call('DELETE', '/api/agent/lookups')).json().cleared, 3);
});

test('readable page: plain text and JSON pass through capped', () => {
  assert.equal(readablePage('hello\nworld', 'text/plain').text, 'hello\nworld');
  assert.ok(readablePage('{"a":1}', 'application/json').text.startsWith('{"a"'));
  assert.equal(readablePage('<html><body><p>Short.</p></body></html>').text, 'Short.');
});
