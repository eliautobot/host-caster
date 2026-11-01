import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDb, listStations, saveProfile, saveSettings, saveStation } from '../db';
import { STARTER_STATION, defaultSegments } from '../db/defaults';
import { regionFeeds } from '../context/news';
import { switchEmailOn } from './emailOn';
import { hostsView, plainError } from './hostsView';

const NOW = new Date(2026, 9, 29, 9, 40).getTime();

// as the phone apps: they read news feeds directly (a signed-out web app cannot)
const native = vi.hoisted(() => ({ on: true }));
vi.mock('../native', async (orig) => ({
  ...(await orig<typeof import('../native')>()),
  get isNative() {
    return native.on;
  },
}));
const rss = (n: number) =>
  `<rss><channel><title>Feed</title>${Array.from({ length: n }, (_, i) => `<item><title>Story ${i}</title><link>https://e.com/${i}</link></item>`).join('')}</channel></rss>`;

describe('what your hosts can see', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists every source in plain words, with what the hosts would get now', async () => {
    await saveProfile({
      location: { name: 'Chicago', lat: 41.88, lon: -87.63 },
      units: 'imperial',
      reminders: [{ id: 'r', text: 'Call the pharmacy', at: NOW + 40 * 60_000 }, { id: 'later', text: 'Book flights', at: NOW + 9 * 3600_000 }],
      notes: [{ id: 'n', text: 'Drink more water' }],
    });
    await saveSettings({ connections: { news: { enabled: true, region: 'us' } } });
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(String(u));
        if (String(u).includes('open-meteo')) {
          return new Response(JSON.stringify({ current: { temperature_2m: 54, apparent_temperature: 51, weather_code: 61 }, daily: { temperature_2m_max: [58], temperature_2m_min: [47], precipitation_probability_max: [70] } }));
        }
        return new Response(rss(4));
      }),
    );
    const v = await hostsView({ now: NOW });
    const by = Object.fromEntries(v.sources.map((s) => [s.id, s]));
    expect(v.sources.map((s) => s.id)).toEqual(['calendar', 'email', 'news', 'weather', 'reminders', 'life', 'notion', 'aiApps']);
    expect(by.calendar).toMatchObject({ connected: false, how: 'Not connected', preview: [] });
    expect(by.email).toMatchObject({ connected: false });
    expect(by.email!.on).toEqual([STARTER_STATION.name]);
    expect(by.news).toMatchObject({ connected: true });
    expect(by.news!.how).toMatch(/^Top stories for United States: NPR News, PBS NewsHour and CBS News$/);
    expect(by.news!.preview.length).toBeGreaterThanOrEqual(4);
    expect(urls).toEqual(expect.arrayContaining(regionFeeds('us')));
    expect(by.weather!.preview[0]!.text).toMatch(/54 degrees and light rain in Chicago/);
    // only the reminder due in the next 3 hours reaches the hosts
    expect(by.reminders!.preview.map((p) => p.text)).toEqual(['Call the pharmacy']);
    expect(by.reminders!.how).toBe('2 saved in About me');
    expect(by.life!.preview.map((p) => p.text)).toContain('Drink more water');
    expect(v.next?.station).toBe(STARTER_STATION.name);
    expect(v.next?.items.join(' ')).toMatch(/pharmacy|Headline|weather/i);
  });

  it('a signed-out web app is told to sign in for the headlines', async () => {
    native.on = false;
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(rss(2))));
      const news = (await hostsView({ now: NOW })).sources.find((s) => s.id === 'news')!;
      expect(news).toMatchObject({ connected: false, preview: [], setup: { label: 'Sign in', to: '/sign-in' } });
      expect(news.note).toMatch(/Sign in and your Host-Caster server fetches the headlines/);
    } finally {
      native.on = true;
    }
  });

  it('says which stations use a topic', async () => {
    const base = { ...STARTER_STATION, createdAt: 0, updatedAt: 0 };
    await saveStation({ ...base, segments: defaultSegments() });
    await saveStation({ ...base, id: 'quiet', name: 'Quiet FM', segments: { ...defaultSegments(), news: false, calendar: false } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rss(2))));
    const v = await hostsView({ now: NOW });
    const news = v.sources.find((s) => s.id === 'news')!;
    expect(news.on).toEqual([STARTER_STATION.name]);
    expect(news.off).toEqual(['Quiet FM']);
  });

  it('turns failures into plain words', () => {
    expect(plainError('offline')).toBe('Needs you signed in and online.');
    expect(plainError('feeds.example.com answered 404')).toBe('The site said no (404).');
    expect(plainError('The operation was aborted due to timeout')).toBe('It took too long to answer.');
  });
});

describe('email on when a mailbox is connected', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });

  it('switches the email topic on for every station that had it off, and says which', async () => {
    const base = { ...STARTER_STATION, createdAt: 0, updatedAt: 0 };
    await saveStation({ ...base, segments: { ...defaultSegments(), email: false } });
    await saveStation({ ...base, id: 'b', name: 'Second FM', segments: { ...defaultSegments(), email: true } });
    const changed = await switchEmailOn();
    expect(changed.map((s) => s.name)).toEqual([STARTER_STATION.name]);
    expect((await listStations()).every((s) => s.segments.email)).toBe(true);
    expect(await switchEmailOn()).toEqual([]);
  });
});
