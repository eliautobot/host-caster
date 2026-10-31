import { describe, expect, it } from 'vitest';
import { buildPath, matchPath, parseHash } from './router';

describe('router', () => {
  it('parses hashes', () => {
    expect(parseHash('')).toEqual({ path: '/', query: {} });
    expect(parseHash('#/hosts/abc/?tab=voice')).toEqual({ path: '/hosts/abc', query: { tab: 'voice' } });
  });

  it('matches params', () => {
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/hosts/:id', '/hosts/a%20b')).toEqual({ id: 'a b' });
    expect(matchPath('/hosts/:id', '/hosts')).toBeNull();
    expect(matchPath('/hosts', '/stations')).toBeNull();
    expect(matchPath('/dev/*', '/dev/a/b')).toEqual({});
  });

  it('builds paths', () => {
    expect(buildPath('/library/playlists/:id', { id: 'x/y' })).toBe('/library/playlists/x%2Fy');
  });
});
