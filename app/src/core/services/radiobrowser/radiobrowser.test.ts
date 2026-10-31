import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, initDb, kvSet } from '../../db';
import { RadioBrowser, parseStations, playableHere, stationMeta, type RawStation } from './client';
import { createStationFor } from '../imports';
import { listSavedRadios, makeRadioStation, removeSavedRadio, saveRadioToLibrary, savedRadioStations, stationToDraft } from './import';

// recorded from de1.api.radio-browser.info (stations/search?tag=jazz) + 3 hand-made edge rows
const rows = JSON.parse(readFileSync(new URL('./fixtures/stations.json', import.meta.url), 'utf8')) as RawStation[];

describe('parseStations', () => {
  const parsed = parseStations(rows);

  it('keeps real rows, drops duplicates and rows without a URL', () => {
    expect(parsed.map((s) => s.name)).toEqual([
      'Classic Vinyl HD',
      'Anon.FM',
      '101 SMOOTH JAZZ',
      'Adroit Jazz Underground',
      'Messy FM',
    ]);
  });

  it('normalizes fields', () => {
    const messy = parsed.find((s) => s.uuid === 'messy-1')!;
    expect(messy).toMatchObject({
      name: 'Messy FM',
      url: 'http://example.invalid/stream',
      tags: ['rock', 'indie'],
      countryCode: 'GB',
      bitrate: 128,
      votes: 3,
      hls: false,
      ok: false,
    });
    const vinyl = parsed[0]!;
    expect(vinyl.url).toMatch(/^https:\/\//);
    expect(vinyl.codec).toBe('MP3');
    expect(typeof vinyl.bitrate).toBe('number');
  });

  it('describes a station in one line', () => {
    const base = { ...parsed[0]!, state: undefined };
    // the short name comes from the ISO code; the directory's own name is the fallback
    expect(stationMeta({ ...base, countryCode: 'FR', country: 'The French Republic', codec: 'AAC', bitrate: 64 })).toBe('France · AAC 64 kbps');
    expect(stationMeta({ ...base, countryCode: undefined, country: 'Atlantis', codec: 'MP3', bitrate: 0 })).toBe('Atlantis · MP3');
    expect(stationMeta({ ...base, countryCode: 'US', state: 'Ohio', codec: 'AAC+', bitrate: 48 })).toBe('Ohio, United States · AAC+ 48 kbps');
    expect(stationMeta({ ...base, countryCode: undefined, country: undefined, codec: 'UNKNOWN', bitrate: 0 })).toBe('');
  });

  it('flags http streams on https pages', () => {
    const http = parsed.find((s) => s.url.startsWith('http:'))!;
    expect(playableHere(http, 'https:')).toBe(false);
    expect(playableHere(http, 'http:')).toBe(true);
    expect(playableHere(parsed[0]!, 'https:')).toBe(true);
  });
});

describe('RadioBrowser client', () => {
  it('discovers servers, builds queries and fails over', async () => {
    const calls: string[] = [];
    const rb = new RadioBrowser(
      async (url) => {
        calls.push(url);
        if (url.includes('all.api.radio-browser.info'))
          return Response.json([{ name: 'aa1.api.radio-browser.info' }, { name: 'bb1.api.radio-browser.info' }, { name: 'evil.example.com' }]);
        if (url.startsWith('https://aa1.')) throw new TypeError('Failed to fetch');
        return Response.json(rows.slice(0, 2));
      },
      { cache: false },
    );
    const servers = await rb.discover();
    expect(servers.sort()).toEqual(['aa1.api.radio-browser.info', 'bb1.api.radio-browser.info']);
    const found = await rb.search({ tag: 'Jazz', countryCode: 'us', limit: 5 });
    expect(found.length).toBe(2);
    const searchUrl = new URL(calls.find((c) => c.startsWith('https://bb1.') && c.includes('stations/search'))!);
    expect(searchUrl.searchParams.get('tag')).toBe('jazz');
    expect(searchUrl.searchParams.get('tagExact')).toBe('true');
    expect(searchUrl.searchParams.get('countrycode')).toBe('US');
    expect(searchUrl.searchParams.get('hidebroken')).toBe('true');
    expect(searchUrl.searchParams.get('limit')).toBe('5');
  });

  it('uses fallback servers when discovery is down', async () => {
    const rb = new RadioBrowser(
      async (url) => {
        if (url.includes('all.api')) throw new TypeError('offline');
        return Response.json([]);
      },
      { cache: false },
    );
    expect((await rb.discover()).every((s) => s.endsWith('.api.radio-browser.info'))).toBe(true);
    expect(await rb.popular(5)).toEqual([]);
  });

  it('gives a clear error when every server fails', async () => {
    const rb = new RadioBrowser(async () => new Response('', { status: 503 }), { cache: false });
    await expect(rb.popular()).rejects.toThrow(/not reachable/);
  });

  it('filters junk tags', async () => {
    const rb = new RadioBrowser(
      async (url) =>
        url.includes('all.api')
          ? Response.json([{ name: 'x1.api.radio-browser.info' }])
          : Response.json([
              { name: 'Pop', stationcount: 900 },
              { name: '1', stationcount: 50 },
              { name: 'a very long tag name that is not useful at all', stationcount: 10 },
              { name: 'jazz', stationcount: 400 },
            ]),
      { cache: false },
    );
    expect(await rb.tags(10)).toEqual([
      { name: 'pop', stations: 900 },
      { name: 'jazz', stations: 400 },
    ]);
  });
});

describe('radio import', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });
  const [vinyl] = parseStations(rows);

  it('maps a station to a live stream track', () => {
    expect(stationToDraft(vinyl!)).toMatchObject({ source: 'stream', ref: vinyl!.url, durationMs: 0, title: 'Classic Vinyl HD' });
  });

  it('saves once, lists, makes a station, removes', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch; // no favicon, no click count
    try {
      const a = await saveRadioToLibrary(vinyl!);
      const b = await saveRadioToLibrary(vinyl!);
      expect(a.id).toBe(b.id);
      expect(await db.tracks.where('source').equals('stream').count()).toBe(1);
      expect((await listSavedRadios()).map((s) => s.uuid)).toEqual([vinyl!.uuid]);
      const station = await makeRadioStation(vinyl!);
      expect(station.sources).toEqual([{ kind: 'stream', ref: a.id }]);
      expect(station.hostIds.length).toBeGreaterThan(0);
      expect(Number(station.frequency)).toBeGreaterThanOrEqual(87.5);
      expect(Number(station.frequency)).toBeLessThanOrEqual(108);
      await removeSavedRadio(vinyl!.uuid);
      expect(await db.tracks.count()).toBe(0);
      expect(await listSavedRadios()).toEqual([]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('stations from sources', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });
  it('never gives two stations the same frequency', async () => {
    const make = () => createStationFor({ name: 'X', sources: [{ kind: 'stream', ref: 'a' }], seed: 'same-seed' });
    const a = await make();
    const b = await make();
    expect(a.frequency).not.toBe(b.frequency);
    expect(Number(b.frequency)).toBeGreaterThanOrEqual(87.5);
    expect(Number(b.frequency)).toBeLessThanOrEqual(107.9);
  });
});

