import type { Break, Draft } from '../types';
import { db } from './db';
import { stamp } from './stamp';

export async function addBreak(brk: Draft<Break>): Promise<Break> {
  const rec = stamp<Break>(brk);
  await db.breaks.put(rec);
  return rec;
}

/** Newest first. */
export function listBreaks(stationId: string, limit = 20): Promise<Break[]> {
  return db.breaks
    .where('[stationId+at]')
    .between([stationId, -Infinity], [stationId, Infinity])
    .reverse()
    .limit(limit)
    .toArray();
}
