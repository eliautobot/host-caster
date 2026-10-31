// Reporting an AI break: the report the app builds (names, limits) and when it can be sent at all.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { REPORT_MAX_LINES, breakReport, canReport, reports } from './reports';
import type { Host } from '../types';

const host = (id: string, name: string) => ({ id, name }) as Host;
const hosts = [host('h1', 'Maya'), host('h2', 'Jules')];

describe('breakReport', () => {
  it('names the hosts, keeps the station and a trimmed note, drops empty lines', () => {
    const r = breakReport(
      [
        { hostId: 'h1', text: ' Good morning! ' },
        { hostId: 'gone', text: 'I used to be here.' },
        { hostId: 'h2', text: '   ' },
      ],
      hosts,
      { at: 5, stationName: 'Morning Drive', note: '  rude  ' },
    );
    expect(r).toEqual({
      kind: 'break',
      at: 5,
      stationName: 'Morning Drive',
      lines: [
        { hostName: 'Maya', text: 'Good morning!' },
        { hostName: 'A former host', text: 'I used to be here.' },
      ],
      note: 'rude',
    });
    expect(breakReport([{ hostId: 'h1', text: 'hi' }], hosts, { at: 1, note: ' ' })).not.toHaveProperty('note');
  });

  it('stays inside the server limits (20 lines, 8 KB)', () => {
    const lines = Array.from({ length: 30 }, () => ({ hostId: 'h1', text: 'x'.repeat(3000) }));
    const r = breakReport(lines, hosts, { at: 1, note: 'n'.repeat(5000) });
    expect(r.lines).toHaveLength(REPORT_MAX_LINES);
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThan(8 * 1024);
  });
});

describe('reports.send', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    api.available = false;
    api.configure({ baseUrl: '', session: undefined });
  });

  it('needs a server and an account (local-only mode cannot report)', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    api.available = false;
    expect(canReport()).toBe(false);
    await expect(reports.send(breakReport([{ hostId: 'h1', text: 'hi' }], hosts, { at: 1 }))).rejects.toMatchObject({ status: 401, message: 'Sign in to report a break' });
    api.available = true;
    expect(canReport()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the report with the CSRF header', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'r1', createdAt: 9 }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    api.available = true;
    api.configure({ baseUrl: '', session: { user: { id: 'u1', name: 'Sam', providers: ['local'], emailVerified: true }, kind: 'web' } });
    const out = await reports.send(breakReport([{ hostId: 'h1', text: 'hi' }], hosts, { at: 1 }));
    expect(out).toEqual({ id: 'r1', createdAt: 9 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/reports');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-HostCaster']).toBe('1');
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: 'break', lines: [{ hostName: 'Maya', text: 'hi' }] });
  });
});
