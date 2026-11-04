import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, request } from './client';

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    api.configure({ baseUrl: '', session: undefined });
  });

  it('gives every write a JSON body (Android native HTTP sends bodyless POST/DELETE as a form: 415)', async () => {
    const seen: { method: string; type?: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ method: init.method ?? 'GET', type: headers['Content-Type'], body: init.body as string | undefined });
      return new Response(null, { status: 204 });
    });
    api.configure({ baseUrl: 'http://server.test', session: { token: 't' } as never });
    await request('POST', '/api/auth/logout');
    await request('DELETE', '/api/inbox/1');
    await request('PUT', '/api/secrets/k', { value: 'v' });
    await request('GET', '/api/me');
    expect(seen).toEqual([
      { method: 'POST', type: 'application/json', body: '{}' },
      { method: 'DELETE', type: 'application/json', body: '{}' },
      { method: 'PUT', type: 'application/json', body: '{"value":"v"}' },
      { method: 'GET', type: undefined, body: undefined },
    ]);
  });
});

describe('api.probe', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    api.configure({ baseUrl: '', session: undefined });
  });

  it('a server that did not answer is looked for again by itself (the app woke before the network was back)', async () => {
    vi.useFakeTimers();
    let up = false;
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      if (!up) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ version: 't', edition: 'online' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    api.configure({ baseUrl: 'http://server.test' });
    await api.probe();
    expect(api.available).toBe(false);
    up = true;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(api.available).toBe(true);
    expect(api.config?.version).toBe('t');
    // once reachable, no more looking
    const n = seen.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(seen.length).toBe(n);
  });

  it('looks again at once when the device is back online', async () => {
    let up = false;
    vi.stubGlobal('fetch', async () => {
      if (!up) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ version: 'u' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    api.configure({ baseUrl: 'http://server.test' });
    await api.probe();
    expect(api.available).toBe(false);
    up = true;
    win.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(api.available).toBe(true));
  });
});
