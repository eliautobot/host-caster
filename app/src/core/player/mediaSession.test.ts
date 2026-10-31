import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../types';

type Handler = (e: { positionMs: number }) => void;
const native = vi.hoisted(() => ({
  update: vi.fn(async (..._args: unknown[]) => undefined),
  clear: vi.fn(async () => undefined),
  handlers: new Map<string, (e: { positionMs: number }) => void>(),
}));

vi.mock('../native', () => ({
  mediaNotification: {
    update: native.update,
    clear: native.clear,
    on: (event: string, cb: Handler) => {
      native.handlers.set(event, cb);
      return () => undefined;
    },
  },
}));
vi.mock('../services/artwork', () => ({ artworkUrl: async (id?: string) => (id ? `blob:${id}` : undefined) }));

const { bindMediaSession, updateMediaSession } = await import('./mediaSession');

const track = (id: string, source: Track['source'] = 'local'): Track => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: 'Album',
  durationMs: 200_000,
  artworkId: `art-${id}`,
  source,
  ref: id,
  playCount: 0,
  addedAt: 0,
  createdAt: 0,
  updatedAt: 0,
});

describe('media notification (native)', () => {
  beforeEach(() => {
    native.update.mockClear();
    native.clear.mockClear();
  });

  it('sends metadata, playing state and the position', async () => {
    await updateMediaSession(track('a'), true, { positionMs: 12_345.6, canPrev: true, canNext: false });
    expect(native.update).toHaveBeenCalledWith(
      { title: 'Song a', artist: 'Artist', album: 'Album', artworkUrl: 'blob:art-a', durationMs: 200_000 },
      true,
      { positionMs: 12_346, canPrev: true, canNext: false },
    );
  });

  it('live streams have no duration and keep the native clock', async () => {
    await updateMediaSession(track('s', 'stream'), true, { positionMs: 5000, live: true });
    const [meta, , opts] = native.update.mock.calls[0]!;
    expect((meta as { durationMs?: number }).durationMs).toBeUndefined();
    expect(opts).toEqual({});
  });

  it('webOnly never touches the notification; no track takes it down once', async () => {
    await updateMediaSession(track('a'), false, { webOnly: true });
    expect(native.update).not.toHaveBeenCalled();
    await updateMediaSession(track('a'), false, { positionMs: 0 });
    await updateMediaSession(undefined, false);
    await updateMediaSession(undefined, false);
    expect(native.clear).toHaveBeenCalledTimes(1);
  });

  it('dismiss clears, and a newer call wins over a slower older one', async () => {
    await updateMediaSession(track('a'), true, { positionMs: 1 });
    const older = updateMediaSession(track('a'), false, { positionMs: 2 });
    const newer = updateMediaSession(track('a'), false, { dismiss: true });
    await Promise.all([older, newer]);
    expect(native.update).toHaveBeenCalledTimes(1);
    expect(native.clear).toHaveBeenCalledTimes(1);
  });

  it('notification seek and stop reach the player', () => {
    const c = { play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), seek: vi.fn(), seekBy: vi.fn(), stop: vi.fn() };
    bindMediaSession(c);
    native.handlers.get('seek')?.({ positionMs: 42_000 });
    native.handlers.get('stop')?.({ positionMs: 0 });
    native.handlers.get('next')?.({ positionMs: 0 });
    expect(c.seek).toHaveBeenCalledWith(42_000);
    expect(c.stop).toHaveBeenCalledTimes(1);
    expect(c.next).toHaveBeenCalledTimes(1);
  });
});
