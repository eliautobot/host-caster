// Anthropic Messages API (Claude).
import type { Brain, GenerateRequest } from '../types';
import { getJson, joinUrl, postJson, ProviderError, type FetchOpts } from './http';

interface MessagesResponse {
  content?: { type: string; text?: string }[];
}

export function headers(brain: Brain): Record<string, string> {
  return {
    'x-api-key': brain.apiKey ?? '',
    'anthropic-version': '2023-06-01',
    // direct from the browser / app on the device transport (the key stays on this device)
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

export const base = (brain: Brain) => brain.baseUrl || 'https://api.anthropic.com';

export async function anthropicChat(brain: Brain, req: GenerateRequest, opts: FetchOpts): Promise<string> {
  const system = req.json ? `${req.system}\n\nReply with one JSON object only, no other text.` : req.system;
  const body: Record<string, unknown> = {
    model: brain.model,
    max_tokens: req.maxTokens,
    system,
    messages: req.messages.filter((m) => m.role !== 'system'),
  };
  if (brain.temperature !== undefined) body.temperature = brain.temperature;
  const res = await postJson<MessagesResponse>(joinUrl(base(brain), 'v1/messages'), body, headers(brain), opts);
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
  if (!text) throw new ProviderError('Claude returned an empty answer');
  return text;
}

export async function anthropicModels(brain: Brain, opts: FetchOpts): Promise<string[]> {
  const res = await getJson<{ data?: { id: string }[] }>(joinUrl(base(brain), 'v1/models?limit=100'), headers(brain), opts);
  return (res.data ?? []).map((m) => m.id);
}
