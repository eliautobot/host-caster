// ChatGPT plan brains on the app side: they always go through the Host-Caster server (never straight to OpenAI from
// this device), Test may ask while the plan is paused, and a usage limit gives Home a Manage usage link.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api/client';
import { getPreset } from './presets';
import { skippedNotice, standInNotice } from '../radio/notice';
import type { Brain } from '../types';
import { generate, listModels, testBrain } from './generate';

const plan = (patch: Partial<Brain> = {}): Brain => ({
  id: 'gpt', name: 'ChatGPT plan', kind: 'chatgpt', preset: 'chatgpt', model: 'gpt-6.1-sol', transport: 'device', createdAt: 0, updatedAt: 0, ...patch,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ChatGPT plan brain', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let answer: () => Response;
  beforeEach(() => {
    calls.length = 0;
    answer = () => json(200, { text: 'Hello from the plan.' });
    api.available = true;
    api.configure({ baseUrl: '', session: { user: { id: 'u1', name: 'Sam', providers: ['local'] }, kind: 'web' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      if (String(url).endsWith('/api/ai/models')) return json(200, { models: ['gpt-6.1-sol', 'gpt-6.1-luna'] });
      return answer();
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    api.configure({ session: undefined });
  });

  it('is a subscription preset with no key and no address', () => {
    expect(getPreset('chatgpt')).toMatchObject({ kind: 'chatgpt', group: 'plan', keyRequired: false, baseUrl: '' });
  });

  it('runs through the server even when the record says device', async () => {
    expect(await generate(plan(), { system: 'Be a host.', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 80 })).toBe('Hello from the plan.');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/ai/chat');
    expect(calls[0]!.body).toMatchObject({ brainId: 'gpt', system: 'Be a host.', brain: { kind: 'chatgpt', transport: 'server', model: 'gpt-6.1-sol' } });
    expect(calls[0]!.body.force).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body.brain)).not.toMatch(/apiKey/);
    expect(await listModels(plan())).toEqual(['gpt-6.1-sol', 'gpt-6.1-luna']);
  });

  it('Test asks even while the plan is paused after a limit', async () => {
    const r = await testBrain(plan());
    expect(r.ok).toBe(true);
    expect(calls[0]!.body.force).toBe(true);
  });

  it('a usage limit comes back as a chatgpt_limit ApiError with the message', async () => {
    answer = () => json(429, { error: { code: 'chatgpt_limit', message: "ChatGPT usage limit reached. Review your plan or this app's limit in ChatGPT settings." } });
    const err = await generate(plan(), { system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('chatgpt_limit');
    expect((err as ApiError).status).toBe(429);
    const t = await testBrain(plan());
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/usage limit reached/);
  });

  it('needs a Host-Caster sign-in (the server keeps the ChatGPT sign-in)', async () => {
    api.configure({ session: undefined });
    await expect(generate(plan(), { system: 's', messages: [], maxTokens: 10 })).rejects.toThrow(/Sign in to it in Settings, Account/);
    expect(calls).toHaveLength(0);
  });
});

describe('stand-in notices', () => {
  it('names who stood in and links Manage usage for a plan limit', () => {
    const limit = standInNotice({ standIn: 'ChatGPT usage limit reached.', standInFor: { brain: true }, standInCode: 'chatgpt_limit' });
    expect(limit.notice).toBe('The scripted fallback stood in: ChatGPT usage limit reached.');
    expect(limit.noticeLink).toEqual({ label: 'Manage usage', url: 'https://chatgpt.com/settings/usage' });
    const signedOut = standInNotice({ standIn: 'Your ChatGPT sign-in expired.', standInFor: { brain: true }, standInCode: 'chatgpt_signed_out' });
    expect(signedOut.noticeLink).toBeUndefined();
    expect(standInNotice({ standIn: 'Kokoro is off', standInFor: { voice: true } }).notice).toBe('This device’s voice stood in: Kokoro is off');
    expect(standInNotice({ standIn: 'offline', standInFor: { brain: true, voice: true } }).notice).toMatch(/^The scripted fallback and this device’s voice/);
    expect(standInNotice({})).toEqual({});
    expect(skippedNotice('x', 'chatgpt_limit').noticeLink?.label).toBe('Manage usage');
  });
});
