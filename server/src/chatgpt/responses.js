// Responses API calls on a ChatGPT plan token: the model catalog and one streamed response read to the end.
// The plan route wants store false + stream true, instructions instead of system messages, and none of temperature,
// top_p, max_output_tokens, user, metadata ... Success is response.completed, nothing less.
import { bodyShape, chatgptError, responsesError, upstreamCode } from './errors.js';

const MAX_TEXT = 1024 * 1024;

async function readJson(res) {
  const text = await res.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return { detail: text.slice(0, 200) };
  }
}

const requestIdOf = (res) => res.headers.get('x-request-id') ?? res.headers.get('openai-request-id') ?? undefined;

/** A failure with what the docs ask us to keep for diagnosis (status, body shape, code, request id). */
function failure(err, diag) {
  return Object.assign(err, { diag });
}

async function send(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw failure(chatgptError.failed('ChatGPT took too long to answer.'), { status: 0 });
    throw failure(chatgptError.unavailable(), { status: 0 });
  }
}

/** GET /models: [{ slug, displayName }] in the server's order, only the ones meant for a picker. */
export async function listModels(apiBase, accessToken) {
  const res = await send(`${apiBase}/models`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } }, 15000);
  const body = await readJson(res);
  if (!res.ok) {
    throw failure(responsesError(res.status, body), { status: res.status, code: upstreamCode(body), shape: bodyShape(body), requestId: requestIdOf(res) });
  }
  if (!Array.isArray(body?.models)) throw chatgptError.failed('ChatGPT returned an unexpected model list.');
  return body.models
    .filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string' && m.slug.trim())
    .map((m) => ({ slug: m.slug, displayName: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name : m.slug }));
}

/** Server-sent events from a fetch body: yields parsed `data:` JSON objects. */
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        throw chatgptError.failed('ChatGPT sent a broken response stream. Try again.');
      }
    }
  }
}

/**
 * One streamed response, read through its terminal event.
 * @param {string} apiBase
 * @param {string} accessToken
 * @param {{ model: string, instructions: string, input: { role: 'user'|'assistant'|'developer', content: string }[],
 *   reasoning?: { effort: string }, text?: object }} req
 * @returns {Promise<{ text: string, model: string, usage?: object }>}
 */
export async function streamResponse(apiBase, accessToken, req, timeoutMs = 90000) {
  const body = {
    model: req.model,
    instructions: req.instructions,
    input: req.input.map((m) => ({ role: m.role, content: m.content })),
    store: false,
    stream: true,
    ...(req.reasoning ? { reasoning: req.reasoning } : {}),
    ...(req.text ? { text: req.text } : {}),
  };
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await send(
    `${apiBase}/responses`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    },
    timeoutMs,
  );
  const requestId = requestIdOf(res);
  if (!res.ok) {
    const errBody = await readJson(res);
    throw failure(responsesError(res.status, errBody), { status: res.status, code: upstreamCode(errBody), shape: bodyShape(errBody), requestId });
  }
  const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!res.body || (type && type !== 'text/event-stream')) {
    await res.body?.cancel().catch(() => undefined);
    throw failure(chatgptError.failed('ChatGPT did not answer with a response stream.'), { status: res.status, requestId });
  }
  let text = '';
  let completed;
  try {
    for await (const event of sseEvents(res.body)) {
      if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
        if (text.length > MAX_TEXT) throw chatgptError.failed('ChatGPT answered with far too much text.');
      } else if (event?.type === 'response.failed' || event?.type === 'error') {
        const detail = event.type === 'response.failed' ? event.response : event;
        throw failure(responsesError(0, detail), { status: res.status, code: upstreamCode(detail), shape: bodyShape(detail), requestId });
      } else if (event?.type === 'response.incomplete') {
        throw failure(chatgptError.failed('ChatGPT stopped before the answer was complete. Try again.'), { status: res.status, requestId });
      } else if (event?.type === 'response.completed') {
        completed = event.response ?? {};
        break;
      }
    }
  } catch (err) {
    if (err?.statusCode) throw err;
    throw failure(chatgptError.failed('The ChatGPT connection was interrupted. Try again.'), { status: res.status, requestId });
  } finally {
    res.body.cancel?.().catch?.(() => undefined);
  }
  if (!completed) throw failure(chatgptError.failed('The ChatGPT answer ended before it was complete. Try again.'), { status: res.status, requestId });
  if (!text) text = outputText(completed);
  return { text: text.trim(), model: completed.model ?? req.model, ...(completed.usage ? { usage: completed.usage } : {}) };
}

/** Text from a completed response object (when no deltas were streamed). */
function outputText(response) {
  const out = Array.isArray(response?.output) ? response.output : [];
  return out
    .filter((o) => o?.type === 'message')
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}
