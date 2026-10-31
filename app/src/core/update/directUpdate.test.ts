import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { CHECK_EVERY_MS, SNOOZE_MS, checkForUpdate, decide, isDownloadUrl, parseManifest, snoozeUpdate } from './directUpdate';

const SHA = 'a'.repeat(64);
const manifest = (over: Record<string, unknown> = {}) => ({
  version: '0.1.1',
  versionCode: 10100,
  url: 'https://host-caster.com/download/android/host-caster-0.1.1.apk',
  sha256: SHA,
  size: 4_200_000,
  released: '2026-11-02',
  notes: ['Faster start', 'Fixes'],
  minimumSupported: 10000,
  ...over,
});

describe('parseManifest', () => {
  it('reads a good manifest', () => {
    const m = parseManifest(manifest());
    expect(m).toMatchObject({ version: '0.1.1', versionCode: 10100, sha256: SHA, notes: ['Faster start', 'Fixes'], minimumSupported: 10000 });
  });

  it('rejects anything malformed', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('x')).toBeNull();
    expect(parseManifest(manifest({ version: 'one' }))).toBeNull();
    expect(parseManifest(manifest({ versionCode: '10100' }))).toBeNull();
    expect(parseManifest(manifest({ versionCode: 1.5 }))).toBeNull();
    expect(parseManifest(manifest({ sha256: 'abc' }))).toBeNull();
    expect(parseManifest(manifest({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(parseManifest(manifest({ url: 'http://example.com/a.apk' }))).toBeNull();
  });

  it('keeps notes short and few, takes one string too', () => {
    expect(parseManifest(manifest({ notes: 'One line' }))?.notes).toEqual(['One line']);
    const many = parseManifest(manifest({ notes: Array.from({ length: 9 }, (_, i) => `n${i}`).concat([5 as unknown as string]) }));
    expect(many?.notes).toHaveLength(5);
    expect(parseManifest(manifest({ notes: ['x'.repeat(500)] }))?.notes[0]).toHaveLength(200);
  });

  it('defaults minimumSupported to 0 and drops a bad page link', () => {
    const m = parseManifest(manifest({ minimumSupported: undefined, page: 'file:///x' }));
    expect(m?.minimumSupported).toBe(0);
    expect(m?.page).toBeUndefined();
  });
});

describe('isDownloadUrl', () => {
  it('allows https anywhere and http only on this device', () => {
    expect(isDownloadUrl('https://host-caster.com/a.apk')).toBe(true);
    expect(isDownloadUrl('http://127.0.0.1:8697/a.apk')).toBe(true);
    expect(isDownloadUrl('http://localhost/a.apk')).toBe(true);
    expect(isDownloadUrl('http://192.168.1.2/a.apk')).toBe(false);
    expect(isDownloadUrl('https://user:pw@host-caster.com/a.apk')).toBe(false);
    expect(isDownloadUrl(42)).toBe(false);
  });
});

describe('decide', () => {
  const rel = parseManifest(manifest())!;
  const now = 1_000_000;

  it('nothing when the installed build is the same or newer', () => {
    expect(decide(rel, 10100, {}, now).kind).toBe('none');
    expect(decide(rel, 10200, {}, now).kind).toBe('none');
    expect(decide(null, 10000, {}, now).kind).toBe('none');
  });

  it('available when newer, required below the minimum', () => {
    expect(decide(rel, 10000, {}, now).kind).toBe('available');
    expect(decide({ ...rel, minimumSupported: 10050 }, 10000, {}, now).kind).toBe('required');
  });

  it('Later hides an optional update until it runs out or a newer one comes', () => {
    const snoozed = { snoozed: { versionCode: 10100, until: now + 10 } };
    expect(decide(rel, 10000, snoozed, now).kind).toBe('none');
    expect(decide(rel, 10000, snoozed, now + 11).kind).toBe('available');
    expect(decide({ ...rel, versionCode: 10200 }, 10000, snoozed, now).kind).toBe('available');
    expect(decide({ ...rel, minimumSupported: 10050 }, 10000, snoozed, now).kind).toBe('required');
  });
});

describe('checkForUpdate', () => {
  beforeEach(async () => {
    await db.kv.clear();
  });

  it('asks the website once per period and remembers the answer between checks', async () => {
    let calls = 0;
    const fetchJson = async () => {
      calls++;
      return manifest();
    };
    const t0 = 5_000_000_000;
    expect((await checkForUpdate({ installedCode: 10000, now: t0, fetchJson })).kind).toBe('available');
    // not due: no network, the saved manifest still shows the notice
    expect((await checkForUpdate({ installedCode: 10000, now: t0 + 1000, fetchJson })).kind).toBe('available');
    expect(calls).toBe(1);
    await checkForUpdate({ installedCode: 10000, now: t0 + CHECK_EVERY_MS, fetchJson });
    expect(calls).toBe(2);
  });

  it('a failed check is quiet and keeps the last good manifest', async () => {
    const t0 = 6_000_000_000;
    await checkForUpdate({ installedCode: 10000, now: t0, fetchJson: async () => manifest() });
    const failed = await checkForUpdate({
      installedCode: 10000,
      now: t0 + CHECK_EVERY_MS,
      fetchJson: async () => {
        throw new Error('offline');
      },
    });
    expect(failed.kind).toBe('available');
    // a fresh install with no network: nothing
    await db.kv.clear();
    expect((await checkForUpdate({ installedCode: 10000, now: t0, fetchJson: async () => null })).kind).toBe('none');
  });

  it('Later is saved per version', async () => {
    const t0 = 7_000_000_000;
    const fetchJson = async () => manifest();
    await snoozeUpdate(10100, t0);
    expect((await checkForUpdate({ installedCode: 10000, now: t0 + 1, fetchJson, force: true })).kind).toBe('none');
    expect((await checkForUpdate({ installedCode: 10000, now: t0 + SNOOZE_MS + 1, fetchJson, force: true })).kind).toBe('available');
  });
});
