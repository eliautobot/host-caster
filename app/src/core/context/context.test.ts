import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDb, kvGet, saveProfile, saveSettings } from '../db';
import { STARTER_STATION, defaultSegments } from '../db/defaults';
import type { Station } from '../types';
import { cached, within } from './cache';
import { buildContext } from './context';
import { parseIcs, parseIcsDate } from './ics';
import { activeNotes, dueLifeEvents, dueReminders, lifeEventInfo } from './life';
import { parseFeed } from './rss';
import { parseForecast, weatherCondition } from './weather';

const NOW = new Date(2026, 9, 29, 21, 40).getTime();

describe('ics', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:a',
    'DTSTART:20261030T090000Z',
    'DTEND:20261030T100000Z',
    'SUMMARY:Stand-up\\, team A',
    'LOCATION:Room 4',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b',
    'DTSTART;VALUE=DATE:20261030',
    'SUMMARY:Pay day',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c',
    'DTSTART;TZID=Europe/Lisbon:20260105T073000',
    'RRULE:FREQ=WEEKLY;BYDAY=FR',
    'SUMMARY:Gym',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:d',
    'DTSTART:20261030T120000Z',
    'STATUS:CANCELLED',
    'SUMMARY:Gone',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:e',
    'DTSTART:20261030T150000Z',
    'SUMMARY:A very long title that wraps',
    '  onto the next line',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('parses timed, all-day, TZID, weekly and folded events in a window', () => {
    const from = Date.UTC(2026, 9, 29, 0, 0);
    const events = parseIcs(ics, from, from + 3 * 86_400_000);
    const titles = events.map((e) => e.title);
    expect(titles).toContain('Stand-up, team A');
    expect(titles).toContain('Pay day');
    expect(titles).toContain('Gym');
    expect(titles).toContain('A very long title that wraps onto the next line');
    expect(titles).not.toContain('Gone');
    const gym = events.find((e) => e.title === 'Gym')!;
    // Friday 30 Oct 2026, 07:30 Lisbon (WET, UTC+0 after DST ends on 25 Oct)
    expect(new Date(gym.start).toISOString()).toBe('2026-10-30T07:30:00.000Z');
    expect(events.find((e) => e.title === 'Pay day')!.allDay).toBe(true);
    expect(events.find((e) => e.title.startsWith('Stand-up'))!.location).toBe('Room 4');
  });

  it('converts TZID wall time to UTC', () => {
    expect(new Date(parseIcsDate('20260715T090000', { TZID: 'America/New_York' })!.at).toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });
});

