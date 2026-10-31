import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFakeProviders } from './fake-providers.js';
import { localUser, makeApp } from './helpers.js';

async function setup(t, env = { ALLOW_PRIVATE_FETCH: 'true' }) {
  const fake = await startFakeProviders(t);
  const { app } = await makeApp(t, env);
  const u = await localUser(app);
  const brains = [
    { id: 'oa', name: 'Fake OpenAI', kind: 'openai', preset: 'openai', baseUrl: `${fake.base}/openai/v1`, model: 'small', transport: 'server', apiKey: 'sk-good' },
    { id: 'new', name: 'New model', kind: 'openai', baseUrl: `${fake.base}/openai/v1`, model: 'new-model', transport: 'server', apiKey: 'sk-good' },
    { id: 'bad', name: 'Bad key', kind: 'openai', baseUrl: `${fake.base}/openai/v1`, model: 'small', transport: 'server', apiKey: 'sk-bad' },
    { id: 'cl', name: 'Claude', kind: 'anthropic', baseUrl: `${fake.base}/anthropic`, model: 'claude-x', transport: 'server', apiKey: 'sk-ant-good' },
  ];
  const voices = [
    { id: 'ko', name: 'Kokoro', kind: 'openai-compatible', baseUrl: `${fake.base}/tts/v1`, model: 'kokoro', transport: 'server' },
    { id: 'el', name: 'ElevenLabs', kind: 'elevenlabs', baseUrl: `${fake.base}/eleven`, transport: 'server', apiKey: 'el-good' },
  ];
  const res = await u.call('PUT', '/api/sync', { rev: 0, doc: { hosts: [], stations: [], playlists: [], brains, voices } });
  assert.equal(res.statusCode, 200);
  return { app, fake, ...u };
}

