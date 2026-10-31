import { beforeEach, describe, expect, it } from 'vitest';
import { db, getSettings, initDb, kvGet, saveTracks } from '../../db';
import { authParams, encodePassword, normalizeServerUrl, passwordAuth, tokenAuth, tokenFor } from './auth';
import { SubsonicClient, SubsonicError } from './client';
import { md5 } from './md5';
import { importSongs, importSubsonicPlaylist } from './import';
import { connectSubsonic, disconnectSubsonic, getSubsonicClient, setSubsonicFetch, subsonicStatus } from './store';

const ok = (payload: Record<string, unknown>) =>
  new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', ...payload } }), {
    headers: { 'content-type': 'application/json' },
  });
const failed = (code: number, message = 'nope') =>
  new Response(JSON.stringify({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } }));

describe('md5', () => {
  it('matches RFC 1321 vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
  it('hashes UTF-8 bytes', () => {
    expect(md5('é')).toBe(md5(new Uint8Array([0xc3, 0xa9])));
    expect(md5('é')).not.toBe(md5(new Uint8Array([0xe9])));
  });
});

describe('subsonic auth', () => {
  it('builds the token like the spec example', () => {
    // Subsonic API docs: password "sesame", salt "c19b2d" -> t=26719a1196d2a940705a59634eb18eab
    expect(tokenFor('sesame', 'c19b2d')).toBe('26719a1196d2a940705a59634eb18eab');
    const auth = tokenAuth('joe', 'sesame', 'c19b2d');
    expect(authParams(auth)).toEqual({ v: '1.16.1', c: 'Host-Caster', u: 'joe', t: '26719a1196d2a940705a59634eb18eab', s: 'c19b2d' });
  });
  it('makes a fresh salt each time and never keeps the password', () => {
    const a = tokenAuth('joe', 'sesame');
    const b = tokenAuth('joe', 'sesame');
    expect(a.kind === 'token' && b.kind === 'token' && a.salt !== b.salt).toBe(true);
    expect(JSON.stringify(a)).not.toContain('sesame');
  });
  it('hex-encodes the legacy password', () => {
    expect(encodePassword('sesame')).toBe('enc:736573616d65');
    expect(authParams(passwordAuth('joe', 'sesame')).p).toBe('enc:736573616d65');
  });
  it('normalizes pasted addresses', () => {
    expect(normalizeServerUrl('music.example.com')).toBe('https://music.example.com');
    expect(normalizeServerUrl('192.168.1.20:4533')).toBe('http://192.168.1.20:4533');
    expect(normalizeServerUrl('nas:4533/')).toBe('http://nas:4533');
    expect(normalizeServerUrl('https://nd.example.com/app/#/album/123')).toBe('https://nd.example.com');
    expect(normalizeServerUrl('https://x.example.com/navidrome/rest/ping.view')).toBe('https://x.example.com/navidrome');
    expect(normalizeServerUrl('http://jf.lan:8096/web/index.html')).toBe('http://jf.lan:8096');
    expect(() => normalizeServerUrl('  ')).toThrow();
    expect(() => normalizeServerUrl('ftp://x.example.com')).toThrow();
  });
});

describe('SubsonicClient', () => {
  it('signs every call and parses lists, including lone objects', async () => {
    const seen: string[] = [];
    const client = new SubsonicClient('http://nd:4533', tokenAuth('joe', 'pw', 'salt99'), async (url) => {
      seen.push(url);
      if (url.includes('/rest/getPlaylists')) return ok({ playlists: { playlist: { id: 'p1', name: 'Only one' } } });
      if (url.includes('/rest/getArtists'))
        return ok({ artists: { index: [{ name: 'A', artist: [{ id: 'a1', name: 'Abba' }] }, { name: 'B', artist: { id: 'b1', name: 'Bjork' } }] } });
      return ok({});
    });
    expect(await client.playlists()).toEqual([{ id: 'p1', name: 'Only one' }]);
    expect((await client.artists()).map((a) => a.name)).toEqual(['Abba', 'Bjork']);
    const q = new URL(seen[0]!).searchParams;
    expect(q.get('u')).toBe('joe');
    expect(q.get('s')).toBe('salt99');
    expect(q.get('t')).toBe(md5('pwsalt99'));
    expect(q.get('f')).toBe('json');
    expect(client.streamUrl('s1')).toMatch(/^http:\/\/nd:4533\/rest\/stream\?.*id=s1/);
    expect(client.coverArtUrl('al-1', 300)).toContain('size=300');
    expect(client.streamUrl('s1')).not.toContain('f=json');
  });

  it('turns failed responses into friendly errors', async () => {
    const client = new SubsonicClient('http://nd', tokenAuth('joe', 'bad'), async () => failed(40, 'Wrong username or password'));
    const err = await client.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubsonicError);
    expect((err as SubsonicError).code).toBe(40);
    expect((err as SubsonicError).message).toBe('Wrong username or password.');
  });

  it('explains non-Subsonic answers', async () => {
    const html = new SubsonicClient('http://nd', tokenAuth('j', 'p'), async () => new Response('<html>', { status: 200 }));
    await expect(html.ping()).rejects.toThrow(/Subsonic JSON/);
    const missing = new SubsonicClient('http://nd', tokenAuth('j', 'p'), async () => new Response('', { status: 404 }));
    await expect(missing.ping()).rejects.toThrow(/404/);
    const down = new SubsonicClient('http://nd', tokenAuth('j', 'p'), async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(down.ping()).rejects.toThrow(/could not be reached/);
  });
});

describe('subsonic connection + import', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
    setSubsonicFetch(undefined);
  });

  it('connects with token auth and stores no password', async () => {
    setSubsonicFetch(async (url) => (new URL(url).searchParams.get('t') ? ok({ serverVersion: '0.64' }) : failed(10)));
    const info = await connectSubsonic({ url: 'nd.example.com', username: 'joe', password: 'sesame' });
    expect(info.type).toBe('navidrome');
    const settings = await getSettings();
    expect(settings.connections.subsonic).toEqual({ url: 'https://nd.example.com', username: 'joe' });
    const stored = await kvGet<{ auth: { kind: string } }>('subsonic:auth');
    expect(stored?.value.auth.kind).toBe('token');
    expect(JSON.stringify(stored)).not.toContain('sesame');
    expect((await subsonicStatus()).connected).toBe(true);
  });

  it('falls back to the encoded password when token auth is not supported (41)', async () => {
    setSubsonicFetch(async (url) => (new URL(url).searchParams.get('p') ? ok({}) : failed(41)));
    await connectSubsonic({ url: 'http://jf.lan:8096', username: 'joe', password: 'sesame' });
    const c = await getSubsonicClient();
    expect(new URL(c!.streamUrl('x')).searchParams.get('p')).toBe('enc:736573616d65');
  });

  it('does not save a failed sign-in', async () => {
    setSubsonicFetch(async () => failed(40));
    await expect(connectSubsonic({ url: 'http://nd', username: 'joe', password: 'x' })).rejects.toThrow(/Wrong/);
    expect((await subsonicStatus()).connected).toBe(false);
    expect((await getSettings()).connections.subsonic).toBeUndefined();
  });

  it('disconnects', async () => {
    setSubsonicFetch(async () => ok({}));
    await connectSubsonic({ url: 'http://nd', username: 'joe', password: 'x' });
    await disconnectSubsonic();
    expect(await getSubsonicClient()).toBeUndefined();
    expect((await getSettings()).connections.subsonic).toBeUndefined();
  });

  it('imports songs, dedupes on re-import and keeps likes and play counts', async () => {
    const client = new SubsonicClient('http://nd', tokenAuth('j', 'p'), async (url) => {
      if (url.includes('getPlaylist'))
        return ok({
          playlist: {
            id: 'pl1',
            name: 'Evening Mix',
            entry: [
              { id: 's1', title: 'Neon Highway', artist: 'Signal Orange', album: 'Night Drive', duration: 30, year: 2024 },
              { id: 's2', title: 'Sea Glass', artist: 'Quiet Static', album: 'Low Tide', duration: 22, starred: '2026-01-01' },
              { id: 'v1', title: 'A video', isVideo: true },
            ],
          },
        });
      return ok({});
    });
    const first = await importSubsonicPlaylist(client, 'pl1');
    expect(first.tracks.map((t) => [t.title, t.source, t.ref, t.durationMs])).toEqual([
      ['Neon Highway', 'subsonic', 's1', 30000],
      ['Sea Glass', 'subsonic', 's2', 22000],
    ]);
    expect(first.tracks[1]!.liked).toBe(true);
    expect(first.playlist).toMatchObject({ name: 'Evening Mix', source: 'subsonic' });

    await saveTracks([{ ...first.tracks[0]!, playCount: 7, liked: true }]);
    const again = await importSubsonicPlaylist(client, 'pl1');
    expect(again.playlist.id).toBe(first.playlist.id);
    expect(again.tracks[0]!.id).toBe(first.tracks[0]!.id);
    expect(again.tracks[0]!.playCount).toBe(7);
    expect(again.tracks[0]!.liked).toBe(true);
    expect(await db.tracks.count()).toBe(2);
    expect(await db.playlists.where('source').equals('subsonic').count()).toBe(1);
  });

  it('stores each cover once', async () => {
    let artCalls = 0;
    const client = new SubsonicClient('http://nd', tokenAuth('j', 'p'), async () => ok({}));
    const fetchArt = globalThis.fetch;
    globalThis.fetch = (async () => {
      artCalls++;
      return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    }) as typeof fetch;
    try {
      const tracks = await importSongs(client, [
        { id: 'a', title: 'A', coverArt: 'al-1' },
        { id: 'b', title: 'B', coverArt: 'al-1' },
      ]);
      expect(artCalls).toBe(1);
      expect(tracks[0]!.artworkId).toBe('art:subsonic:al-1');
      expect(tracks[1]!.artworkId).toBe('art:subsonic:al-1');
    } finally {
      globalThis.fetch = fetchArt;
    }
  });
});

