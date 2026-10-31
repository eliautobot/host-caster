import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { exportM3U, matchEntries, parseM3U, parsePLS, parsePlaylistFile, playlistFileName } from './m3u';

const track = (p: Partial<Track> & { id: string; title: string }): Track => ({
  artist: 'Lumen Drive',
  album: 'First Signal',
  durationMs: 30_000,
  source: 'local',
  ref: `blob-${p.id}`,
  playCount: 0,
  addedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  ...p,
});

const LIB: Track[] = [
  track({ id: 'a', title: 'Morning Light', file: { name: '01 Morning Light.mp3', path: 'First Signal/01 Morning Light.mp3', size: 1, mime: 'audio/mpeg' } }),
  track({ id: 'b', title: 'Coffee Run', file: { name: '02 Coffee Run.mp3', size: 1, mime: 'audio/mpeg' } }),
  track({ id: 'c', title: 'Neon Harbor', artist: 'The Quiet Tides', file: { name: '04 Neon Harbor.m4a', size: 1, mime: 'audio/mp4' } }),
  track({ id: 'd', title: 'Salt Air', artist: 'The Quiet Tides', file: { name: '05 Salt Air.flac', size: 1, mime: 'audio/flac' } }),
  track({ id: 's', title: 'Jazz FM', artist: 'Internet radio', source: 'stream', ref: 'https://radio.example/jazz', durationMs: 0 }),
];

describe('M3U / PLS', () => {
  it('parses extended M3U with titles, durations, playlist name and odd lines', () => {
    const p = parseM3U(
      '\uFEFF#EXTM3U\r\n#PLAYLIST:Road Trip\r\n#EXTINF:32,Lumen Drive - Morning Light\r\nFirst Signal/01 Morning Light.mp3\r\n\r\n' +
        '#EXTINF:-1 tvg-name="Jazz, live",Jazz FM\nhttps://radio.example/jazz\n# a comment\nplain.mp3\n',
    );
    expect(p.name).toBe('Road Trip');
    expect(p.entries).toEqual([
      { location: 'First Signal/01 Morning Light.mp3', durationSec: 32, title: 'Morning Light', artist: 'Lumen Drive' },
      { location: 'https://radio.example/jazz', durationSec: undefined, title: 'Jazz FM', artist: undefined },
      { location: 'plain.mp3' },
    ]);
  });

  it('parses PLS in File number order', () => {
    const p = parsePLS(
      '[playlist]\nFile2=b.mp3\nTitle2=Late Train\nFile1=a.mp3\nTitle1=Lumen Drive - Coffee Run\nLength1=26\nNumberOfEntries=2\nVersion=2\n',
    );
    expect(p.entries).toEqual([
      { location: 'a.mp3', title: 'Coffee Run', artist: 'Lumen Drive', durationSec: 26 },
      { location: 'b.mp3', title: 'Late Train', artist: undefined },
    ]);
  });

  it('picks the parser by extension or content and names the playlist after the file', () => {
    expect(parsePlaylistFile('mix.pls', '[playlist]\nFile1=x.mp3').entries).toHaveLength(1);
    expect(parsePlaylistFile('noext', '[playlist]\nFile1=x.mp3').entries[0]?.location).toBe('x.mp3');
    expect(parsePlaylistFile('Chill Mix.m3u', 'x.mp3').name).toBe('Chill Mix');
  });

  it('matches entries by path, file name, name without extension, tags and title', () => {
    const entries = parseM3U(
      [
        '#EXTM3U',
        'D:\\Music\\First Signal\\01 Morning Light.mp3', // path suffix (Windows)
        'file:///home/me/Music/02%20Coffee%20Run.mp3', // file URL -> file name
        'music/04 Neon Harbor.mp3', // converted file: same name, other extension
        '#EXTINF:22,The Quiet Tides - Salt Air',
        'renamed.flac', // tags
        'https://radio.example/jazz', // stream URL
        '#EXTINF:10,Nobody - Nothing',
        'missing.mp3',
      ].join('\n'),
    ).entries;
    const m = matchEntries(entries, LIB);
    expect(m.map((x) => [x.track?.id, x.method])).toEqual([
      ['a', 'path'],
      ['b', 'file'],
      ['c', 'stem'],
      ['d', 'tags'],
      ['s', 'url'],
      [undefined, undefined],
    ]);
    // title from a numbered file name when no tags
    expect(matchEntries([{ location: 'x/09 - Coffee Run.ogg' }], LIB.filter((t) => t.id !== 'b').concat(track({ id: 'b2', title: 'Coffee Run' })))[0]?.track?.id).toBe('b2');
  });

  it('exports M3U that imports back to the same songs', () => {
    const list = [LIB[0]!, LIB[2]!, LIB[4]!];
    const text = exportM3U('Round Trip', list);
    expect(text.split('\n').slice(0, 4)).toEqual([
      '#EXTM3U',
      '#PLAYLIST:Round Trip',
      '#EXTINF:30,Lumen Drive - Morning Light',
      'First Signal/01 Morning Light.mp3',
    ]);
    expect(text).toContain('#EXTINF:-1,Internet radio - Jazz FM\nhttps://radio.example/jazz');
    const back = parsePlaylistFile(playlistFileName('Round Trip'), text);
    expect(back.name).toBe('Round Trip');
    expect(matchEntries(back.entries, LIB).map((x) => x.track?.id)).toEqual(['a', 'c', 's']);
    expect(playlistFileName('a/b: c?')).toBe('a b c.m3u8');
  });
});
