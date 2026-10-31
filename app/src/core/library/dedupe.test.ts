import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { DuplicateIndex, fingerprint } from './dedupe';
import { groupAlbums, groupArtists, searchTracks, sortTracks } from './group';
import { formatBytes, formatTotal, norm, titleFromFileName } from './text';

const track = (p: Partial<Track> & { id: string }): Track => ({
  title: 'Morning Light',
  artist: 'Lumen Drive',
  album: 'First Signal',
  durationMs: 32_000,
  source: 'local',
  ref: p.id,
  playCount: 0,
  addedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  ...p,
});

describe('duplicate detection', () => {
  const idx = new DuplicateIndex([
    track({ id: 'a', file: { name: 'a.mp3', size: 10, mime: 'audio/mpeg', hash: 'h1' } }),
    track({ id: 'b', title: 'Coffee Run', durationMs: 26_000 }),
    track({ id: 's', title: 'Morning Light', source: 'stream', durationMs: 0 }),
  ]);

  it('finds the same file by fingerprint, whatever its tags', () => {
    expect(idx.find({ title: 'x', artist: 'y', album: 'z', durationMs: 1, hash: 'h1' })?.id).toBe('a');
  });

  it('finds the same song: tags match (case, accents, punctuation) and duration within 2 s', () => {
    expect(idx.find({ title: 'MORNING light!', artist: 'Lumen  Drive', album: 'First Signal', durationMs: 33_500 })?.id).toBe('a');
    expect(idx.find({ title: 'Coffee Run', artist: 'Lumen Drive', album: 'First Signal', durationMs: 26_900 })?.id).toBe('b');
    expect(norm('Café  Del Mar & Friends')).toBe('cafe del mar and friends');
  });

  it('keeps different versions and other albums apart', () => {
    expect(idx.find({ title: 'Morning Light', artist: 'Lumen Drive', album: 'First Signal', durationMs: 40_000 })).toBeUndefined();
    expect(idx.find({ title: 'Morning Light', artist: 'Lumen Drive', album: 'Live', durationMs: 32_000 })).toBeUndefined();
    expect(idx.find({ title: 'Morning Light (Remix)', artist: 'Lumen Drive', album: 'First Signal', durationMs: 32_000 })).toBeUndefined();
    expect(idx.find({ title: '', artist: '', album: '', durationMs: 0 })).toBeUndefined();
  });

  it('fingerprints content, not names', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 7) % 251);
    const a = await fingerprint(new Blob([bytes], { type: 'audio/mpeg' }));
    const b = await fingerprint(new Blob([bytes]));
    const changed = bytes.slice();
    changed[199_999] = 1;
    expect(a).toBe(b);
    expect(await fingerprint(new Blob([changed]))).not.toBe(a);
  });
});

describe('grouping, sorting, search, text', () => {
  const lib = [
    track({ id: '1', title: 'Late Train', trackNo: 3, addedAt: 3 }),
    track({ id: '2', title: 'Morning Light', trackNo: 1, addedAt: 1, playCount: 5 }),
    track({ id: '3', title: 'Neon Harbor', artist: 'The Quiet Tides', album: 'Harbor Lights', addedAt: 2, artworkId: 'art-x' }),
    track({ id: 's', title: 'Jazz FM', source: 'stream', artist: 'Internet radio', album: 'radio.example' }),
  ];

  it('groups albums in track order and artists with their albums (streams left out)', () => {
    const albums = groupAlbums(lib);
    expect(albums.map((a) => a.title)).toEqual(['First Signal', 'Harbor Lights']);
    expect(albums[0]!.tracks.map((t) => t.id)).toEqual(['2', '1']);
    expect(albums[1]!.artworkId).toBe('art-x');
    const artists = groupArtists(lib);
    expect(artists.map((a) => [a.name, a.tracks.length, a.albums.length])).toEqual([
      ['Lumen Drive', 2, 1],
      ['The Quiet Tides', 1, 1],
    ]);
  });

  it('sorts and searches', () => {
    expect(sortTracks(lib, 'added').map((t) => t.id)).toEqual(['1', '3', '2', 's']);
    expect(sortTracks(lib, 'plays')[0]!.id).toBe('2');
    expect(searchTracks(lib, 'harbor tides').map((t) => t.id)).toEqual(['3']);
    expect(searchTracks(lib, 'lumen train').map((t) => t.id)).toEqual(['1']);
    expect(searchTracks(lib, '').length).toBe(4);
  });

  it('formats', () => {
    expect(titleFromFileName('C:\\Music\\03 - Late Train.mp3')).toBe('Late Train');
    expect(titleFromFileName('1-03 Late_Train.flac')).toBe('Late Train');
    expect(titleFromFileName('1999.mp3')).toBe('1999');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
    expect(formatTotal(75 * 60_000)).toBe('1 hr 15 min');
  });
});