describe('rss', () => {
  it('reads RSS and Atom with entities and CDATA', () => {
    const rss = `<rss><channel><title>Daily &amp; Co</title><item><title><![CDATA[Park opens <b>today</b>]]></title><link>https://x.test/1</link><pubDate>Thu, 29 Oct 2026 10:00:00 GMT</pubDate></item><item><title>Rain &#8217;til Friday</title></item></channel></rss>`;
    const items = parseFeed(rss);
    expect(items.map((i) => i.title)).toEqual(['Park opens today', 'Rain ’til Friday']);
    expect(items[0]!.source).toBe('Daily & Co');
    expect(items[0]!.at).toBe(Date.UTC(2026, 9, 29, 10));
    const atom = `<feed><title>Atom News</title><entry><title>Hello</title><link href="https://a.test/x"/><updated>2026-10-29T08:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom)[0]).toMatchObject({ title: 'Hello', source: 'Atom News', url: 'https://a.test/x' });
  });
});

describe('life events, notes, reminders', () => {
  it('finds yearly events around today with the number of years', () => {
    const mom = { id: 'm', title: "Mom's birthday", date: '1961-10-30', yearly: true };
    expect(lifeEventInfo(mom, NOW)).toMatchObject({ daysAway: 1, years: 65, when: 'tomorrow' });
    const newYear = { id: 'n', title: 'New year party', date: '2026-01-01', yearly: true };
    expect(lifeEventInfo(newYear, new Date(2026, 11, 31, 12).getTime())).toMatchObject({ daysAway: 1 });
    const once = { id: 'o', title: 'Move day', date: '2026-11-20', yearly: false };
    expect(dueLifeEvents([mom, once], NOW).map((i) => i.event.id)).toEqual(['m']);
  });

  it('keeps notes until they expire and reminders due soon', () => {
    expect(activeNotes([{ id: '1', text: 'a' }, { id: '2', text: 'b', until: NOW - 1 }], NOW)).toEqual(['a']);
    const r = [
      { id: '1', text: 'soon', at: NOW + 3600_000 },
      { id: '2', text: 'far', at: NOW + 10 * 3600_000 },
      { id: '3', text: 'old', at: NOW - 2 * 3600_000 },
    ];
    expect(dueReminders(r, NOW).map((x) => x.text)).toEqual(['soon']);
  });
});

describe('weather', () => {
  it('maps WMO codes and parses Open-Meteo', () => {
    expect(weatherCondition(61)).toBe('light rain');
    const w = parseForecast('Lisbon', 'metric', {
      current: { temperature_2m: 17.6, apparent_temperature: 16.2, weather_code: 2 },
      daily: { temperature_2m_max: [21.4], temperature_2m_min: [13.5], precipitation_probability_max: [40] },
    }, NOW);
    expect(w).toMatchObject({ temperature: 18, feelsLike: 16, condition: 'partly cloudy', high: 21, low: 14, precipitationChance: 40 });
  });
});

describe('cache + buildContext', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('serves fresh values from kv and the old snapshot when offline', async () => {
    let calls = 0;
    const ok = await cached('k', 1000, async () => ++calls, NOW);
    expect(ok).toMatchObject({ value: 1, stale: false });
    expect((await cached('k', 1000, async () => ++calls, NOW + 10)).value).toBe(1);
    const off = await cached('k', 1000, async () => Promise.reject(new Error('offline')), NOW + 5000);
    expect(off).toMatchObject({ value: 1, stale: true, error: 'offline' });
    expect((await kvGet<number>('k'))?.value).toBe(1);
    expect(await within(new Promise((r) => setTimeout(() => r(1), 200)), 10)).toBeUndefined();
  });

  it('builds a packet from the profile, gated by station segments, with weather cached for offline', async () => {
    await saveProfile({
      name: 'Sam Rivera',
      callMe: 'Sam',
      location: { name: 'Lisbon', lat: 38.72, lon: -9.14 },
      units: 'metric',
      lifeEvents: [{ id: 'm', title: "Mom's birthday", date: '1961-10-30', yearly: true }],
      notes: [{ id: 'n', text: 'Water the plants' }],
      reminders: [{ id: 'r', text: 'Call the pharmacy', at: NOW + 1800_000 }],
    });
    await saveSettings({ connections: { weather: { enabled: true } } });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ current: { temperature_2m: 18, apparent_temperature: 17, weather_code: 0 }, daily: { temperature_2m_max: [21], temperature_2m_min: [14], precipitation_probability_max: [0] } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    // news has its own test below (default feeds would be fetched here too)
    const station: Station = { ...STARTER_STATION, createdAt: 0, updatedAt: 0, segments: { ...defaultSegments(), notes: false, news: false } };
    const p = await buildContext(station, { songBefore: { id: 't', title: 'Dreams', artist: 'Fleetwood Mac', album: '', durationMs: 1, source: 'local' } }, { now: NOW });
    expect(p.listener.callMe).toBe('Sam');
    expect(p.weather).toMatchObject({ place: 'Lisbon', temperature: 18, condition: 'clear skies' });
    expect(p.lifeEvents?.[0]?.title).toBe("Mom's birthday");
    expect(p.reminders?.[0]?.text).toBe('Call the pharmacy');
    expect(p.notes).toBeUndefined();
    expect(p.songBefore?.title).toBe('Dreams');
    expect(p.now.partOfDay).toBe('night');

    // offline: the weather comes from kv
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    const again = await buildContext(station, {}, { now: Date.now() });
    expect(again.weather?.temperature).toBe(18);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
