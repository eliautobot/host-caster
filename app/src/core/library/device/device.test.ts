import { describe, expect, it } from 'vitest';
import type { Track } from '../../types';
import { fromNative } from './android';
import { fromDesktop } from './desktop';
import { musicOnly, notMusic } from './filters';
import { planDeviceSync } from './plan';
import type { DeviceSong } from './types';

const song = (id: number, o: Partial<DeviceSong> = {}): DeviceSong => ({
  ref: `android:${id}`,
  folder: 'Music/HostCasterTest',
  name: `${id}.mp3`,
  path: `Music/HostCasterTest/${id}.mp3`,
  size: 1000 + id,
  mime: 'audio/mpeg',
  modifiedAt: 1_700_000_000_000,
  durationMs: 180_000,
  title: `Song ${id}`,
  artist: 'Test Artist',
  album: 'Test Album',
  kind: 'music',
  ...o,
});

let n = 0;
const track = (o: Partial<Track>): Track =>
  ({
    id: `t${++n}`,
    createdAt: 0,
    updatedAt: 0,
    title: 'x',
    artist: 'y',
    album: 'z',
    durationMs: 180_000,
    source: 'local',
    ref: `blob${n}`,
    playCount: 0,
    addedAt: 0,
    ...o,
  }) as Track;

const asTrack = (s: DeviceSong, o: Partial<Track> = {}) =>
  track({ title: s.title, artist: s.artist, album: s.album, durationMs: s.durationMs, source: 'device', ref: s.ref, file: { name: s.name, size: s.size, mime: s.mime, modifiedAt: s.modifiedAt }, ...o });

describe('music only', () => {
  it('keeps songs', () => {
    expect(notMusic(song(1))).toBeUndefined();
    expect(notMusic(song(2, { folder: 'Download', name: 'Live.flac', mime: 'audio/flac' }))).toBeUndefined();
  });

  it('leaves out ringtones, alarms, notifications, podcasts and recordings the system marks', () => {
    for (const kind of ['ringtone', 'alarm', 'notification', 'podcast', 'audiobook', 'recording'] as const) expect(notMusic(song(1, { kind }))).toBe('kind');
  });

  it('leaves out recordings and voice notes by their folder, at any depth', () => {
    const folders = ['Recordings', 'Music/Recordings', 'Call recordings', 'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Voice Notes/202644', 'Voice Recorder', 'Ringtones', 'Notifications', 'Alarms', 'Podcasts', 'Music/.thumbnails'];
    for (const folder of folders) expect(notMusic(song(1, { folder })), folder).toBe('folder');
    expect(notMusic(song(1, { folder: 'Music/Recording Sessions Live' }))).toBeUndefined();
  });

  it('leaves out very short files and non-audio files', () => {
    expect(notMusic(song(1, { durationMs: 12_000 }))).toBe('short');
    expect(notMusic(song(1, { durationMs: 0 }))).toBeUndefined(); // unknown yet (desktop/web): checked after tags
    expect(notMusic(song(1, { name: 'cover.jpg', mime: 'image/jpeg' }))).toBe('type');
    expect(musicOnly([song(1), song(2, { kind: 'ringtone' }), song(3, { durationMs: 5000 })]).map((s) => s.ref)).toEqual(['android:1']);
  });
});

describe('first look', () => {
  it('adds new songs and counts them per folder', () => {
    const scanned = [song(1), song(2), song(3, { folder: 'Download' }), song(4, { kind: 'ringtone', folder: 'Ringtones' })];
    const plan = planDeviceSync([], scanned, { platform: 'android', excluded: [] });
    expect(plan.add.map((s) => s.ref)).toEqual(['android:1', 'android:2', 'android:3']);
    expect(plan.folders).toEqual([
      { key: 'Download', count: 1, included: true },
      { key: 'Music/HostCasterTest', count: 2, included: true },
    ]);
    expect(plan.total).toBe(3);
    expect(plan.remove).toEqual([]);
  });

  it('a folder switched off adds nothing from it', () => {
    const plan = planDeviceSync([], [song(1), song(3, { folder: 'Download' })], { platform: 'android', excluded: ['Download'] });
    expect(plan.add.map((s) => s.ref)).toEqual(['android:1']);
    expect(plan.folders.find((f) => f.key === 'Download')?.included).toBe(false);
  });
});

