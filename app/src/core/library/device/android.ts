// Android: MediaStore through the HostCasterDeviceMusic plugin (DeviceMusicPlugin.java). Songs play from where they are
// at /_hostcaster_device_/<token>/<id> on the app's own origin (DeviceMusicStream.java answers with byte ranges).
import { registerPlugin } from '@capacitor/core';
import type { DeviceAccess, DeviceScanner, DeviceSong } from './types';

interface NativeSong {
  id: string;
  name: string;
  folder: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  albumId?: string;
  durationMs?: number;
  trackNo?: number;
  discNo?: number;
  year?: number;
  size?: number;
  mime?: string;
  modifiedAt?: number;
  kind?: DeviceSong['kind'];
}

interface Status {
  access: DeviceAccess;
  base: string;
}

interface DeviceMusicPlugin {
  status(): Promise<Status>;
  request(): Promise<Status>;
  scan(): Promise<{ songs: NativeSong[] }>;
  artwork(o: { id: string; albumId?: string }): Promise<{ data?: string; mime?: string }>;
  openSettings(): Promise<void>;
}

const Native = registerPlugin<DeviceMusicPlugin>('HostCasterDeviceMusic');
let base: string | undefined;

async function status(): Promise<Status> {
  const s = await Native.status();
  base = s.base;
  return s;
}

const idOf = (ref: string) => ref.slice('android:'.length);

export function fromNative(n: NativeSong): DeviceSong {
  return {
    ref: `android:${n.id}`,
    folder: n.folder ?? '',
    name: n.name,
    path: n.folder ? `${n.folder}/${n.name}` : n.name,
    size: n.size ?? 0,
    mime: n.mime ?? 'audio/mpeg',
    modifiedAt: n.modifiedAt ?? 0,
    durationMs: n.durationMs ?? 0,
    title: n.title,
    artist: n.artist,
    album: n.album,
    albumArtist: n.albumArtist,
    year: n.year,
    trackNo: n.trackNo,
    discNo: n.discNo,
    albumKey: n.albumId,
    kind: n.kind ?? 'music',
  };
}

export const androidScanner: DeviceScanner = {
  platform: 'android',
  access: async () => (await status()).access,
  requestAccess: async () => {
    const s = await Native.request();
    base = s.base;
    return s.access;
  },
  scan: async () => (await Native.scan()).songs.map(fromNative),
  artwork: async (song) => {
    const r = await Native.artwork({ id: idOf(song.ref), albumId: song.albumKey }).catch(() => ({}) as { data?: string });
    if (!r.data) return undefined;
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: 'image/jpeg' });
  },
  url: async (ref) => {
    if (!base) await status();
    return `${location.origin}${base}${encodeURIComponent(idOf(ref))}`;
  },
  openSettings: () => Native.openSettings(),
};
