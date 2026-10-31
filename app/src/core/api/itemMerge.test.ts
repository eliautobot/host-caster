import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { dataHash, isSyncedTrack, localMembers, mergeLists, splitKey, trackData, trackFromData, trackKey, wireMembers } from './itemMerge';

const track = (id: string, source: Track['source'], ref: string, extra: Partial<Track> = {}): Track => ({
  id,
  title: `T ${id}`,
  artist: 'A',
  album: '',
  durationMs: 1000,
  source,
  ref,
  playCount: 0,
  addedAt: 10,
  createdAt: 10,
  updatedAt: 20,
  ...extra,
});

describe('synced songs', () => {
  it('references sync, files do not; keys split back into source and ref', () => {
    expect(isSyncedTrack(track('a', 'youtube', 'dQw4w9WgXcQ'))).toBe(true);
    expect(isSyncedTrack(track('b', 'stream', 'https://radio.example/live.mp3'))).toBe(true);
    expect(isSyncedTrack(track('c', 'local', 'blob-1'))).toBe(false);
    expect(isSyncedTrack(track('d', 'stream', `https://x.example/${'a'.repeat(600)}`))).toBe(false);
    expect(trackKey(track('e', 'spotify', 'spotify:track:1'))).toBe('spotify:spotify:track:1');
    expect(splitKey('spotify:spotify:track:1')).toEqual(['spotify', 'spotify:track:1']);
    expect(splitKey('local:x')).toBeUndefined();
    expect(splitKey('nanoidwithoutcolon')).toBeUndefined();
  });

  it('the record carries tags and a public cover, not play counts, files or local blobs', () => {
    const t = track('a', 'youtube', 'vid00000001', { playCount: 9, lastPlayedAt: 5, artworkId: 'art:youtube:vid00000001', liked: true, file: { name: 'x', size: 1, mime: 'a' } });
    const d = trackData(t);
    expect(d).toEqual({ id: 'a', source: 'youtube', ref: 'vid00000001', title: 'T a', artist: 'A', album: '', durationMs: 1000, liked: true, addedAt: 10, createdAt: 10, art: 'https://i.ytimg.com/vi/vid00000001/mqdefault.jpg' });
    expect(trackData(track('s', 'subsonic', 'so-1', { artworkId: 'art:subsonic:1' })).art).toBeUndefined();
    expect(trackData(track('r', 'stream', 'https://r.example/s', { artworkId: 'https://r.example/logo.png' })).art).toBe('https://r.example/logo.png');
    // when it was added does not make two copies of the same song different
    expect(dataHash({ ...d, addedAt: 99, createdAt: 99, id: 'other' })).toBe(dataHash(d));
    expect(dataHash({ ...d, liked: undefined })).not.toBe(dataHash(d));
  });

  it('a pulled song keeps this device id, play stats and stored cover', () => {
    const d = trackData(track('remote', 'youtube', 'vid00000001', { liked: true, title: 'New title' }));
    const prev = track('mine', 'youtube', 'vid00000001', { playCount: 4, artworkId: 'art:youtube:vid00000001', addedAt: 3 });
    const row = trackFromData(d, prev, () => 'fresh', 500);
    expect(row).toMatchObject({ id: 'mine', title: 'New title', liked: true, playCount: 4, artworkId: 'art:youtube:vid00000001', addedAt: 3, updatedAt: 500 });
    // a new song takes the id it has on the other device when it is free here (stations point at stream ids)
    expect(trackFromData(d, undefined, () => 'fresh', 500, () => true).id).toBe('remote');
    const added = trackFromData(d, undefined, () => 'fresh', 500, () => false);
    expect(added).toMatchObject({ id: 'fresh', playCount: 0, artworkId: 'https://i.ytimg.com/vi/vid00000001/mqdefault.jpg', addedAt: 10 });
    // unliked elsewhere: the like goes here too
    expect(trackFromData({ ...d, liked: undefined }, { ...prev, liked: true }, () => 'x', 600).liked).toBeUndefined();
  });
});

describe('playlist lists', () => {
  const yt = track('y1', 'youtube', 'vid00000001');
  const file = track('f1', 'local', 'blob-1');
  const byId = new Map([yt, file].map((t) => [t.id, t]));

  it('songs travel by key, files as #id, unknown entries keep their place', () => {
    const wire = wireMembers(['y1', 'f1', 'youtube:notherevid', 'otherdevicefile'], byId);
    expect(wire).toEqual(['youtube:vid00000001', '#f1', 'youtube:notherevid', '#otherdevicefile']);
    // another device: its own id for the video, the file is not there
    const ids = localMembers(wire, new Map([['youtube:vid00000001', 'b-y1']]));
    expect(ids).toEqual(['b-y1', 'f1', 'youtube:notherevid', 'otherdevicefile']);
    // and back: the list it pushes is the same list
    expect(wireMembers(ids, new Map([['b-y1', yt]]))).toEqual(wire);
  });

  it('three-way merge keeps both devices edits', () => {
    const base = ['a', 'b', 'c'];
    // here: removed b, added x after a; there: added y at the end, moved c first
    expect(mergeLists(base, ['a', 'x', 'c'], ['c', 'a', 'b', 'y'])).toEqual(['c', 'a', 'x', 'y']);
    // nothing in common yet (first sync): the other list, with what only this device had at its place here
    expect(mergeLists([], ['p', 'q'], ['q', 'r'])).toEqual(['p', 'q', 'r']);
    expect(mergeLists([], ['q', 'p'], ['q', 'r'])).toEqual(['q', 'p', 'r']);
    expect(mergeLists([], ['p'], [])).toEqual(['p']);
    // removed there, untouched here: stays removed
    expect(mergeLists(base, base, ['a', 'c'])).toEqual(['a', 'c']);
    // an addition at the start stays at the start
    expect(mergeLists(base, ['z', 'a', 'b', 'c'], base)).toEqual(['z', 'a', 'b', 'c']);
  });
});
