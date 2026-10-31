import { describe, expect, it } from 'vitest';
import * as Q from './queue';

const T = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
const ids = (q: Q.QueueState<{ id: string }>) => q.items.map((t) => t.id);
/** deterministic rng */
const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe('queue', () => {
  it('creates a plain queue', () => {
    const q = Q.createQueue(T(4), 2);
    expect(ids(q)).toEqual(['t0', 't1', 't2', 't3']);
    expect(q.index).toBe(2);
    expect(q.original).toBeUndefined();
    expect(Q.createQueue([], 0).index).toBe(-1);
  });

  it('shuffle keeps the start track first and every track once', () => {
    const q = Q.createQueue(T(20), 5, true, seeded());
    expect(q.index).toBe(0);
    expect(q.items[0]!.id).toBe('t5');
    expect(new Set(ids(q)).size).toBe(20);
    expect(ids(q)).not.toEqual(ids(Q.createQueue(T(20), 5)));
    expect(q.original?.map((t) => t.id)).toEqual(ids(Q.createQueue(T(20), 0)));
  });

  it('shuffle on/off keeps the current track current', () => {
    const plain = Q.createQueue(T(10), 3);
    const on = Q.enableShuffle(plain, seeded(3));
    expect(on.items[on.index]!.id).toBe('t3');
    expect(on.index).toBe(0);
    const moved = { ...on, index: 4 };
    const current = moved.items[4]!.id;
    const off = Q.disableShuffle(moved);
    expect(ids(off)).toEqual(ids(plain));
    expect(off.items[off.index]!.id).toBe(current);
    expect(Q.enableShuffle(on)).toBe(on);
    expect(Q.disableShuffle(plain)).toBe(plain);
  });

  it('next/prev follow repeat modes', () => {
    expect(Q.nextIndex(3, 0, 'off', true)).toBe(1);
    expect(Q.nextIndex(3, 2, 'off', true)).toBe(-1);
    expect(Q.nextIndex(3, 2, 'all', true)).toBe(0);
    expect(Q.nextIndex(3, 1, 'one', true)).toBe(1);
    expect(Q.nextIndex(3, 1, 'one', false)).toBe(2);
    expect(Q.nextIndex(3, 2, 'one', false)).toBe(0);
    expect(Q.nextIndex(0, -1, 'all', true)).toBe(-1);
    expect(Q.prevIndex(3, 2, 'off')).toBe(1);
    expect(Q.prevIndex(3, 0, 'off')).toBe(0);
    expect(Q.prevIndex(3, 0, 'all')).toBe(2);
  });

  it('play next / add to queue / remove / move / clear', () => {
    let q = Q.createQueue(T(4), 1);
    q = Q.insertNext(q, [{ id: 'x' }, { id: 'y' }]);
    expect(ids(q)).toEqual(['t0', 't1', 'x', 'y', 't2', 't3']);
    q = Q.append(q, [{ id: 'z' }]);
    expect(ids(q).at(-1)).toBe('z');
    q = Q.removeAt(q, 0);
    expect(q.index).toBe(0);
    expect(q.items[q.index]!.id).toBe('t1');
    q = Q.move(q, 4, 1); // t3 right after current
    expect(ids(q)).toEqual(['t1', 't3', 'x', 'y', 't2', 'z']);
    q = Q.move(q, 0, 2); // move the current one
    expect(q.items[q.index]!.id).toBe('t1');
    expect(q.index).toBe(2);
    q = Q.move(q, 4, 0); // from after to before current
    expect(q.items[q.index]!.id).toBe('t1');
    q = Q.clearUpcoming(q);
    expect(q.items.at(-1)!.id).toBe('t1');
    expect(q.index).toBe(q.items.length - 1);
  });

  it('keeps original in sync while shuffled', () => {
    let q = Q.createQueue(T(5), 0, true, seeded(11));
    q = Q.insertNext(q, [{ id: 'n' }]);
    expect(q.items[1]!.id).toBe('n');
    expect(q.original!.map((t) => t.id)).toEqual(['t0', 'n', 't1', 't2', 't3', 't4']);
    q = Q.removeIds(q, new Set(['t2', 'n']));
    expect(q.original!.map((t) => t.id)).toEqual(['t0', 't1', 't3', 't4']);
    expect(ids(q)).not.toContain('t2');
    const off = Q.disableShuffle(q);
    expect(ids(off)).toEqual(['t0', 't1', 't3', 't4']);
  });

  it('starts an empty queue at the first added track', () => {
    const q = Q.append(Q.createQueue<{ id: string }>([], 0), [{ id: 'a' }]);
    expect(q.index).toBe(0);
    expect(Q.moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });
});
