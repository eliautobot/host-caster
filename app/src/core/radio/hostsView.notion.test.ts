import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDb, saveSettings } from '../db';

const NOW = new Date(2026, 9, 31, 22, 26).getTime();

const native = vi.hoisted(() => ({ on: true }));
vi.mock('../native', async (orig) => ({
  ...(await orig<typeof import('../native')>()),
  get isNative() {
    return native.on;
  },
}));
vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return { ...real, api: { ...real.api, available: true, signedIn: true } };
});
vi.mock('../api/notion', () => ({
  notion: {
    status: vi.fn(async () => ({
      configured: true,
      connected: true,
      settings: { read: [{ id: 'g', type: 'page', title: 'Groceries' }, { id: 't', type: 'data_source', title: 'Tasks' }], write: null, writesOn: true, recapOn: false },
    })),
    context: vi.fn(async () => ({
      notes: [{ id: 'g', title: 'Groceries', text: 'Open to-dos: oat milk; eggs.', editedAt: NOW - 3600_000, edited: 'today' }],
      problems: [],
      fetchedAt: NOW,
    })),
  },
}));

const { hostsView } = await import('./hostsView');

describe('what your hosts can see: Notion', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the picked pages and exactly what the hosts read from them', async () => {
    await saveSettings({ connections: { notion: { connected: true }, news: { enabled: false } } });
    const v = await hostsView({ now: NOW });
    const n = v.sources.find((s) => s.id === 'notion')!;
    expect(n).toMatchObject({ connected: true, how: 'Your pages: Groceries and Tasks', setup: { label: 'Change', to: '/settings/connections?show=notion' } });
    expect(n.preview).toEqual([{ text: 'Open to-dos: oat milk; eggs.', detail: 'Groceries, edited today' }]);
    expect(n.on.length).toBeGreaterThan(0);
    // the next break names the page instead of "a note you left"
    expect(v.next?.items).toContain('Your Notion page Groceries');
  });

  it('says so when Notion is not connected', async () => {
    const v = await hostsView({ now: NOW });
    expect(v.sources.find((s) => s.id === 'notion')).toMatchObject({ connected: false, how: 'Not connected', preview: [], setup: { label: 'Connect' } });
  });
});
