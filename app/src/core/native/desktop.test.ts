import { afterEach, describe, expect, it, vi } from 'vitest';

type Call = [string, RequestInit | undefined];

function stubDesktop(answer: () => Response = () => new Response('{}', { headers: { 'content-type': 'application/json' } })) {
  const calls: Call[] = [];
  vi.stubGlobal('window', { hostcasterDesktop: { helper: { url: 'http://127.0.0.1:5555', token: 'launch-secret' }, platform: 'win32' } });
  vi.stubGlobal('location', { origin: 'app://host-caster' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push([String(url), init]);
      return answer();
    }),
  );
  return calls;
}

describe('desktop app helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('are off outside the desktop app', async () => {
    const m = await import('./desktop');
    expect(m.isDesktop).toBe(false);
    await expect(m.helperFetch('/health')).rejects.toThrow(/desktop/);
  });

  it('send other origins through the local helper with the launch secret; the provider key passes on', async () => {
    const calls = stubDesktop();
    const m = await import('./desktop');
    expect(m.isDesktop).toBe(true);
    expect(m.desktopOsName()).toBe('Windows');
    await m.desktopFetch('http://192.168.1.5:11434/v1/models', { headers: { Authorization: 'Bearer sk-x' } });
    expect(calls[0][0]).toBe('http://127.0.0.1:5555/proxy?url=http%3A%2F%2F192.168.1.5%3A11434%2Fv1%2Fmodels');
    const h = new Headers(calls[0][1]?.headers);
    expect(h.get('x-hc-helper')).toBe('launch-secret');
    expect(h.get('authorization')).toBe('Bearer sk-x');
    expect(calls[0][1]?.credentials).toBe('omit');
    // the app's own files go straight
    await m.desktopFetch('app://host-caster/manifest.webmanifest');
    expect(calls[1][0]).toBe('app://host-caster/manifest.webmanifest');
  });

  it('helperRequest answers like the server: JSON, errors as ApiError with the code', async () => {
    let next = new Response(JSON.stringify({ error: { code: 'chatgpt_limit', message: 'Usage limit' } }), { status: 429 });
    const calls = stubDesktop(() => next);
    const { helperRequest } = await import('../api/helper');
    const { ApiError } = await import('../api/client');
    const err = await helperRequest('POST', '/api/ai/chat', { brain: { model: 'm' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('chatgpt_limit');
    expect((err as InstanceType<typeof ApiError>).status).toBe(429);
    expect(calls[0][0]).toBe('http://127.0.0.1:5555/api/ai/chat');
    expect(new Headers(calls[0][1]?.headers).get('content-type')).toBe('application/json');
    next = new Response(JSON.stringify({ connected: true }));
    expect(await helperRequest('GET', '/api/chatgpt/status')).toEqual({ connected: true });
  });
});
