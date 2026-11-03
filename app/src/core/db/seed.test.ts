import { beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_VOICE_ID } from '../types';
import { SEED_IDS, db, deleteHost, getProfile, getSettings, initDb, listHosts, listStations, saveHost, saveProfile, saveSettings, saveStation } from './index';

describe('db seed', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });

  it('creates profile, settings, 3 hosts and the starter station', async () => {
    const hosts = await listHosts();
    expect(hosts.map((h) => h.name)).toEqual(['Maya', 'Jules', 'Rex']);
    for (const h of hosts) {
      expect(h.brainId).toBeNull(); // no AI yet: the scripted fallback reads their lines
      expect(h.voice.voiceProviderId).toBe(DEVICE_VOICE_ID);
    }
    const [station] = await listStations();
    expect(station?.name).toBe('Host-Caster 88.1');
    expect(station?.hostIds).toEqual([SEED_IDS.maya, SEED_IDS.jules]);
    expect(station?.talkEvery).toBe(2);
    expect(station?.sources).toEqual([{ kind: 'library' }]);
    expect((await getSettings()).activeStationId).toBe(SEED_IDS.station);
    expect((await getProfile()).id).toBe('me');
  });

  it('is idempotent and keeps deletions', async () => {
    await deleteHost(SEED_IDS.jules);
    await initDb();
    expect((await listHosts()).map((h) => h.name)).toEqual(['Maya', 'Rex']);
    expect((await listStations())[0]?.hostIds).toEqual([SEED_IDS.maya]);
  });

  it('stamps new records', async () => {
    const [maya] = await listHosts();
    if (!maya) throw new Error('no seed');
    const { id: _id, createdAt: _c, updatedAt: _u, ...draft } = maya;
    const copy = await saveHost({ ...draft, name: 'Maya 2' });
    expect(copy.id).not.toBe(maya.id);
    expect(copy.createdAt).toBeGreaterThan(0);
  });

  it('a save that changes nothing is not an edit (the starter stays untouched for sync)', async () => {
    const [maya] = await listHosts();
    const [station] = await listStations();
    const before = { host: maya!.updatedAt, station: station!.updatedAt, profile: (await getProfile()).updatedAt, settings: (await getSettings()).updatedAt };
    await new Promise((r) => setTimeout(r, 5));
    expect((await saveHost({ ...maya! })).updatedAt).toBe(before.host);
    expect((await saveStation({ ...station! })).updatedAt).toBe(before.station);
    expect((await saveProfile({ name: '' })).updatedAt).toBe(before.profile);
    expect((await saveSettings({ theme: (await getSettings()).theme })).updatedAt).toBe(before.settings);
    expect((await saveHost({ ...maya!, name: 'Maya!' })).updatedAt).toBeGreaterThan(before.host);
    expect((await saveProfile({ name: 'Sam' })).updatedAt).toBeGreaterThan(before.profile);
  });
});

