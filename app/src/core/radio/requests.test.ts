import { describe, expect, it } from 'vitest';
import type { Track } from '../types';
import { hosts, NOW, packet, station } from './fixtures';
import { writeBuiltinBreak } from './builtin';
import { planBreak } from './planner';
import { factsSheet } from './prompt';
import { isMood, isSongRequest, matchRequest, requestQuery } from './requests';

const track = (id: string, title: string, artist: string): Track => ({
  id, title, artist, album: '', durationMs: 200_000, source: 'local', ref: id, playCount: 0, addedAt: 0, createdAt: 0, updatedAt: 0,
});
const lib = [
  track('a', 'Dreams', 'Fleetwood Mac'),
  track('b', 'Go Your Own Way', 'Fleetwood Mac'),
  track('c', 'Midnight City', 'M83'),
  track('d', 'Bohemian Rhapsody', 'Queen'),
  track('e', 'Dreams', 'The Cranberries'),
];

describe('song requests', () => {
  it('reads what the listener asks for', () => {
    expect(isSongRequest('Could you play Dreams by Fleetwood Mac next?')).toBe(true);
    expect(isSongRequest('Say hi to my sister')).toBe(false);
    expect(requestQuery('Could you play Dreams by Fleetwood Mac next?')).toBe('dreams by fleetwood mac');
    expect(requestQuery('Can we hear some Queen please!')).toBe('queen');
    expect(isMood(requestQuery('Play something upbeat next'))).toBe(true);
    expect(isMood(requestQuery('put on some chill music'))).toBe(true);
    expect(isMood('queen')).toBe(false);
  });

  it('finds the song by title and artist, by title, or by artist', () => {
    expect(matchRequest('dreams by fleetwood mac', lib)?.id).toBe('a');
    expect(matchRequest('dreams by the cranberries', lib)?.id).toBe('e');
    expect(matchRequest('bohemian rhapsody', lib)?.id).toBe('d');
    expect(matchRequest('queen', lib)?.id).toBe('d');
    expect(['a', 'b']).toContain(matchRequest('fleetwood mac', lib, 'x')?.id);
    expect(matchRequest('taylor swift', lib)).toBeUndefined();
    // the song on air now only when nothing else fits
    expect(matchRequest('fleetwood mac', lib, 'a')?.id).toBe('b');
  });

  it('tells the hosts what was queued, or that it is missing', () => {
    const p = packet();
    const found = planBreak(station(), p, [], { now: NOW, kind: 'callin', callIn: 'Play Dreams!', request: { query: 'dreams', found: lib[0] }, rand: () => 0 });
    expect(factsSheet(found, p, station())).toContain('SONG REQUEST from the listener: "Dreams" by Fleetwood Mac. It plays after the song that is on now. Name it ONCE');
    const missing = planBreak(station(), p, [], { now: NOW, kind: 'callin', callIn: 'Play Taylor Swift', request: { query: 'taylor swift' }, rand: () => 0 });
    expect(factsSheet(missing, p, station())).toContain('"taylor swift". It is NOT in their music library');
    const lines = writeBuiltinBreak(station(), hosts(2), found, p, { rand: () => 0 }).map((l) => l.text).join(' ');
    expect(lines).toMatch(/Dreams by Fleetwood Mac/);
    const miss = writeBuiltinBreak(station(), hosts(2), missing, p, { rand: () => 0 }).map((l) => l.text).join(' ');
    expect(miss).toMatch(/taylor swift/);
  });
});
