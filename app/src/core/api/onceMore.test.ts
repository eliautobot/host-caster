import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { onceMore } from './endpoints';

describe('onceMore (voice lines and AI replies through the server)', () => {
  it('tries once more after a hiccup on the way: a dropped connection, a 502/503/504', async () => {
    for (const err of [new ApiError(0, 'offline', 'gone'), new ApiError(502, 'included_error', 'x'), new ApiError(503, 'included_paused', 'x'), new ApiError(504, 'included_timeout', 'x')]) {
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('voiced');
      expect(await onceMore(fn, undefined)).toBe('voiced');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('only once', async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError(502, 'included_error', 'down'));
    await expect(onceMore(fn, undefined)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('not after a time-out, a busy refusal or a bad request, and not once the caller stopped waiting', async () => {
    for (const err of [new ApiError(0, 'timeout', 't'), new ApiError(429, 'included_busy', 'b'), new ApiError(400, 'invalid_voice', 'v')]) {
      const fn = vi.fn().mockRejectedValue(err);
      await expect(onceMore(fn, undefined)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    const stop = new AbortController();
    stop.abort();
    const fn = vi.fn().mockRejectedValue(new ApiError(0, 'offline', 'gone'));
    await expect(onceMore(fn, stop.signal)).rejects.toThrow('gone');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