// Real server check: HOSTCASTER_SUBSONIC_URL=http://127.0.0.1:4533 HOSTCASTER_SUBSONIC_USER=admin HOSTCASTER_SUBSONIC_PASS=...
const live = process.env.HOSTCASTER_SUBSONIC_URL;
describe.skipIf(!live)('live Subsonic server', () => {
  it('pings, browses and builds a playable stream URL', async () => {
    const client = new SubsonicClient(live!, tokenAuth(process.env.HOSTCASTER_SUBSONIC_USER!, process.env.HOSTCASTER_SUBSONIC_PASS!));
    const info = await client.ping();
    expect(info.version).toMatch(/^1\./);
    const albums = await client.albumList('alphabeticalByName', 10);
    expect(albums.length).toBeGreaterThan(0);
    const album = await client.album(albums[0]!.id);
    expect(album.song!.length).toBeGreaterThan(0);
    const res = await fetch(client.streamUrl(album.song![0]!.id), { headers: { Range: 'bytes=0-1023' } });
    expect(res.status === 200 || res.status === 206).toBe(true);
    expect(res.headers.get('content-type')).toMatch(/audio/);
    const found = await client.search(album.song![0]!.title!.split(' ')[0]!);
    expect(found.songs.length).toBeGreaterThan(0);
    expect((await client.playlists()).length).toBeGreaterThanOrEqual(0);
  });
});
