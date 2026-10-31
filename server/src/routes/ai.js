// POST /api/ai/chat and /api/ai/models: OpenAI-compatible chat completions and Anthropic Messages, with the key
// from the user's secrets, and ChatGPT plan brains (chatgpt/service.js). The radio wants the whole script, so the
// answer goes back in one piece.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { jsonOf, userRequest } from '../net/http.js';
import { joinUrl, resolveBrain, upstreamError, upstreamMessage } from './providers.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function readMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (!m || !['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string') {
      throw new HttpError(400, 'invalid_request', 'messages must be [{ role, content }]');
    }
  }
  if (!messages.length) throw new HttpError(400, 'invalid_request', 'messages is empty');
  return messages;
}

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : '';

const anthropicBase = (brain) => String(brain.baseUrl || ANTHROPIC_BASE).replace(/\/+$/, '').replace(/\/v1$/, '');

const LOCAL_PRESETS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'custom']);
const PRIVATE_URL = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.|\[?::1\]?)/;

/** A model server on the user's machine or network (the app's core/ai/openai.ts decides the same way). */
const isLocal = (brain) => (brain.preset ? LOCAL_PRESETS.has(brain.preset) : PRIVATE_URL.test(String(brain.baseUrl ?? '')));
const isOllama = (brain) => brain.preset === 'ollama' || /:11434(\/|$)/.test(String(brain.baseUrl ?? ''));

/** Reasoning blocks some local models print before the answer. */
const stripThinking = (text) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();

async function openaiChat(ctx, brain, req) {
  const url = joinUrl(brain.baseUrl, 'chat/completions');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (brain.apiKey) headers.authorization = `Bearer ${brain.apiKey}`;
  const body = {
    model: brain.model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    max_tokens: req.maxTokens,
    stream: false,
  };
  const temperature = req.temperature ?? brain.temperature;
  if (typeof temperature === 'number') body.temperature = temperature;
  // JSON mode: cloud APIs handle it; local servers loop on it (Ollama + small models: "token repeat limit") or want a
  // json_schema (LM Studio). The prompt asks for JSON and the app's parser is tolerant, so skip it locally.
  if (req.json && !isLocal(brain)) body.response_format = { type: 'json_object' };
  // radio lines need no chain of thought (thinking models on Ollama answer at once)
  if (isOllama(brain)) body.reasoning_effort = 'none';

  // Providers differ: newer OpenAI models want max_completion_tokens, some servers reject response_format,
  // temperature or reasoning_effort. Adjust and retry on an error that names the field.
  let roomy = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await userRequest(ctx, url, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: 90000 });
    if (res.status >= 200 && res.status < 300) {
      const j = jsonOf(res);
      const choice = j?.choices?.[0];
      if (!choice) throw new HttpError(502, 'upstream_error', 'The model returned no choices');
      const text = stripThinking(textOf(choice.message?.content));
      const thought = Boolean(choice.message?.reasoning || choice.message?.reasoning_content);
      // a thinking model that spent the whole budget thinking: once more with room for the answer
      if (!text && thought && choice.finish_reason === 'length' && !roomy) {
        roomy = true;
        const room = Math.min(4096, Math.max(1024, req.maxTokens * 4));
        if (body.max_completion_tokens !== undefined) body.max_completion_tokens = room;
        else body.max_tokens = room;
        continue;
      }
      if (!text) {
        throw new HttpError(502, 'upstream_error', thought ? 'The model spent its answer thinking. Pick a model without thinking.' : 'The model returned an empty answer');
      }
      return { text, model: j.model ?? brain.model, usage: j.usage };
    }
    const msg = upstreamMessage(res, '').toLowerCase();
    const named = res.status === 400 || res.status === 422;
    if (named && msg.includes('max_tokens') && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    } else if (((named && msg.includes('response_format')) || /repeat|loop/.test(msg)) && body.response_format) {
      delete body.response_format;
    } else if (named && msg.includes('temperature') && body.temperature !== undefined) {
      delete body.temperature;
    } else if (named && msg.includes('reasoning') && body.reasoning_effort !== undefined) {
      delete body.reasoning_effort;
    } else {
      throw upstreamError(res, brain.name || 'The model');
    }
  }
  throw new HttpError(502, 'upstream_error', 'The model kept rejecting the request');
}

