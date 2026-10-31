import type { Draft, Host, Station } from '../types';
import { db } from './db';
import { stamp } from './stamp';

export function listHosts(): Promise<Host[]> {
  return db.hosts.orderBy('createdAt').toArray();
}

export function getHost(id: string): Promise<Host | undefined> {
  return db.hosts.get(id);
}

export async function saveHost(host: Draft<Host> | Host): Promise<Host> {
  const rec = stamp<Host>(host);
  await db.hosts.put(rec);
  return rec;
}

/** Deletes the host and removes it from every station's line-up. */
export async function deleteHost(id: string): Promise<void> {
  await db.transaction('rw', [db.hosts, db.stations], async () => {
    await db.hosts.delete(id);
    await db.stations
      .filter((s) => s.hostIds.includes(id))
      .modify((s) => {
        s.hostIds = s.hostIds.filter((h) => h !== id);
      });
  });
}

export function listStations(): Promise<Station[]> {
  return db.stations.orderBy('createdAt').toArray();
}

export function getStation(id: string): Promise<Station | undefined> {
  return db.stations.get(id);
}

export async function saveStation(station: Draft<Station> | Station): Promise<Station> {
  const rec = stamp<Station>(station);
  await db.stations.put(rec);
  return rec;
}

export function deleteStation(id: string): Promise<void> {
  return db.stations.delete(id);
}