describe('no doubles', () => {
  it('a song imported before (same tags, duration within 2 s) is not added again', () => {
    const imported = track({ title: 'Song 1', artist: 'Test Artist', album: 'Test Album', durationMs: 181_000 });
    const plan = planDeviceSync([imported], [song(1), song(2)], { platform: 'android', excluded: [] });
    expect(plan.add.map((s) => s.ref)).toEqual(['android:2']);
    expect(plan.duplicates).toBe(1);
  });

  it('an imported copy of the same file (name and size) is not added again, even without tags', () => {
    const imported = track({ file: { name: '1.mp3', size: 1001, mime: 'audio/mpeg' } });
    const plan = planDeviceSync([imported], [song(1, { title: undefined, needsTags: true })], { platform: 'android', excluded: [] });
    expect(plan.add).toEqual([]);
    expect(plan.duplicates).toBe(1);
  });

  it('the same song in two folders is added once', () => {
    const plan = planDeviceSync([], [song(1), song(9, { title: 'Song 1', folder: 'Download', size: 5 })], { platform: 'android', excluded: [] });
    expect(plan.add.map((s) => s.ref)).toEqual(['android:1']);
  });

  it('songs already added from the device stay as they are', () => {
    const s = song(1);
    const plan = planDeviceSync([asTrack(s)], [s, song(2)], { platform: 'android', excluded: [] });
    expect(plan.add.map((x) => x.ref)).toEqual(['android:2']);
    expect(plan.update).toEqual([]);
  });
});

describe('looking again', () => {
  it('new songs are added, deleted ones removed, nothing else touched', () => {
    const a = song(1);
    const b = song(2);
    const lib = [asTrack(a), asTrack(b), track({ title: 'Imported' }), track({ source: 'youtube', ref: 'abc' }), asTrack(song(7, { ref: 'desktop:x/7.mp3' }))];
    const plan = planDeviceSync(lib, [a, song(3)], { platform: 'android', excluded: [] });
    expect(plan.add.map((s) => s.ref)).toEqual(['android:3']);
    expect(plan.remove.map((t) => t.ref)).toEqual(['android:2']);
  });

  it('a changed file (size or date) is read again', () => {
    const a = song(1);
    const plan = planDeviceSync([asTrack(a)], [{ ...a, size: a.size + 10 }], { platform: 'android', excluded: [] });
    expect(plan.update.map((u) => u.song.ref)).toEqual(['android:1']);
  });

  it('switching a folder off takes its songs out', () => {
    const a = song(1, { folder: 'Download' });
    const plan = planDeviceSync([asTrack(a)], [a, song(2)], { platform: 'android', excluded: ['Download'] });
    expect(plan.remove.map((t) => t.ref)).toEqual(['android:1']);
  });

  it('an empty look (memory card out, drive not there) removes nothing', () => {
    const plan = planDeviceSync([asTrack(song(1)), asTrack(song(2))], [], { platform: 'android', excluded: [] });
    expect(plan.remove).toEqual([]);
  });
});

describe('files left out after reading their tags', () => {
  it('are not offered again until they change', () => {
    const beep = song(5, { title: undefined, durationMs: 0, needsTags: true });
    const copy = song(6, { title: undefined, durationMs: 0, needsTags: true });
    const skipped = { [beep.ref]: { sig: `${beep.size}:${beep.modifiedAt}`, why: 'short' as const }, [copy.ref]: { sig: `${copy.size}:${copy.modifiedAt}`, why: 'duplicate' as const } };
    const plan = planDeviceSync([], [beep, copy, song(7)], { platform: 'android', excluded: [], skipped });
    expect(plan.add.map((s) => s.ref)).toEqual(['android:7']);
    expect(plan.duplicates).toBe(1);
    expect(plan.folders[0]!.count).toBe(2); // the short one is not music
    const changed = planDeviceSync([], [{ ...beep, size: 1 }], { platform: 'android', excluded: [], skipped });
    expect(changed.add.map((s) => s.ref)).toEqual(['android:5']);
  });
});

describe('platform songs', () => {
  it('Android: MediaStore rows become device songs', () => {
    const s = fromNative({ id: '42', name: 'a.mp3', folder: 'Music/Mix', title: 'A', artist: 'B', durationMs: 200_000, size: 9, mime: 'audio/mpeg', modifiedAt: 5, albumId: '7', kind: 'music' });
    expect(s).toMatchObject({ ref: 'android:42', path: 'Music/Mix/a.mp3', folder: 'Music/Mix', albumKey: '7', durationMs: 200_000 });
  });

  it('desktop: files in a music folder, grouped by their folder', () => {
    const folders = new Map([['f1', '/home/me/Music']]);
    const s = fromDesktop({ folder: 'f1', rel: 'Albums/Blue/01 Song.flac', size: 3, modifiedAt: 4 }, folders);
    expect(s).toMatchObject({ ref: 'desktop:f1/Albums/Blue/01 Song.flac', folder: 'Music/Albums/Blue', name: '01 Song.flac', mime: 'audio/flac', needsTags: true });
    expect(fromDesktop({ folder: 'f1', rel: 'x.mp3', size: 1, modifiedAt: 1 }, folders).folder).toBe('Music');
  });
});
