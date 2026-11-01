// core/ai: one entry point for every brain kind and transport.
// transport 'device' = direct fetch (CapacitorHttp on native); 'server' = the Host-Caster server holds the key.
import { aiProxy, api } from '../api';
import { helperRequest } from '../api/helper';
import { isDesktop } from '../native/desktop';
import type { Brain, GenerateRequest } from '../types';
import { anthropicChat, anthropicModels } from './anthropic';
import { isFallback } from './brains';
import { mergeSignal, ProviderError, type FetchOpts } from './http';
import { openaiChat, openaiModels } from './openai';

/** The scripted fallback does not take prompts; the radio uses its template writer instead. */
export class NoModelError extends Error {
  override name = 'NoModelError';
}

export interface GenerateOptions {
  signal?: AbortSignal;
  /** default 45 s (local models can take a while to load) */
  timeoutMs?: number;
  /** ChatGPT plan: try even while paused after a usage-limit answer (Test) */
  force?: boolean;
}

/** The desktop app runs ChatGPT plan brains in its local helper, which holds the ChatGPT sign-in on that computer. */
const viaHelper = (brain: Brain) => isDesktop && brain.kind === 'chatgpt';

/** ChatGPT plan brains always run on the server, which holds the user's ChatGPT sign-in; so does Host-Caster AI. */
const viaServer = (brain: Brain) => brain.transport === 'server' || brain.kind === 'chatgpt' || brain.kind === 'hostcaster';

function needsServer(brain: Brain): void {
  if (brain.kind === 'chatgpt' && !api.session) throw new ProviderError('Your ChatGPT plan runs through your Host-Caster server. Sign in to it in Settings, Account.');
  if (brain.kind === 'hostcaster' && !api.session) throw new ProviderError('Host-Caster AI needs you signed in to Host-Caster.');
  if (!api.available) throw new ProviderError(`${brain.name} runs through your Host-Caster server, which is not reachable`);
}

/** Returns the model's text (a JSON string when req.json). */
export async function generate(brain: Brain, req: GenerateRequest, opts: GenerateOptions = {}): Promise<string> {
  if (isFallback(brain)) throw new NoModelError('No AI brain: the scripted fallback writes these lines');
  if (brain.kind === 'connector') throw new NoModelError(`${brain.name} sends notes; it does not write breaks`);
  const fo: FetchOpts = { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 45_000 };
  if (viaHelper(brain)) {
    const res = await helperRequest<{ text: string }>(
      'POST',
      '/api/ai/chat',
      { brain: { kind: brain.kind, model: brain.model }, system: req.system, messages: req.messages, json: req.json, ...(opts.force ? { force: true } : {}) },
      { timeoutMs: 100_000, signal: mergeSignal(fo) },
    );
    return res.text;
  }
  if (viaServer(brain)) {
    needsServer(brain);
    const res = await aiProxy.chat(
      { brainId: brain.id, system: req.system, messages: req.messages, json: req.json, maxTokens: req.maxTokens, ...(opts.force ? { force: true } : {}) },
      // the server would wait up to 100 s; the radio's budget (a song's end) is often shorter
      { signal: mergeSignal(fo), brain: { ...brain, transport: 'server' } },
    );
    return res.text;
  }
  if (brain.kind === 'anthropic') return anthropicChat(brain, req, fo);
  return openaiChat(brain, req, fo);
}

export async function listModels(brain: Brain, opts: GenerateOptions = {}): Promise<string[]> {
  if (isFallback(brain) || brain.kind === 'connector') return [];
  const fo: FetchOpts = { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 15_000 };
  if (viaHelper(brain)) return (await helperRequest<{ models: string[] }>('POST', '/api/ai/models', {}, { signal: mergeSignal(fo) })).models.filter(isChatModel);
  if (viaServer(brain)) {
    needsServer(brain);
    return (await aiProxy.models(brain.id, { ...brain, transport: 'server' })).models.filter(isChatModel);
  }
  return (brain.kind === 'anthropic' ? await anthropicModels(brain, fo) : await openaiModels(brain, fo)).filter(isChatModel);
}

/** Model lists mix in embedding, speech and image models (Ollama, OpenAI) that cannot write a break. */
export function isChatModel(id: string): boolean {
  return !/embed|(^|[-_:/.])(bge|rerank(er)?|whisper|tts|dall-e|moderation|transcribe)([-_:/.]|$)/i.test(id);
}

export interface BrainTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
  /** what the model said */
  sample?: string;
}

/** Tiny generate() call: proves the address, key and model all work. */
export async function testBrain(brain: Brain): Promise<BrainTestResult> {
  if (isFallback(brain)) return { ok: true, latencyMs: 0, message: 'The scripted fallback works offline, always.' };
  const t0 = Date.now();
  try {
    const sample = await generate(
      brain,
      {
        system: 'You are a host on Host-Caster radio doing a microphone check. Answer in one short spoken sentence. No placeholders like [name], no emojis.',
        messages: [{ role: 'user', content: 'Mic check. Say hello to the listener.' }],
        maxTokens: 60,
      },
      { timeoutMs: 60_000, force: true },
    );
    const latencyMs = Date.now() - t0;
    return { ok: true, latencyMs, message: `Works. Answered in ${(latencyMs / 1000).toFixed(1)} s.`, sample: sample.slice(0, 200) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, message: err instanceof Error ? err.message : String(err) };
  }
}
