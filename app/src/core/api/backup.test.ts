import { beforeEach, describe, expect, it } from 'vitest';
import { db, initDb, listHosts, putBlob, saveBrain, saveTracks, saveSettings } from '../db';
import { kvSet } from '../db/kv';
import type { Brain, Track } from '../types';
import { exportBackup, importBackup } from './backup';

const track = (ref: string): Track =>
  ({ title: 'Song', artist: 'A', album: 'B', durationMs: 1000, source: 'local', ref, playCount: 0, addedAt: 1 }) as Track;

describe('backup', () => {
  beforeEach(async () => {
    db.close();
    await db.delete();
    await initDb();
  });

  it('round-trips everything; songs and keys only when asked; session rows never', async () => {
    const audio = await putBlob(new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'audio/mpeg' }));
    const art = await putBlob(new Blob([new Uint8Array([9, 9])], { type: 'image/png' }));
    await saveTracks([{ ...track(audio.id), artworkId: art.id }]);
    await saveBrain({ name: 'OpenAI', kind: 'openai', apiKey: 'sk-secret', model: 'm', transport: 'device' } as Brain);
    await saveSettings({ serverUrl: 'https://radio.example.com' });
    await kvSet('api:session', { token: 'bearer-xyz' });
    await kvSet('weather:now', { t: 20 });
    await kvSet('spotify:tokens', { refreshToken: 'spotify-refresh-xyz' });
    await kvSet('subsonic:auth', { token: 'subsonic-pass-xyz' });
    await kvSet('auth:pkce', { verifier: 'pkce-xyz' });

    const lean = await exportBackup({ songs: false, keys: false });
    const leanText = await lean.file.text();
    expect(JSON.parse(leanText).format).toBe('hostcaster-backup');
    expect(leanText).not.toContain('sk-secret');
    expect(leanText).not.toContain('bearer-xyz');
    expect(leanText).not.toContain('radio.example.com');
    // music service sign-ins are credentials too: only with keys
    expect(leanText).not.toContain('spotify-refresh-xyz');
    expect(leanText).not.toContain('subsonic-pass-xyz');
    expect(leanText).not.toContain('pkce-xyz');
    expect(lean.counts.blobs).toBe(1); // artwork only

    const full = await exportBackup({ songs: true, keys: true });
    expect(full.counts.blobs).toBe(2);
    expect(await full.file.text()).toContain('sk-secret');
    expect(await full.file.text()).toContain('spotify-refresh-xyz');
    expect(await full.file.text()).not.toContain('pkce-xyz');

    // wipe hosts etc., then restore the full backup
    await db.hosts.clear();
    await db.tracks.clear();
    await db.blobs.clear();
    const header = await importBackup(full.file);
    expect(header.includes).toEqual({ songs: true, keys: true });
    expect((await listHosts()).map((h) => h.name)).toEqual(['Maya', 'Jules', 'Rex']);
    const [t] = await db.tracks.toArray();
    const blob = (await db.blobs.get(t!.ref))!.blob;
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 250]);
    expect((await db.brains.toArray())[0]?.apiKey).toBe('sk-secret');
    expect((await db.settings.get('app'))?.serverUrl).toBe('https://radio.example.com');
    expect((await db.kv.get('api:session'))?.value).toEqual({ token: 'bearer-xyz' });
    expect((await db.kv.get('weather:now'))?.value).toEqual({ t: 20 });
  });

  it('refuses a broken or foreign file without touching data', async () => {
    await expect(importBackup(new Blob(['{"hello":1}']))).rejects.toThrow(/not a Host-Caster backup/);
    const good = await exportBackup({ songs: false, keys: false });
    const text = await good.file.text();
    const broken = new Blob([text.slice(0, text.length - 40) + 'garbage}\n]}']);
    await expect(importBackup(broken)).rejects.toThrow();
    expect((await listHosts()).length).toBe(3);
  });
});