describe('saved stations', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });
  const parsed = parseStations(rows);

  it('lists from the saved snapshot with no network, newest first', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    try {
      await saveRadioToLibrary(parsed[0]!);
      await saveRadioToLibrary(parsed[1]!);
      const rb = { byUuids: async () => Promise.reject(new Error('offline')) };
      expect((await savedRadioStations(rb)).map((s) => s.name)).toEqual([parsed[1]!.name, parsed[0]!.name]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('looks up old entries in one batched request, falls back to the stored track', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    try {
      const a = await saveRadioToLibrary(parsed[0]!);
      const b = await saveRadioToLibrary(parsed[1]!);
      // entries from before snapshots: no `station`
      await kvSet('radiobrowser:saved', [
        { uuid: parsed[1]!.uuid, trackId: b.id, name: parsed[1]!.name, savedAt: 2 },
        { uuid: parsed[0]!.uuid, trackId: a.id, name: parsed[0]!.name, savedAt: 1 },
      ]);
      const asked: string[][] = [];
      const rb = {
        byUuids: async (ids: string[]) => {
          asked.push(ids);
          return [parsed[0]!]; // the directory lost the other one
        },
      };
      const list = await savedRadioStations(rb);
      expect(asked).toEqual([[parsed[1]!.uuid, parsed[0]!.uuid]]);
      expect(list.map((s) => [s.name, s.url])).toEqual([
        [parsed[1]!.name, parsed[1]!.url],
        [parsed[0]!.name, parsed[0]!.url],
      ]);
      // the found one is now cached: no second lookup for it
      asked.length = 0;
      await savedRadioStations(rb);
      expect(asked).toEqual([[parsed[1]!.uuid]]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('batches byuuid lookups in the order asked', async () => {
    const urls: string[] = [];
    const rb = new RadioBrowser(
      async (url) => {
        urls.push(url);
        if (url.includes('all.api')) return Response.json([{ name: 'x1.api.radio-browser.info' }]);
        return Response.json([rows[1], rows[0]]);
      },
      { cache: false },
    );
    const got = await rb.byUuids([parsed[0]!.uuid, parsed[1]!.uuid, parsed[0]!.uuid]);
    expect(got.map((s) => s.uuid)).toEqual([parsed[0]!.uuid, parsed[1]!.uuid]);
    const q = new URL(urls.at(-1)!).searchParams.get('uuids');
    expect(q).toBe(`${parsed[0]!.uuid},${parsed[1]!.uuid}`);
  });
});

describe.skipIf(!process.env.HOSTCASTER_LIVE_RADIO)('live radio-browser', () => {
  it('finds popular stations and searches by tag and country', async () => {
    const rb = new RadioBrowser(undefined, { cache: false });
    const top = await rb.popular(10);
    expect(top.length).toBeGreaterThan(3);
    const jazz = await rb.search({ tag: 'jazz', limit: 10 });
    expect(jazz.every((s) => s.tags.includes('jazz'))).toBe(true);
    const fr = await rb.search({ countryCode: 'FR', limit: 5 });
    expect(fr.every((s) => s.countryCode === 'FR')).toBe(true);
    expect((await rb.countries()).length).toBeGreaterThan(50);
  });
});
