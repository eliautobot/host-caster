import type { BaseRecord, Draft } from '../types';
import { newId } from '../util/id';

/** Fills id/createdAt and bumps updatedAt. */
export function stamp<T extends BaseRecord>(record: Draft<T> | T, now = Date.now()): T {
  return {
    ...record,
    id: record.id ?? newId(),
    createdAt: record.createdAt ?? now,
    updatedAt: now,
  } as T;
}
