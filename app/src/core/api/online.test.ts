// Online edition on the app side: Host-Caster AI and Host-Caster Voices always go through the Host-Caster service (never straight
// to a provider from this device), a used-up budget gives Home a "See your plan" link, and meters read as hours.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { hoursText, isIncludedCode } from './online';
import { skippedNotice, standInNotice } from '../radio/notice';
import { generate } from '../ai/generate';
import { listVoices, synthesize } from '../voice/voice';
import type { Brain, Host, VoiceProvider } from '../types';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const hostCasterBrain: Brain = { id: 'aw', name: 'Host-Caster AI', kind: 'hostcaster', preset: 'hostcaster', model: 'hostcaster', transport: 'device', createdAt: 0, updatedAt: 0 };
const hostCasterVoices: VoiceProvider = { id: 'awv', name: 'Host-Caster Voices', kind: 'hostcaster', model: '', transport: 'device', createdAt: 0, updatedAt: 0 };

describe('included AI goes through the service', () => {
  const urls: string[] = [];
  let answer: (url: string) => Response;
  beforeEach(() => {
    urls.length = 0;
    answer = () => json(200, { text: 'Hello from Host-Caster AI.' });
    api.available = true;
    api.configure({ baseUrl: '', session: { user: { id: 'u1', name: 'Sam', providers: ['local'], emailVerified: true }, kind: 'web' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return answer(String(url));
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    api.configure({ baseUrl: '', session: undefined });
  });

  it('Host-Caster AI calls /api/ai/chat even when saved as device', async () => {
    const out = await generate(hostCasterBrain, { system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
    expect(out).toContain('Host-Caster AI');
    expect(urls.every((u) => u.endsWith('/api/ai/chat'))).toBe(true);
  });

  it('Host-Caster AI needs a signed-in account', async () => {
    api.configure({ baseUrl: '', session: undefined });
    await expect(generate(hostCasterBrain, { system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 })).rejects.toThrow(/signed in/);
    expect(urls).toHaveLength(0);
  });

  it('a used-up budget keeps its code for the stand-in notice', async () => {
    answer = () => json(402, { error: { code: 'included_budget_reached', message: 'You used this month’s Host-Caster AI.' } });
    const err = (await generate(hostCasterBrain, { system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }).then(() => ({}), (e: unknown) => e)) as { code?: string };
    expect(err.code).toBe('included_budget_reached');
  });

  it('Host-Caster Voices call /api/tts', async () => {
    answer = () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    const host = { id: 'h', name: 'Maya', voice: { voiceProviderId: 'awv', voiceId: 'voxtral-sheila', speed: 1 } } as unknown as Host;
    await synthesize(hostCasterVoices, host, 'Hello there.').catch(() => undefined);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.endsWith('/api/tts'))).toBe(true);
  });

  it('the voice list keeps premium marks, retired ids and each premium voice\'s standard stand-in', async () => {
    answer = () =>
      json(200, {
        voices: [
          { id: 'voxtral-sheila', name: 'Sheila', gender: 'female', language: 'en-US', premium: false, replaces: ['kokoro-heart', 7] },
          { id: 'eleven-sarah', name: 'Sarah', gender: 'female', language: 'en-US', premium: true, standIn: { id: 'voxtral-sheila', name: 'Sheila' } },
          { id: 'eleven-odd', name: 'Odd', premium: true, standIn: { id: 3 } },
        ],
      });
    const list = await listVoices(hostCasterVoices);
    expect(urls.at(-1)).toMatch(/\/api\/tts\/voices$/);
    expect(list[0]).toEqual({ id: 'voxtral-sheila', name: 'Sheila', gender: 'female', language: 'en-US', replaces: ['kokoro-heart'] });
    expect(list[1]).toEqual({ id: 'eleven-sarah', name: 'Sarah', gender: 'female', language: 'en-US', premium: true, standIn: { id: 'voxtral-sheila', name: 'Sheila' } });
    expect(list[2]!.standIn).toBeUndefined();
  });
});

describe('notices and meters', () => {
  it('included codes link to the plan page', () => {
    expect(isIncludedCode('included_budget_reached')).toBe(true);
    expect(isIncludedCode('chatgpt_limit')).toBe(false);
    expect(isIncludedCode(undefined)).toBe(false);
    const n = standInNotice({ standIn: 'You used this month’s Host-Caster AI.', standInFor: { brain: true }, standInCode: 'included_budget_reached' });
    expect(n.notice).toMatch(/^The scripted fallback stood in/);
    expect(n.noticeLink).toEqual({ label: 'See your plan', url: '/settings/plan' });
    expect(skippedNotice('Paused.', 'included_paused').noticeLink?.url).toBe('/settings/plan');
    expect(standInNotice({ standIn: 'Offline.', standInFor: { voice: true } }).noticeLink).toBeUndefined();
  });

  it('hours read naturally', () => {
    expect(hoursText(undefined)).toBe('');
    expect(hoursText(0.4)).toBe('less than an hour');
    expect(hoursText(1)).toBe('about 1 hour');
    expect(hoursText(430)).toBe('about 430 hours');
  });
});
