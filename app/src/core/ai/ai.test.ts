import { afterEach, describe, expect, it, vi } from 'vitest';
import { hosts } from '../radio/fixtures';
import { chimeNotes, encodeWav, identChime, renderChime } from '../radio/chime';
import type { Brain, VoiceProvider } from '../types';
import { kokoroVoice } from '../voice/presets';
import { speechText, voiceInstructions } from '../voice/style';
import { synthesize } from '../voice/voice';
import { FALLBACK_BRAIN } from './brains';
import { generate, listModels, NoModelError, testBrain } from './generate';
import { extractJson } from './json';
import { stripThinking } from './openai';

const brain = (patch: Partial<Brain> = {}): Brain => ({
  id: 'b1', name: 'Ollama', kind: 'openai', preset: 'ollama', baseUrl: 'http://lan:11434/v1', model: 'gemma3', transport: 'device', createdAt: 0, updatedAt: 0, ...patch,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('json + text helpers', () => {
  it('extracts JSON from fences and prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"lines":[{"t":"x}"}]} done')).toEqual({ lines: [{ t: 'x}' }] });
    expect(extractJson('no json')).toBeUndefined();
  });
  it('strips reasoning blocks', () => {
    expect(stripThinking('<think>plan</think>\nHello')).toBe('Hello');
  });
});

describe('generate', () => {
  it('calls OpenAI-compatible chat completions with JSON mode and retries without it when refused', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (body.response_format) return json({ error: { message: 'response_format is not supported' } }, 400);
      return json({ choices: [{ message: { content: '{"lines":[]}' } }] });
    }));
    const cloud = brain({ preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' });
    const out = await generate(cloud, { system: 'S', messages: [{ role: 'user', content: 'U' }], json: true, maxTokens: 100 });
    expect(out).toBe('{"lines":[]}');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: 'gemma3', max_tokens: 100, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
    // local servers never get JSON mode (Ollama loops on it with small models)
    await generate(brain(), { system: 'S', messages: [], json: true, maxTokens: 10 });
    expect(calls[2]!.response_format).toBeUndefined();
  });

  it('asks Ollama for no thinking, and gives a thinking model room when it ran out', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) return json({ choices: [{ message: { content: '', reasoning: 'Let me think...' }, finish_reason: 'length' }] });
      return json({ choices: [{ message: { content: 'Hello night owls.' }, finish_reason: 'stop' }] });
    }));
    expect(await generate(brain(), { system: 'S', messages: [], maxTokens: 100 })).toBe('Hello night owls.');
    expect(calls[0]!.reasoning_effort).toBe('none');
    expect(calls[1]!.max_tokens).toBe(1024);
    // cloud brains keep their own defaults
    await generate(brain({ preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' }), { system: 'S', messages: [], maxTokens: 10 });
    expect(calls[2]!.reasoning_effort).toBeUndefined();
    expect(calls[2]!.reasoning).toBeUndefined();
  });

  it('turns thinking off on OpenRouter, and retries an empty answer cut at the budget even when the thoughts are hidden', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) return json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
      return json({ choices: [{ message: { content: 'Back with you.' }, finish_reason: 'stop' }] });
    }));
    const or = brain({ preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6-luna' });
    expect(await generate(or, { system: 'S', messages: [], maxTokens: 100 })).toBe('Back with you.');
    expect(calls[0]!.reasoning).toEqual({ enabled: false });
    expect(calls[1]!.max_tokens).toBe(1024);
  });

  it('uses max_completion_tokens for OpenAI and the Messages API for Claude', async () => {
    const seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
      return url.includes('anthropic') ? json({ content: [{ type: 'text', text: 'Hi from Claude' }] }) : json({ choices: [{ message: { content: 'Hi' } }] });
    }));
    await generate(brain({ preset: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }), { system: 's', messages: [], maxTokens: 50 });
    expect(seen[0]!.body.max_completion_tokens).toBe(50);
    expect(seen[0]!.headers.Authorization).toBe('Bearer k');
    const text = await generate(brain({ kind: 'anthropic', preset: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'a', model: 'claude-haiku-4-5' }), { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 50 });
    expect(text).toBe('Hi from Claude');
    expect(seen[1]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[1]!.headers['x-api-key']).toBe('a');
    expect(seen[1]!.body.system).toBe('s');
  });

  it('turns provider errors into readable messages and lists models', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/models') ? json({ data: [{ id: 'b' }, { id: 'models/a' }] }) : json({ error: { message: 'Invalid API key' } }, 401))));
    expect(await listModels(brain())).toEqual(['a', 'b']);
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: ['gemma3:4b-it-qat', 'nomic-embed-text:latest', 'bge-m3:567m-fp16', 'qwen3-embedding:4b', 'whisper-1', 'tts-1', 'gpt-4o-mini-tts', 'gpt-4o', 'llama3.2'].map((id) => ({ id })) })));
    expect(await listModels(brain())).toEqual(['gemma3:4b-it-qat', 'gpt-4o', 'llama3.2']);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/models') ? json({ data: [] }) : json({ error: { message: 'Invalid API key' } }, 401))));
    const r = await testBrain(brain());
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Invalid API key (HTTP 401)');
  });

  it('the scripted fallback never takes a prompt but always tests fine', async () => {
    await expect(generate(FALLBACK_BRAIN, { system: '', messages: [], maxTokens: 1 })).rejects.toBeInstanceOf(NoModelError);
    expect((await testBrain(FALLBACK_BRAIN)).ok).toBe(true);
  });
});

describe('voice', () => {
  const [maya] = hosts(1);

  it('builds TTS style instructions from the host and cleans text for speech', () => {
    expect(voiceInstructions(maya!)).toMatch(/You are Maya, a radio host/);
    expect(voiceInstructions({ ...maya!, voice: { ...maya!.voice, instructions: 'Whisper.' } })).toBe('Whisper.');
    expect(speechText('**Hey** 🎉 [music] there')).toBe('Hey there');
  });

  it('names Kokoro voices', () => {
    expect(kokoroVoice('af_heart')).toEqual({ id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'female' });
  });

  it('posts OpenAI-compatible speech requests (Kokoro) and returns audio', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
    }));
    const kokoro: VoiceProvider = { id: 'v', name: 'Kokoro', kind: 'openai-compatible', baseUrl: 'http://lan:8880/v1', model: 'kokoro', transport: 'device', createdAt: 0, updatedAt: 0 };
    const blob = await synthesize(kokoro, { ...maya!, voice: { ...maya!.voice, voiceProviderId: 'v', voiceId: 'af_heart' } }, 'Hello *there*');
    expect(blob.size).toBe(3);
    expect(url).toBe('http://lan:8880/v1/audio/speech');
    expect(body).toMatchObject({ model: 'kokoro', voice: 'af_heart', input: 'Hello there', response_format: 'mp3' });
    expect(body.instructions).toBeUndefined();
  });
});

describe('ident chime', () => {
  it('renders a short normalized WAV, different per station', () => {
    const samples = renderChime(chimeNotes('a'));
    expect(samples.length).toBeGreaterThan(44_100);
    expect(samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0)).toBeCloseTo(0.5, 2);
    const wav = encodeWav(samples);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(identChime('x').type).toBe('audio/wav');
  });
});
