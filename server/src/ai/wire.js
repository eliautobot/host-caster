// Tool calling on the wire, one shape for every brain kind (the app's core/agent/wire.ts speaks the same):
//   tools:    [{ name, description, parameters: JSON Schema object }]
//   messages: { role: 'user'|'assistant'|'system', content }  plain turns (as before)
//             { role: 'assistant', content, toolCalls: [{ id, name, args }] }  the model asked for lookups
//             { role: 'tool', toolCallId, name, content }  what a lookup found
//   answer:   { text, toolCalls?: [{ id, name, args }] }
// and the converters to OpenAI chat completions, Anthropic Messages and the Responses API (ChatGPT plan).
import { HttpError } from '../errors.js';

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
// the hosts' tool kit offers every tool this account can use (docs/AGENT.md); providers take 128
export const MAX_TOOLS = 64;
const MAX_TOOLS_SIZE = 64_000;
const MAX_CONTENT = 24_000;

const bad = (msg) => new HttpError(400, 'invalid_request', msg);

/** Validates `tools` (absent = none). */
export function readTools(body) {
  if (body?.tools === undefined || body.tools === null) return undefined;
  if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) throw bad(`tools must be a list of at most ${MAX_TOOLS}`);
  const tools = body.tools.map((t) => {
    if (!t || !NAME.test(String(t.name ?? ''))) throw bad('every tool needs a name (letters, digits, _ and -)');
    const parameters = t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters) ? t.parameters : { type: 'object', properties: {} };
    if (JSON.stringify(parameters).length > 4000) throw bad('a tool schema is too large');
    return { name: String(t.name), description: String(t.description ?? '').slice(0, 1000), parameters };
  });
  if (JSON.stringify(tools).length > MAX_TOOLS_SIZE) throw bad('the tools are too large together');
  return tools.length ? tools : undefined;
}

/** Validates messages: plain turns, assistant turns with tool calls, tool results. */
export function readMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) throw bad('messages is empty');
  if (messages.length > 60) throw bad('too many messages');
  return messages.map((m) => {
    if (!m || typeof m !== 'object') throw bad('messages must be [{ role, content }]');
    if (m.role === 'tool') {
      if (!NAME.test(String(m.name ?? '')) || typeof m.toolCallId !== 'string' || !m.toolCallId || typeof m.content !== 'string') {
        throw bad('a tool message needs toolCallId, name and content');
      }
      return { role: 'tool', toolCallId: m.toolCallId.slice(0, 120), name: m.name, content: m.content.slice(0, MAX_CONTENT) };
    }
    if (!['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string') throw bad('messages must be [{ role, content }]');
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const toolCalls = m.toolCalls.slice(0, 8).map((c) => {
        if (!c || typeof c.id !== 'string' || !c.id || !NAME.test(String(c.name ?? ''))) throw bad('a tool call needs id and name');
        return { id: c.id.slice(0, 120), name: c.name, args: c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args : {} };
      });
      return { role: 'assistant', content: m.content, toolCalls };
    }
    return { role: m.role, content: m.content };
  });
}

/** Characters in a conversation (budgets). */
export const sizeOf = (system, messages) =>
  String(system ?? '').length + messages.reduce((n, m) => n + String(m.content ?? '').length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0);

/** A model's arguments string -> object (models sometimes send broken or empty JSON). */
export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw ?? '').trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    try {
      return m ? JSON.parse(m[0]) : {};
    } catch {
      return {};
    }
  }
}

// ---- OpenAI chat completions (OpenAI, OpenRouter, Ollama, LM Studio, vLLM ...) ----------------------------------------

export function toOpenAITools(tools) {
  return tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** choice.message.tool_calls -> [{ id, name, args }] */
export function fromOpenAIToolCalls(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls
    .filter((c) => c?.function?.name)
    .slice(0, 8)
    .map((c, i) => ({ id: String(c.id || `call_${Date.now().toString(36)}_${i}`), name: String(c.function.name), args: parseArgs(c.function.arguments) }));
}

// ---- Anthropic Messages -------------------------------------------------------------------------------------------

export function toAnthropicTools(tools) {
  return tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/** Tool results become user turns with tool_result blocks (consecutive ones in one turn, as Anthropic requires). */
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(nothing)' };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} }))],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: 'Go ahead.' });
  return out;
}

export function fromAnthropicContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use' && b.name).slice(0, 8).map((b) => ({ id: String(b.id), name: String(b.name), args: parseArgs(b.input) })),
  };
}

// ---- Responses API (ChatGPT plan) ---------------------------------------------------------------------------------

export function toResponsesTools(tools) {
  return tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

export function toResponsesInput(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      continue;
    }
    const role = m.role === 'system' ? 'developer' : m.role;
    if (m.content) out.push({ role, content: m.content });
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const c of m.toolCalls) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    }
  }
  return out;
}

/** function_call items of a completed response -> [{ id, name, args }] */
export function fromResponsesOutput(output) {
  return (Array.isArray(output) ? output : [])
    .filter((o) => o?.type === 'function_call' && o.name)
    .slice(0, 8)
    .map((o) => ({ id: String(o.call_id || o.id), name: String(o.name), args: parseArgs(o.arguments) }));
}

/** A provider's refusal that is about tools (the app then switches that brain to the JSON way of asking). */
export const TOOLS_REFUSED = /tool|function[_ ]call|functions? (are|is) not supported|does not support (tools|functions)/i;
