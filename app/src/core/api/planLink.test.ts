// The phone apps' plan link: a signed-in hand-off to the website's plan page, the fallback for a server without it,
// the site name the button shows, and coming back re-reading the plan.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';

const calls: { method: string; path: string; body?: unknown }[] = [];
const reply = vi.hoisted(() => ({ handoff: undefined as undefined | (() => unknown) }));
const native = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('../native', async (orig) => ({
  ...(await orig<typeof import('../native')>()),
  isNative: true,
  openAuthUrl: vi.fn(async (url: string) => {
    native.opened.push(url);
  }),
}));
vi.mock('./client', async (orig) => {
  const real = await orig<typeof import('./client')>();
  return {
    ...real,
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === '/api/handoff') return reply.handoff?.();
      if (path === '/api/billing/sync') return { plan: 'both', from: 'stripe' };
      if (path === '/api/billing/status') return { plan: null, from: 'stored' };
      return {};
    }),
  };
});

const { api } = await import('./client');
const { online, planSiteName } = await import('./online');

beforeEach(() => {
  calls.length = 0;
  native.opened.length = 0;
  api.configure({ baseUrl: 'https://app.host-caster.com' });
});

describe('the plan link', () => {
  it('asks the server for a one-time hand-off and opens it in the system browser', async () => {
    reply.handoff = () => ({ url: 'https://app.host-caster.com/auth/handoff?code=abc', expiresIn: 120 });
    const before = Date.now();
    await online.openWebsite();
    expect(calls).toEqual([{ method: 'POST', path: '/api/handoff', body: { to: '/settings/plan' } }]);
    expect(native.opened).toEqual(['https://app.host-caster.com/auth/handoff?code=abc']);
    expect(online.handedOffAt()).toBeGreaterThanOrEqual(before);
  });

  it('opens the plan page signed out on a server from before the hand-off (404)', async () => {
    reply.handoff = () => {
      throw new ApiError(404, 'not_found', 'Not found');
    };
    await online.openWebsite();
    expect(native.opened).toEqual(['https://app.host-caster.com/#/settings/plan']);
  });

  it('does not open anything when the server refuses (rate limit, offline) or answers with a non-web URL', async () => {
    reply.handoff = () => {
      throw new ApiError(429, 'rate_limited', 'Too many requests');
    };
    await expect(online.openWebsite()).rejects.toThrow(/Too many/);
    expect(native.opened).toEqual([]);
    reply.handoff = () => ({ url: 'javascript:alert(1)' });
    await online.openWebsite();
    expect(native.opened).toEqual(['https://app.host-caster.com/#/settings/plan']);
  });

  it('names the website the way people type it', () => {
    expect(planSiteName()).toBe('host-caster.com');
    api.configure({ baseUrl: 'https://www.radio.example.org' });
    expect(planSiteName()).toBe('radio.example.org');
    api.configure({ baseUrl: 'http://127.0.0.1:8731' });
    expect(planSiteName()).toBe('127.0.0.1:8731');
  });
});

describe('coming back from the website', () => {
  it('re-reads the plan from Stripe soon after the plan link, the stored plan otherwise', async () => {
    const { refreshOnReturn, HANDOFF_FRESH_MS } = await import('@/state/plan');
    const { api: realApi } = await import('./client');
    realApi.configure({ session: { user: { id: 'u1', emailVerified: true } } as never });
    (realApi as unknown as { config: unknown }).config = { edition: 'online' };
    (realApi as unknown as { available: boolean }).available = true;
    reply.handoff = () => ({ url: 'https://app.host-caster.com/auth/handoff?code=x' });
    await online.openWebsite();
    calls.length = 0;
    await refreshOnReturn();
    expect(calls.map((c) => c.path)).toEqual(['/api/billing/sync']);
    calls.length = 0;
    await refreshOnReturn(Date.now() + HANDOFF_FRESH_MS + 1000);
    expect(calls.map((c) => c.path)).toEqual(['/api/billing/status']);
  });
});
