// OpenAI-compatible chat completions: OpenAI, Grok, Gemini, OpenRouter, Groq, Mistral, DeepSeek, Together, Ollama,
// LM Studio, llama.cpp, vLLM and any custom server.
import type { Brain, GenerateRequest } from '../types';
import { getJson, joinUrl, postJson, ProviderError, type FetchOpts } from './http';

interface ChatResponse {
  choices?: { message?: { content?: string | null; reasoning_content?: string; reasoning?: string }; finish_reason?: string }[];
}

/** Ollama: thinking models (gemma4, qwen3, deepseek-r1) answer at once with reasoning_effort "none". */
function isOllama(brain: Brain): boolean {
  return brain.preset === 'ollama' || /:11434(\/|$)/.test(brain.baseUrl ?? '');
}

function headers(brain: Brain): Record<string, string> {
  const h: Record<string, string> = {};
  if (brain.apiKey) h.Authorization = `Bearer ${brain.apiKey}`;
  if (brain.preset === 'openrouter') {
    h['X-Title'] = 'Host-Caster';
    if (typeof location !== 'undefined' && location.origin.startsWith('http')) h['HTTP-Referer'] = location.origin;
  }
  return h;
}

const LOCAL_PRESETS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'jan', 'custom']);

/** A model on this device or the local network (Ollama, LM Studio ...): free to call, may need a cold load. */
export function isLocal(brain: Brain): boolean {
  if (brain.preset && LOCAL_PRESETS.has(brain.preset)) return true;
  return /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(brain.baseUrl ?? '');
}

/** Removes reasoning blocks some local models print before the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export async function openaiChat(brain: Brain, req: GenerateRequest, opts: FetchOpts): Promise<string> {
  if (!brain.baseUrl) throw new ProviderError('This brain has no server address');
  const url = joinUrl(brain.baseUrl, 'chat/completions');
  // OpenAI's newer models only take max_completion_tokens; everyone else knows max_tokens.
  const tokenKey = brain.preset === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const body: Record<string, unknown> = {
    model: brain.model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    [tokenKey]: req.maxTokens,
    stream: false,
  };
  if (brain.temperature !== undefined) body.temperature = brain.temperature;
  // JSON mode: cloud APIs handle it well; local servers either loop on it (Ollama + small models) or want a
  // json_schema instead (LM Studio). The prompt asks for JSON and the parser is tolerant, so skip it locally.
  if (req.json && !isLocal(brain)) body.response_format = { type: 'json_object' };
  // radio lines need no chain of thought: it only adds seconds (and can eat the whole token budget)
  if (isOllama(brain)) body.reasoning_effort = 'none';
  // OpenRouter's switch for the same (thinking models answered in half the time, and stopped leaving empty answers)
  if (brain.preset === 'openrouter' || /^https:\/\/openrouter\.ai\//.test(brain.baseUrl)) body.reasoning = { enabled: false };
  let res: ChatResponse;
  try {
    res = await postJson<ChatResponse>(url, body, headers(brain), opts);
  } catch (err) {
    // Some servers reject response_format, temperature or reasoning_effort: retry once without them.
    const refused =
      err instanceof ProviderError && ((err.status === 400 && /response_format|json|temperature|reasoning/i.test(err.message)) || /repeat|loop/i.test(err.message));
    if (refused && err instanceof ProviderError) {
      delete body.response_format;
      if (/temperature/i.test(err.message)) delete body.temperature;
      if (/reasoning/i.test(err.message)) {
        delete body.reasoning_effort;
        delete body.reasoning;
      }
      res = await postJson<ChatResponse>(url, body, headers(brain), opts);
    } else throw err;
  }
  let choice = res.choices?.[0];
  // a thinking model that spent the whole budget thinking (its thoughts are not always sent back): once more with room
  if (!stripThinking(choice?.message?.content ?? '') && choice?.finish_reason === 'length') {
    body[tokenKey] = Math.min(4096, Math.max(1024, (req.maxTokens ?? 400) * 4));
    res = await postJson<ChatResponse>(url, body, headers(brain), opts);
    choice = res.choices?.[0];
  }
  const text = stripThinking(choice?.message?.content ?? '');
  if (!text) {
    const thought = Boolean(choice?.message?.reasoning || choice?.message?.reasoning_content);
    throw new ProviderError(thought ? 'The model spent its answer thinking. Pick a model without thinking, or a faster one.' : 'The model returned an empty answer');
  }
  return text;
}

export async function openaiModels(brain: Brain, opts: FetchOpts): Promise<string[]> {
  if (!brain.baseUrl) throw new ProviderError('This brain has no server address');
  const res = await getJson<{ data?: { id: string }[]; models?: { name?: string; id?: string }[] }>(
    joinUrl(brain.baseUrl, 'models'),
    headers(brain),
    opts,
  );
  const ids = res.data?.map((m) => m.id) ?? res.models?.map((m) => m.id ?? m.name ?? '') ?? [];
  // Gemini prefixes ids with "models/"; chat completions accepts both.
  return [...new Set(ids.filter(Boolean).map((id) => id.replace(/^models\//, '')))].sort((a, b) => a.localeCompare(b));
}
