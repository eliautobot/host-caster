import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Brain, Break, Host, Station, VoiceProvider } from '../types';
import { SEED_IDS, STARTER_HOSTS, STARTER_STATION, db, getSettings, initDb, listBrains, listHosts, listStations, listVoices } from './index';
import { LEGACY_DB_NAME, LEGACY_DONE_KEY, migrateLegacyDb, renameLegacyRecord } from './legacy';
import { HostCasterDB } from './schema';

const OLD = 'Airwave';
const T = 1_000;

/** An old-name database as a device has it before the rename: its own settings, songs, renamed seed and plan AI. */
async function makeLegacy(): Promise<void> {
  const old = new HostCasterDB(LEGACY_DB_NAME);
  await old.open();
  const maya = STARTER_HOSTS[0]!;
  await old.hosts.put({ ...maya, tagline: `Mornings on ${OLD} 88.1`, catchphrases: [`This is ${OLD}!`, 'Stay tuned'], createdAt: T, updatedAt: T } as Host);
  await old.stations.put({ ...STARTER_STATION, name: `${OLD} 88.1`, createdAt: T, updatedAt: T } as Station);
  await old.stations.put({ ...STARTER_STATION, id: 'st-anywhere', name: `${OLD} Anywhere`, createdAt: T, updatedAt: T } as Station);
  await old.stations.put({ ...STARTER_STATION, id: 'st-mine', name: 'Night Shift FM', createdAt: T, updatedAt: T } as Station);
  await old.brains.put({ id: 'b1', name: `${OLD} AI`, kind: 'airwave', preset: 'airwave', model: 'airwave', transport: 'server', createdAt: T, updatedAt: T } as unknown as Brain);
  await old.brains.put({ id: 'b2', name: 'Ollama', kind: 'openai', preset: 'ollama', model: 'gemma3', transport: 'device', createdAt: T, updatedAt: T } as Brain);
  await old.voices.put({ id: 'v1', name: `${OLD} Voices`, kind: 'airwave', preset: 'airwave', model: '', transport: 'server', createdAt: T, updatedAt: T } as unknown as VoiceProvider);
  await old.breaks.put({ id: 'br1', stationId: SEED_IDS.station, at: T, lines: [{ hostId: maya.id, text: `Welcome to ${OLD} 88.1.` }], topics: [], createdAt: T, updatedAt: T } as Break);
  await old.tracks.put({ id: 't1', title: 'Blue Hour', artist: 'Someone', album: 'A', durationMs: 1000, source: 'local', ref: 'blob1', playCount: 3, addedAt: T } as never);
  await old.blobs.put({ id: 'blob1', blob: new Blob(['song bytes']), mime: 'audio/mpeg', size: 10 } as never);
  await old.settings.put({ id: 'app', theme: 'light', onboarded: true, activeStationId: 'st-mine', connections: {}, createdAt: T, updatedAt: T } as never);
  await old.profile.put({ id: 'me', name: 'Sam', callMe: 'Sam', createdAt: T, updatedAt: T } as never);
  await old.kv.put({ id: 'weather:now', value: { temp: 20 }, fetchedAt: T, createdAt: T, updatedAt: T });
  old.close();
}

describe('move from the old name', () => {
  beforeEach(async () => {
    db.close();
    await Dexie.delete(LEGACY_DB_NAME);
    await db.delete();
    await db.open();
  });

  it('copies every table once, renames the old name, deletes the old database, then does not seed over it', async () => {
    await makeLegacy();
    db.close();
    await initDb();
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(false);
    expect((await getSettings()).theme).toBe('light');
    expect((await getSettings()).activeStationId).toBe('st-mine');
    expect((await db.profile.get('me'))?.name).toBe('Sam');
    expect((await db.tracks.get('t1'))?.playCount).toBe(3);
    expect(await (await db.blobs.get('blob1'))!.blob.text()).toBe('song bytes');
    expect((await db.kv.get('weather:now'))?.value).toEqual({ temp: 20 });
    expect((await listStations()).map((s) => s.name).sort()).toEqual(['Host-Caster 88.1', 'Host-Caster Anywhere', 'Night Shift FM']);
    const maya = (await listHosts()).find((h) => h.id === SEED_IDS.maya)!;
    expect(maya.tagline).toBe('Mornings on Host-Caster 88.1');
    expect(maya.catchphrases).toEqual(['This is Host-Caster!', 'Stay tuned']);
    expect(maya.updatedAt).toBeGreaterThan(T);
    // only Maya was there: the seed did not add Jules and Rex back (settings existed)
    expect((await listHosts()).length).toBe(1);
    const brains = await listBrains();
    expect(brains.find((b) => b.id === 'b1')).toMatchObject({ name: 'Host-Caster AI', kind: 'hostcaster', preset: 'hostcaster', model: 'hostcaster' });
    expect(brains.find((b) => b.id === 'b2')).toMatchObject({ name: 'Ollama', kind: 'openai', model: 'gemma3', updatedAt: T });
    expect((await listVoices()).find((v) => v.id === 'v1')).toMatchObject({ name: 'Host-Caster Voices', kind: 'hostcaster', preset: 'hostcaster' });
    expect((await db.breaks.get('br1'))?.lines[0]?.text).toBe('Welcome to Host-Caster 88.1.');
    expect(await db.kv.get(LEGACY_DONE_KEY)).toBeTruthy();
    // second start: nothing left to move
    expect(await migrateLegacyDb(db)).toBe(false);
  });

  it('a fresh install (no old database) seeds as before', async () => {
    db.close();
    await initDb();
    expect((await listStations()).map((s) => s.name)).toEqual(['Host-Caster 88.1']);
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(false);
  });

  it('after a finished copy it only removes the old database (no second copy over newer edits)', async () => {
    await makeLegacy();
    await db.kv.put({ id: LEGACY_DONE_KEY, value: true, fetchedAt: T, createdAt: T, updatedAt: T });
    expect(await migrateLegacyDb(db)).toBe(true);
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(false);
    expect(await db.stations.count()).toBe(0);
  });

  it('leaves records without the old name untouched', () => {
    const rec = { id: 'x', name: 'Night Shift FM', description: 'Late', createdAt: T, updatedAt: T };
    expect(renameLegacyRecord('stations', rec)).toBe(rec);
    const track = { id: 't', title: 'Airwave', updatedAt: T };
    expect(renameLegacyRecord('tracks', track)).toBe(track); // song titles are the user's music, not ours
  });
});
