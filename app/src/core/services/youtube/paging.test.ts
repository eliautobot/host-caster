// Long YouTube playlists: read in steps, everything imported, left-out counts with reasons, the synced playlist filled
// again on another device instead of a second copy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { db, initDb } from '../../db';
import { leftOutText, ytPlaylistAll } from './api';
import { importYouTubePlaylist } from './import';

const vid = (i: number) => `v${String(i).padStart(10, '0')}`;

/** A server that answers paged=1 with steps of 500 (like server/src/integrations/google.js). */
function stubServer(count: number, opts: { privateEvery?: number; blockedEvery?: number; paged?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const u = new URL(url, 'http://x');
    if (!u.pathname.startsWith('/api/google/youtube/playlist/')) return new Response(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }));
    const from = Number(u.searchParams.get('pageToken') ?? 0);
    const size = opts.paged === false ? 200 : 500;
    const slice = Array.from({ length: Math.max(0, Math.min(size, count - from)) }, (_, k) => from + k);
    const isPrivate = (i: number) => opts.privateEvery && i % opts.privateEvery === 0;
    const items = slice
      .filter((i) => !isPrivate(i))
      .map((i) => ({ videoId: vid(i), title: `Band ${i} - Song ${i}`, channel: 'Band', durationMs: 1000, ...(opts.blockedEvery && i % opts.blockedEvery === 1 ? { embeddable: false } : {}) }));
    if (opts.paged === false) return Response.json({ items });
    const left = { private: slice.filter((i) => isPrivate(i)).length, deleted: 0, unavailable: 0 };
    const next = from + size < count ? String(from + size) : undefined;
    return Response.json({ items, total: count, left, blocked: items.filter((v) => v.embeddable === false).length, ...(next ? { next } : {}) });
  });
  return calls;
}

describe('YouTube playlists in steps', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
    api.available = true;
  });
  afterEach(() => {
    api.available = false;
    vi.unstubAllGlobals();
  });

  it('reads every step, reports progress and what was left out', async () => {
    const calls = stubServer(1216, { privateEvery: 10, blockedEvery: 50 });
    const progress: [number, number | undefined][] = [];
    const whole = await ytPlaylistAll('LL', { onProgress: (d, t) => progress.push([d, t]) });
    expect(calls.filter((c) => c.includes('/playlist/LL'))).toHaveLength(3);
    expect(calls[0]).toContain('paged=1');
    expect(whole.items).toHaveLength(1216 - 122);
    expect(whole.left).toEqual({ private: 122, deleted: 0, unavailable: 0, overLimit: 0 });
    expect(whole.blocked).toBe(25);
    expect(progress).toEqual([[500, 1216], [1000, 1216], [1216, 1216]]);
    expect(leftOutText(whole)).toBe('122 left out: 122 private. 25 cannot play outside YouTube (skipped on air).');
  });

  it('stops at the limit and counts the rest', async () => {
    stubServer(1300);
    const whole = await ytPlaylistAll('PLx', { max: 700 });
    expect(whole.items).toHaveLength(700);
    expect(whole.left.overLimit).toBe(600);
    expect(leftOutText(whole)).toContain('600 over the 5,000 limit');
  });

  it('an older server (one answer, no steps) still imports what it sends', async () => {
    stubServer(1000, { paged: false });
    const whole = await ytPlaylistAll('LL');
    expect(whole.items).toHaveLength(200);
    expect(leftOutText(whole)).toBe('');
  });

  it('a 1,216-video liked list imports whole; a second device fills the synced playlist, no second copy', async () => {
    stubServer(1216, { privateEvery: 10 });
    const first = await importYouTubePlaylist({ id: 'LL', title: 'Liked videos', liked: true });
    expect(first.tracks).toHaveLength(1094);
    expect(first.playlist.trackIds).toHaveLength(1094);
    expect(first.playlist.remoteKey).toBe('youtube:LL');
    // long list: covers are not downloaded one by one, they show from YouTube
    expect(first.tracks[0]!.artworkId).toMatch(/^https:\/\/i\.ytimg\.com\//);

    // another device: the playlist arrived by sync (no local import map), then this device imports too
    const synced = { ...first.playlist, trackIds: [] };
    await db.delete();
    await initDb();
    await db.playlists.put(synced);
    const second = await importYouTubePlaylist({ id: 'LL', title: 'Liked videos', liked: true });
    expect(second.playlist.id).toBe(first.playlist.id);
    expect(await db.playlists.count()).toBe(1);
  });

  it('a playlist synced from an older app (no remoteKey) is found by its name', async () => {
    stubServer(3);
    const now = Date.now();
    await db.playlists.put({ id: 'old-pl', name: 'Liked videos (YouTube)', source: 'youtube', trackIds: [], createdAt: now, updatedAt: now });
    const res = await importYouTubePlaylist({ id: 'LL', title: 'Liked videos', liked: true });
    expect(res.playlist.id).toBe('old-pl');
    expect(res.playlist.remoteKey).toBe('youtube:LL');
  });
});
