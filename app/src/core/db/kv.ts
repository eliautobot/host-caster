import type { KvRecord } from '../types';
import { db } from './db';

export async function kvGet<T>(key: string): Promise<KvRecord<T> | undefined> {
  return (await db.kv.get(key)) as KvRecord<T> | undefined;
}

export async function kvSet<T>(key: string, value: T, fetchedAt = Date.now()): Promise<KvRecord<T>> {
  const prev = await db.kv.get(key);
  const now = Date.now();
  const rec: KvRecord<T> = { id: key, value, fetchedAt, createdAt: prev?.createdAt ?? now, updatedAt: now };
  await db.kv.put(rec);
  return rec;
}

export function kvDelete(key: string): Promise<void> {
  return db.kv.delete(key);
}
