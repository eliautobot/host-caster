import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDb, kvSet } from '../db';

const calls: { method: string; path: string; body?: unknown }[] = [];
const links = vi.hoisted(() => ({ cb: undefined as ((url: string) => void) | undefined }));

vi.mock('../native', async (orig) => ({
  ...(await orig<typeof import('../native')>()),
  isNative: true,
  onDeepLink: (cb: (url: string) => void) => {
    links.cb = cb;
    return () => {};
  },
  openAuthUrl: vi.fn(async () => {}),
}));
vi.mock('./client', async (orig) => {
  const real = await orig<typeof import('./client')>();
  return {
    ...real,
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === '/api/notion/start') return { url: 'https://api.notion.com/v1/oauth/authorize?x=1' };
      return {};
    }),
  };
});

const { listenForNotionLinks, notion } = await import('./notion');

const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  calls.length = 0;
  await db.delete();
  await initDb();
});

describe('Notion on the phone', () => {
  it('finishes a consent that comes back on a cold start, once the sign-in is restored', async () => {
    // the verifier saved by Connect survives the app being stopped (it lives in the database)
    await kvSet('notion:pkce', { verifier: 'v-123', at: Date.now() });
    let signedIn!: () => void;
    const ready = new Promise<void>((r) => (signedIn = r));
    const seen: unknown[] = [];
    const off = notion.on('change', (e) => seen.push(e));
    listenForNotionLinks(() => ready);
    expect(links.cb).toBeTypeOf('function');

    links.cb!('hostcaster://notion?code=abc');
    await flush();
    expect(calls).toEqual([]); // not before the saved sign-in is back

    signedIn();
    await flush();
    expect(calls).toEqual([{ method: 'POST', path: '/api/notion/finish', body: { code: 'abc', verifier: 'v-123' } }]);
    expect(seen).toEqual([{ connected: true, link: true }]);
    off();
  });

  it('reports a cancel on Notion with its code, and ignores other links', async () => {
    const seen: { error?: string; code?: string; link?: boolean }[] = [];
    const off = notion.on('change', (e) => seen.push(e));
    listenForNotionLinks();
    links.cb!('hostcaster://auth?code=zzz');
    links.cb!('hostcaster://notion?error=access_denied');
    await flush();
    expect(calls).toEqual([]);
    expect(seen).toEqual([{ error: 'You cancelled on Notion. Nothing was connected.', code: 'access_denied', link: true }]);
    off();
  });

  it('sends the listener time zone, so "edited today" follows their calendar', async () => {
    await notion.pages('groceries');
    await notion.context();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const [pages, context] = calls.map((c) => new URL(c.path, 'https://x'));
    expect(pages!.pathname).toBe('/api/notion/pages');
    expect(pages!.searchParams.get('q')).toBe('groceries');
    expect(pages!.searchParams.get('tz')).toBe(tz);
    expect(context!.pathname).toBe('/api/notion/context');
    expect(context!.searchParams.get('tz')).toBe(tz);
  });
});
