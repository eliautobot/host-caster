import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
vi.mock('../native', () => ({
  isNative: true,
  onDeepLink: () => () => undefined,
  openAuthUrl: async (url: string) => {
    opened.push(url);
  },
}));

const { auth, handleDeepLink } = await import('./auth');
const { api } = await import('./client');

const sha256 = async (text: string): Promise<string> => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

describe('native sign-in deep links', () => {
  let posted: { path: string; body: Record<string, unknown> }[];

  beforeEach(() => {
    posted = [];
    opened.length = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      if (path === '/api/config') return Response.json({ appScheme: 'hostcaster', version: 't', signIn: {} });
      if (init.method === 'POST') posted.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      if (path === '/api/auth/exchange') return Response.json({ user: { id: 'u1', name: 'Me' }, kind: 'app', token: 'tok' });
      return Response.json({ user: { id: 'u1', name: 'Me' }, kind: 'app' });
    });
    api.configure({ baseUrl: 'https://server.test', session: undefined });
    api.available = true;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('never exchanges a code this app did not ask for (login CSRF: a page opens hostcaster://auth?code=...)', async () => {
    await expect(handleDeepLink('hostcaster://auth?code=attackers-code')).rejects.toMatchObject({ code: 'not_started' });
    await expect(handleDeepLink('hostcaster://auth?linkcode=attackers-link')).rejects.toMatchObject({ code: 'not_started' });
    expect(posted).toEqual([]);
  });

  it('sends a challenge when it starts and the matching verifier with the code', async () => {
    const done = auth.signIn('google');
    await vi.waitFor(() => expect(opened.length).toBe(1));
    const cc = new URL(opened[0]).searchParams.get('cc');
    expect(cc).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await handleDeepLink('hostcaster://auth?code=real-code');
    await expect(done).resolves.toMatchObject({ token: 'tok' });
    const exchange = posted.find((p) => p.path === '/api/auth/exchange');
    expect(exchange?.body.code).toBe('real-code');
    expect(await sha256(String(exchange?.body.verifier))).toBe(cc);
    // used once: the same verifier does not sign in a second code
    await expect(handleDeepLink('hostcaster://auth?code=second-code')).rejects.toMatchObject({ code: 'not_started' });
  });

  it('shows only a code name for errors from a link, never its free text', async () => {
    const err = await handleDeepLink('hostcaster://auth?error=Your%20account%20is%20locked%2C%20call%20555').catch((e: Error) => e);
    expect(String((err as Error).message)).not.toMatch(/locked|555/);
  });
});
