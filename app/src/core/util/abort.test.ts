import { describe, expect, it } from 'vitest';
import { settleWithin, untilAborted } from './abort';

const never = <T>() => new Promise<T>(() => undefined);

describe('untilAborted', () => {
  it('ends with the stop even when the work never does (Android native HTTP, a stuck speech engine)', async () => {
    const stop = new AbortController();
    const p = untilAborted(never<string>(), stop.signal);
    stop.abort(new Error('Break cancelled'));
    await expect(p).rejects.toThrow('Break cancelled');
  });

  it("ends at a time limit with the limit's TimeoutError", async () => {
    const err = await untilAborted(never<string>(), AbortSignal.timeout(20)).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('TimeoutError');
  });

  it('passes answers and errors through, and an already stopped signal ends at once', async () => {
    expect(await untilAborted(Promise.resolve(7), new AbortController().signal)).toBe(7);
    await expect(untilAborted(Promise.reject(new Error('no')), new AbortController().signal)).rejects.toThrow('no');
    const done = new AbortController();
    done.abort();
    await expect(untilAborted(never(), done.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await untilAborted(Promise.resolve('x'), undefined)).toBe('x');
  });
});

describe('settleWithin', () => {
  it('gives the fallback once the time is up, the answer when it comes first', async () => {
    expect(await settleWithin(never<number>(), 20, 'late')).toBe('late');
    expect(await settleWithin(Promise.resolve(1), 1000, 'late')).toBe(1);
    await expect(settleWithin(Promise.reject(new Error('bad')), 1000, 'late')).rejects.toThrow('bad');
  });
});
