import { beforeEach, describe, expect, it } from 'vitest';
import type { Brain, Host, SyncDoc } from '../types';
import { db, initDb, kvDelete, listBrains, listHosts, SEED_IDS } from './index';
import { migrateDocBrains, migrateLocalBrains, NO_BRAIN_DONE_KEY } from './noBrain';

const T = 5_000;
const brain = (id: string, kind: Brain['kind']): Brain => ({ id, name: id, kind, model: 'm', transport: 'device', createdAt: T, updatedAt: T });

describe('"Built-in host" brains move to no AI brain (once)', () => {
  beforeEach(async () => {
    await db.delete();
    await initDb();
  });

  it('runs on start: a fresh install is marked done and its hosts have no brain', async () => {
    expect(await db.kv.get(NO_BRAIN_DONE_KEY)).toBeTruthy();
    expect((await listHosts()).every((h) => h.brainId === null)).toBe(true);
  });

  it('on this device: built-in hosts and brains of that kind go, real brains stay, updatedAt is kept', async () => {
    const [maya, jules, rex] = await listHosts();
    await db.brains.bulkPut([brain('ai', 'openai'), brain('old-builtin', 'builtin')]);
    await db.hosts.bulkPut([
      { ...maya!, brainId: 'builtin', updatedAt: T },
      { ...jules!, brainId: 'old-builtin', updatedAt: T },
      { ...rex!, brainId: 'ai', updatedAt: T },
    ] as Host[]);
    await kvDelete(NO_BRAIN_DONE_KEY);
    expect(await migrateLocalBrains(db)).toBe(2);
    const byId = new Map((await listHosts()).map((h) => [h.id, h]));
    expect(byId.get(SEED_IDS.maya)?.brainId).toBeNull();
    expect(byId.get(SEED_IDS.jules)?.brainId).toBeNull();
    expect(byId.get(rex!.id)?.brainId).toBe('ai');
    expect(byId.get(SEED_IDS.maya)?.updatedAt).toBe(T);
    expect((await listBrains()).map((b) => b.id)).toEqual(['ai']);
    // once: a later built-in id (an old synced doc) is handled by the sync path, not by running this again
    await db.hosts.update(SEED_IDS.maya, { brainId: 'builtin' });
    expect(await migrateLocalBrains(db)).toBe(0);
    // a restored backup runs it again
    expect(await migrateLocalBrains(db, Date.now(), { force: true })).toBe(1);
  });

  it('in a synced doc from the server: same rule, a clean doc comes back as is', () => {
    const doc = {
      hosts: [
        { id: 'h1', brainId: 'builtin' },
        { id: 'h2', brainId: 'x' },
        { id: 'h3', brainId: 'ai' },
        { id: 'h4', brainId: null },
      ],
      stations: [],
      brains: [brain('ai', 'openai'), brain('x', 'builtin')],
      voices: [],
      playlists: [],
    } as unknown as SyncDoc;
    const out = migrateDocBrains(doc);
    expect(out.hosts.map((h) => h.brainId)).toEqual([null, null, 'ai', null]);
    expect(out.brains.map((b) => b.id)).toEqual(['ai']);
    expect(migrateDocBrains(out)).toBe(out);
  });
});
