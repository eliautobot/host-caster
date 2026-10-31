import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { VARIOUS_ARTISTS, albumIdOf, groupAlbums } from './group';

let n = 0;
const t = (title: string, artist: string, album: string, extra: Partial<Track> = {}): Track => ({
  id: `t${++n}`,
  title,
  artist,
  album,
  durationMs: 1000,
  source: 'local',
  ref: `r${n}`,
  playCount: 0,
  addedAt: n,
  createdAt: n,
  updatedAt: n,
  ...extra,
});
const file = (path: string) => ({ file: { name: path.split('/').pop()!, path, size: 1, mime: 'audio/mpeg' } });

describe('album grouping', () => {
  it('album artist tag keeps a compilation together', () => {
    const al = groupAlbums([t('A', 'One', 'Hits', { albumArtist: 'Various Artists' }), t('B', 'Two', 'Hits', { albumArtist: 'Various Artists' })]);
    expect(al).toHaveLength(1);
    expect(al[0]!.artist).toBe('Various Artists');
  });

  it('untagged compilation in one folder is one album by "Various artists"', () => {
    const a = t('A', 'One', 'Summer Mix', file('Summer Mix/01 A.mp3'));
    const b = t('B', 'Two', 'Summer Mix', file('Summer Mix/02 B.mp3'));
    const al = groupAlbums([a, b]);
    expect(al).toHaveLength(1);
    expect(al[0]!.artist).toBe(VARIOUS_ARTISTS);
    expect(albumIdOf(a)).toBe(albumIdOf(b));
  });

  it('same album name by different artists stays apart without a folder or tag', () => {
    expect(groupAlbums([t('A', 'One', 'Greatest Hits'), t('B', 'Two', 'Greatest Hits')])).toHaveLength(2);
  });

  it('same album name in different folders stays apart', () => {
    const al = groupAlbums([t('A', 'One', 'Live', file('One/Live/01.mp3')), t('B', 'Two', 'Live', file('Two/Live/01.mp3'))]);
    expect(al).toHaveLength(2);
    expect(al.map((a) => a.artist).sort()).toEqual(['One', 'Two']);
  });
});