const chat = (brainId, extra = {}) => ({ brainId, system: 'You are a host.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 50, ...extra });

test('AI proxy: OpenAI-compatible chat with the key from secrets, JSON mode, max_completion_tokens retry', async (t) => {
  const { call, fake } = await setup(t);
  const res = await call('POST', '/api/ai/chat', chat('oa'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().text, 'ok:system:2');
  const sent = fake.log.find((r) => r.path === '/openai/v1/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer sk-good');
  assert.equal(JSON.parse(sent.body).max_tokens, 50);

  assert.equal((await call('POST', '/api/ai/chat', chat('oa', { json: true }))).json().text, '{"lines":[]}');

  const retried = await call('POST', '/api/ai/chat', chat('new'));
  assert.equal(retried.statusCode, 200);
  const last = JSON.parse(fake.log.filter((r) => r.path === '/openai/v1/chat/completions').at(-1).body);
  assert.equal(last.max_completion_tokens, 50);
  assert.equal(last.max_tokens, undefined);
});

test('AI proxy: local servers get no JSON mode (Ollama loops on it), reasoning off, thinking stripped, loop retried', async (t) => {
  const { call, fake } = await setup(t);
  const sentBody = () => JSON.parse(fake.log.filter((r) => r.path === '/openai/v1/chat/completions').at(-1).body);
  await call('PUT', '/api/secrets/brain:ol', { value: 'sk-good' });
  const ollama = { id: 'ol', kind: 'openai', preset: 'ollama', baseUrl: `${fake.base}/openai/v1`, model: 'small' };
  const res = await call('POST', '/api/ai/chat', { ...chat(undefined, { json: true }), brain: ollama });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(sentBody().response_format, undefined);
  assert.equal(sentBody().reasoning_effort, 'none');
  assert.equal(sentBody().stream, false);

  const thinker = await call('POST', '/api/ai/chat', { ...chat(undefined), brain: { ...ollama, model: 'thinker' } });
  assert.equal(thinker.json().text, 'Hello there');

  // a cloud brain that loops in JSON mode: once more without it
  await call('PUT', '/api/secrets/brain:lp', { value: 'sk-good' });
  const loopy = await call('POST', '/api/ai/chat', { ...chat(undefined, { json: true }), brain: { id: 'lp', kind: 'openai', preset: 'openrouter', baseUrl: `${fake.base}/openai/v1`, model: 'loopy' } });
  assert.equal(loopy.statusCode, 200, loopy.body);
  assert.equal(sentBody().response_format, undefined);
});

test('AI proxy: upstream key errors are 400 upstream_auth (never 401), unknown brain 404', async (t) => {
  const { call } = await setup(t);
  const bad = await call('POST', '/api/ai/chat', chat('bad'));
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'upstream_auth');
  assert.match(bad.json().error.message, /Incorrect API key/);
  const missing = await call('POST', '/api/ai/chat', chat('nope'));
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'brain_not_found');
  const empty = await call('POST', '/api/ai/chat', chat('oa', { messages: [] }));
  assert.equal(empty.statusCode, 400);
});

test('AI proxy: inline brain (not synced yet) uses its secretRef; Anthropic Messages; model lists', async (t) => {
  const { call, fake } = await setup(t);
  await call('PUT', '/api/secrets/brain:fresh', { value: 'sk-good' });
  const inline = await call('POST', '/api/ai/chat', {
    ...chat(undefined),
    brain: { id: 'fresh', kind: 'openai', baseUrl: `${fake.base}/openai/v1`, model: 'm', apiKey: 'sk-IGNORED' },
  });
  assert.equal(inline.statusCode, 200);
  assert.equal(fake.log.filter((r) => r.path === '/openai/v1/chat/completions').at(-1).headers.authorization, 'Bearer sk-good');

  const claude = await call('POST', '/api/ai/chat', chat('cl', { messages: [{ role: 'assistant', content: 'hey' }] }));
  assert.equal(claude.json().text, 'claude:user:true');
  const sent = fake.log.find((r) => r.path === '/anthropic/v1/messages');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');

  assert.deepEqual((await call('POST', '/api/ai/models', { brainId: 'oa' })).json().models, ['alpha', 'zeta']);
  assert.deepEqual((await call('POST', '/api/ai/models', { brainId: 'cl' })).json().models, ['claude-x']);
});

test('AI proxy refuses private addresses unless the operator allows them', async (t) => {
  const { call } = await setup(t, {});
  const res = await call('POST', '/api/ai/chat', chat('oa'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'blocked_address');
  const { call: call2 } = await setup(t, { FETCH_ALLOW: '127.0.0.0/8' });
  assert.equal((await call2('POST', '/api/ai/chat', chat('oa'))).statusCode, 200);
});

test('TTS proxy: OpenAI-compatible audio (drops unsupported fields), ElevenLabs, voice lists', async (t) => {
  const { call, fake } = await setup(t);
  const res = await call('POST', '/api/tts', { voiceProviderId: 'ko', voiceId: 'af_heart', text: 'Hello there', speed: 1.1, instructions: 'warm' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(res.body, 'ID3-af_heart-kokoro');
  const speech = JSON.parse(fake.log.filter((r) => r.path === '/tts/v1/audio/speech').at(-1).body);
  assert.equal(speech.speed, 1.1);

  const el = await call('POST', '/api/tts', { voiceProviderId: 'el', voiceId: 'v1', text: 'Hi' });
  assert.equal(el.body, 'EL-v1');
  assert.equal(fake.log.find((r) => r.path.startsWith('/eleven/v1/text-to-speech')).query.output_format, 'mp3_44100_128');

  assert.deepEqual((await call('POST', '/api/tts/voices', { voiceProviderId: 'ko' })).json().voices.map((v) => v.id), ['af_heart', 'am_adam']);
  assert.equal((await call('POST', '/api/tts/voices', { voiceProviderId: 'el' })).json().voices[0].name, 'Rachel');
  assert.equal((await call('POST', '/api/tts', { voiceProviderId: 'ko', text: '' })).statusCode, 400);
  assert.equal((await call('POST', '/api/tts', { voiceProviderId: 'zz', text: 'x' })).json().error.code, 'voice_not_found');
});
