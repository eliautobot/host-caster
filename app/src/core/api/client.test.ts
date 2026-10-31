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
