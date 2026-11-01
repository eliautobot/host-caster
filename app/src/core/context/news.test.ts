import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDb, saveSettings } from '../db';
import { STARTER_STATION, defaultSegments } from '../db/defaults';
import type { Station } from '../types';
import { buildContext } from './context';
import { NEWS_REGIONS, accountNews, guessRegion, regionFeeds, regionFromPlace, stationFeeds } from './news';
import { getNews } from './sources';

// the phone apps read feeds directly; a signed-out web app cannot (no CORS) and skips the default feeds
const native = vi.hoisted(() => ({ on: true }));
vi.mock('../native', async (orig) => ({
  ...(await orig<typeof import('../native')>()),
  get isNative() {
    return native.on;
  },
}));

const NOW = new Date(2026, 9, 29, 21, 40).getTime();

const rss = (title: string, items: string[], day = 29) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items
    .map((t, i) => `<item><title>${t}</title><link>https://example.com/${encodeURIComponent(t)}</link><pubDate>${new Date(2026, 9, day, 20 - i).toUTCString()}</pubDate></item>`)
    .join('')}</channel></rss>`;

describe('news regions', () => {
  it('has default feeds for the main English-speaking regions and the world', () => {
    expect(NEWS_REGIONS.map((r) => r.id)).toEqual(expect.arrayContaining(['us', 'uk', 'ca', 'au', 'in', 'world']));
    for (const r of NEWS_REGIONS) {
      expect(r.feeds.length).toBeGreaterThanOrEqual(2);
      for (const f of r.feeds) expect(f.url).toMatch(/^https:\/\//);
    }
  });

  it('guesses the region from the place, then the time zone, then the language', () => {
    expect(guessRegion({ place: { lat: -33.87, lon: 151.21 } })).toBe('au');
    expect(guessRegion({ place: { lat: 28.61, lon: 77.21 } })).toBe('in');
    expect(guessRegion({ place: { lat: 53.35, lon: -6.26 } })).toBe('ie');
    expect(guessRegion({ place: { lat: 51.51, lon: -0.13 } })).toBe('uk');
    // Belfast is the UK, not Ireland
    expect(regionFromPlace({ lat: 54.6, lon: -5.93 })).not.toBe('ie');
    expect(guessRegion({ timeZone: 'America/Toronto' })).toBe('ca');
    expect(guessRegion({ timeZone: 'America/New_York' })).toBe('us');
    expect(guessRegion({ timeZone: 'Europe/London' })).toBe('uk');
    expect(guessRegion({ place: { lat: 38.72, lon: -9.14 }, timeZone: 'Europe/Lisbon', locales: ['pt-PT', 'en-GB'] })).toBe('uk');
    expect(guessRegion({ timeZone: 'UTC', locales: ['en-IN'] })).toBe('in');
    expect(guessRegion({ timeZone: 'Europe/Lisbon', locales: ['pt-PT'] })).toBe('world');
  });

  it('account feeds: the region defaults unless the listener chose their own; a station can override', () => {
    const hints = { timeZone: 'America/Chicago' };
    const def = accountNews(undefined, hints);
    expect(def).toMatchObject({ enabled: true, region: 'us', custom: false });
    expect(def.feeds).toEqual(regionFeeds('us'));
    expect(accountNews({ enabled: true, region: 'au' }, hints).feeds).toEqual(regionFeeds('au'));
    // an emptied list goes back to the defaults; news is switched off with enabled
    expect(accountNews({ enabled: true, feeds: [] }, hints).custom).toBe(false);
    const own = accountNews({ enabled: false, feeds: ['https://example.com/a.xml'] }, hints);
    expect(own).toMatchObject({ enabled: false, custom: true, feeds: ['https://example.com/a.xml'] });
    expect(stationFeeds({ newsFeeds: [] }, own)).toEqual(['https://example.com/a.xml']);
    expect(stationFeeds({ newsFeeds: ['https://example.com/b.xml'] }, own)).toEqual(['https://example.com/b.xml']);
  });
});

describe('news in the packet', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a station with no feeds reads the account region defaults, named the way people say them', async () => {
    await saveSettings({ connections: { news: { enabled: true, region: 'uk' } } });
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(String(u));
        return new Response(rss('BBC News - Home', [`Story from ${new URL(String(u)).hostname}`]));
      }),
    );
    const station: Station = { ...STARTER_STATION, createdAt: 0, updatedAt: 0, segments: defaultSegments(), newsFeeds: [] };
    const p = await buildContext(station, {}, { now: NOW });
    expect(urls.sort()).toEqual([...regionFeeds('uk')].sort());
    expect(p.news?.map((h) => h.source)).toEqual(expect.arrayContaining(['BBC News', 'Sky News', 'The Guardian']));
  });

  it('a signed-out web app does not try the default feeds (browsers cannot read them)', async () => {
    native.on = false;
    try {
      const fetchMock = vi.fn(async (_u: string) => new Response(rss('X', ['Y'])));
      vi.stubGlobal('fetch', fetchMock);
      const station: Station = { ...STARTER_STATION, createdAt: 0, updatedAt: 0, segments: defaultSegments(), newsFeeds: [] };
      expect((await buildContext(station, {}, { now: NOW })).news).toBeUndefined();
      expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes('open-meteo'))).toEqual([]);
    } finally {
      native.on = true;
    }
  });

  it("a station's own feeds win, and news off in Settings means no headlines", async () => {
    await saveSettings({ connections: { news: { enabled: true, region: 'uk' } } });
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (urls.push(String(u)), new Response(rss('Mine', ['Local story'])))));
    const own: Station = { ...STARTER_STATION, createdAt: 0, updatedAt: 0, segments: defaultSegments(), newsFeeds: ['https://example.com/mine.xml'] };
    const p = await buildContext(own, {}, { now: NOW });
    expect(urls).toEqual(['https://example.com/mine.xml']);
    expect(p.news?.[0]?.title).toBe('Local story');
    await saveSettings({ connections: { news: { enabled: false } } });
    expect((await buildContext(own, {}, { now: NOW })).news).toBeUndefined();
  });

  it('every feed gets a say: the newest of each first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        const old = String(u).includes('old');
        return new Response(rss(old ? 'Old' : 'Busy', old ? ['Old story'] : ['Busy 1', 'Busy 2', 'Busy 3'], old ? 20 : 29));
      }),
    );
    const heads = await getNews(['https://busy.example/feed', 'https://old.example/feed']);
    expect(heads.slice(0, 2).map((h) => h.title)).toEqual(['Busy 1', 'Old story']);
  });
});