async function anthropicChat(ctx, brain, req) {
  if (!brain.apiKey) throw new HttpError(400, 'missing_key', 'Add your Anthropic API key first');
  const messages = req.messages.filter((m) => m.role !== 'system');
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: 'Go ahead.' });
  const extraSystem = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const system = [req.system, ...extraSystem, req.json ? 'Reply with one JSON object only, no prose, no code fences.' : '']
    .filter(Boolean)
    .join('\n\n');
  const body = { model: brain.model, max_tokens: req.maxTokens, system, messages };
  const temperature = req.temperature ?? brain.temperature;
  if (typeof temperature === 'number') body.temperature = Math.min(1, temperature);
  const res = await userRequest(ctx, `${anthropicBase(brain)}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': brain.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    timeoutMs: 90000,
  });
  if (res.status < 200 || res.status >= 300) throw upstreamError(res, brain.name || 'Claude');
  const j = jsonOf(res);
  const text = (j?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, model: j?.model ?? brain.model, usage: j?.usage };
}

async function listModels(ctx, brain) {
  if (brain.kind === 'anthropic') {
    const res = await userRequest(ctx, `${anthropicBase(brain)}/v1/models?limit=100`, {
      headers: { 'x-api-key': brain.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    });
    if (res.status !== 200) throw upstreamError(res, brain.name || 'Claude');
    return (jsonOf(res)?.data ?? []).map((m) => m.id).filter(Boolean);
  }
  const headers = brain.apiKey ? { authorization: `Bearer ${brain.apiKey}` } : {};
  const res = await userRequest(ctx, joinUrl(brain.baseUrl, 'models'), { headers });
  if (res.status !== 200) throw upstreamError(res, brain.name || 'The provider');
  const j = jsonOf(res);
  const list = Array.isArray(j) ? j : (j?.data ?? j?.models ?? []);
  return list.map((m) => (typeof m === 'string' ? m : (m.id ?? m.name))).filter(Boolean).sort();
}

export async function aiRoutes(app) {
  const ctx = app.egressCtx;

  app.post('/api/ai/chat', async (req) => {
    const user = requireUser(req);
    const brain = resolveBrain(app, user.id, req.body);
    if (brain.kind === 'chatgpt') {
      // the signed-in user's own ChatGPT plan (never another user's: the session picks the account)
      if (!brain.model) throw new HttpError(400, 'invalid_brain', 'Pick a model first');
      return app.chatgpt.chat(user.id, {
        model: brain.model,
        system: String(req.body?.system ?? ''),
        messages: readMessages(req.body),
        json: req.body?.json === true,
        force: req.body?.force === true,
      });
    }
    if (brain.kind === 'hostcaster') {
      // online edition: Host-Caster AI, included with the plan (the server picks the model, the platform key pays)
      if (!app.included) throw new HttpError(400, 'unsupported_brain', 'Host-Caster AI is only on the Host-Caster online service');
      return app.included.chat(user.id, {
        system: String(req.body?.system ?? ''),
        messages: readMessages(req.body),
        json: req.body?.json === true,
        maxTokens: Math.max(1, Math.min(2048, Number(req.body?.maxTokens ?? 600))),
        temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : undefined,
      });
    }
    if (brain.kind !== 'openai' && brain.kind !== 'anthropic') {
      throw new HttpError(400, 'unsupported_brain', 'This brain does not run on the server');
    }
    if (brain.kind === 'openai' && !brain.baseUrl) throw new HttpError(400, 'invalid_brain', 'The brain has no address');
    if (!brain.model) throw new HttpError(400, 'invalid_brain', 'Pick a model first');
    const maxTokens = Math.max(1, Math.min(8192, Number(req.body?.maxTokens ?? 600)));
    const chatReq = {
      system: String(req.body?.system ?? ''),
      messages: readMessages(req.body),
      json: req.body?.json === true,
      maxTokens,
      temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : undefined,
    };
    return brain.kind === 'anthropic' ? anthropicChat(ctx, brain, chatReq) : openaiChat(ctx, brain, chatReq);
  });

  app.post('/api/ai/models', async (req) => {
    const user = requireUser(req);
    const brain = resolveBrain(app, user.id, req.body);
    if (brain.kind === 'chatgpt') return { models: (await app.chatgpt.models(user.id)).map((m) => m.slug) };
    if (brain.kind === 'hostcaster') return { models: app.included ? ['hostcaster'] : [] };
    if (brain.kind !== 'openai' && brain.kind !== 'anthropic') return { models: [] };
    if (brain.kind === 'openai' && !brain.baseUrl) throw new HttpError(400, 'invalid_brain', 'The brain has no address');
    return { models: await listModels(ctx, brain) };
  });
}
