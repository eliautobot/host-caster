// The phone app's requests to the Host-Caster server. Android's patched fetch hands POSTs to the native HTTP stack
// without the AbortSignal and without timeouts: one on a connection that died while the phone slept never ended, and
// the hosts' next break waited for it forever (seen on a tablet after a long pause, 11-03).
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@capacitor/core', async (orig) => ({ ...(await orig<object>()), CapacitorHttp: { request: native.request } }));
vi.mock('../native/platform', async (orig) => ({ ...(await orig<object>()), isNative: true }));

const { api, ApiError, request } = await import('./client');

describe('request on the phone app', () => {
  afterEach(() => {
    native.request.mockReset();
    vi.unstubAllGlobals();
    api.configure({ baseUrl: '', session: undefined });
  });

  it('sends writes straight to CapacitorHttp with connect and read timeouts, and reads the JSON answer', async () => {
    const patched = vi.fn();
    vi.stubGlobal('fetch', patched);
    native.request.mockResolvedValue({ status: 200, url: '', headers: { 'Content-Type': 'application/json' }, data: { text: 'hi' } });
    api.configure({ baseUrl: 'https://app.host-caster.test', session: { token: 't' } as never });
    const out = await request<{ text: string }>('POST', '/api/ai/chat', { messages: [] }, { timeoutMs: 45_000 });
    expect(out).toEqual({ text: 'hi' });
    expect(patched).not.toHaveBeenCalled();
    expect(native.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://app.host-caster.test/api/ai/chat', method: 'POST', connectTimeout: 45_000, readTimeout: 45_000 }),
    );
  });

  it('ends at its own limit when the native request never answers (a dead connection after a sleep)', async () => {
    // like Android: neither the native request nor the app's patched fetch ever answers, and neither looks at the stop
    native.request.mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    api.configure({ baseUrl: 'https://app.host-caster.test', session: { token: 't' } as never });
    const t = Date.now();
    const err = await request('POST', '/api/ai/chat', {}, { timeoutMs: 60 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('timeout');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("ends at the caller's limit too (a break's voice budget), as a timeout", async () => {
    native.request.mockReturnValue(new Promise(() => undefined));
    api.configure({ baseUrl: 'https://app.host-caster.test', session: { token: 't' } as never });
    const err = await request('POST', '/api/tts', {}, { raw: true, timeoutMs: 100_000, signal: AbortSignal.timeout(60) }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ApiError>).code).toBe('timeout');
  });

  it("a caller's stop (Next, a newer break) ends it with the caller's own reason", async () => {
    native.request.mockReturnValue(new Promise(() => undefined));
    api.configure({ baseUrl: 'https://app.host-caster.test', session: { token: 't' } as never });
    const stop = new AbortController();
    const p = request('POST', '/api/ai/chat', {}, { signal: stop.signal }).catch((e: unknown) => e);
    stop.abort(new Error('Break cancelled'));
    expect(((await p) as Error).message).toBe('Break cancelled');
  });
});
