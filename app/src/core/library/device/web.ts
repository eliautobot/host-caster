// Chrome and Edge on a computer: a music folder picked with the folder picker. The browser keeps the folder (stored in
// IndexedDB) and asks again for access after a restart unless the person chose "Allow on every visit". Songs play from
// the folder through a blob URL of the file (no copy).
import { kvGet, kvSet } from '../../db';
import { AUDIO_EXTS } from '../files';
import { readSongMeta } from '../metadata';
import { extOf } from '../text';
import type { DeviceAccess, DeviceRoot, DeviceScanner, DeviceSong } from './types';

const ROOTS_KEY = 'devicemusic:webRoots';
const MAX_FILES = 50_000;
const MAX_DEPTH = 12;

// the File System Access API is not in TypeScript's DOM types yet
interface Handle {
  kind: 'file' | 'directory';
  name: string;
  queryPermission?(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' }): Promise<PermissionState>;
}
interface FileHandle extends Handle {
  kind: 'file';
  getFile(): Promise<File>;
}
interface DirHandle extends Handle {
  kind: 'directory';
  values(): AsyncIterable<FileHandle | DirHandle>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
}
interface StoredRoot {
  id: string;
  name: string;
  handle: DirHandle;
}

const files = new Map<string, FileHandle>();
const urls = new Map<string, string>();

async function stored(): Promise<StoredRoot[]> {
  return (await kvGet<StoredRoot[]>(ROOTS_KEY))?.value ?? [];
}

async function permission(h: Handle, ask: boolean): Promise<PermissionState> {
  const o = { mode: 'read' as const };
  const now = (await h.queryPermission?.(o)) ?? 'granted';
  if (now === 'granted' || !ask) return now;
  return (await h.requestPermission?.(o)) ?? 'denied';
}

async function access(ask: boolean): Promise<DeviceAccess> {
  const roots = await stored();
  if (!roots.length) return 'prompt';
  let all: DeviceAccess = 'granted';
  for (const r of roots) {
    const p = await permission(r.handle, ask).catch(() => 'denied' as const);
    if (p === 'denied') all = 'denied';
    else if (p === 'prompt' && all === 'granted') all = 'prompt';
  }
  return all;
}

const newId = () => Math.random().toString(36).slice(2, 10);

async function walk(root: StoredRoot, out: DeviceSong[]) {
  const visit = async (dir: DirHandle, rel: string, depth: number) => {
    for await (const h of dir.values()) {
      if (out.length >= MAX_FILES) return;
      if (h.name.startsWith('.')) continue;
      const path = rel ? `${rel}/${h.name}` : h.name;
      if (h.kind === 'directory') {
        if (depth < MAX_DEPTH) await visit(h, path, depth + 1);
        continue;
      }
      if (!AUDIO_EXTS.includes(extOf(h.name))) continue;
      const file = await h.getFile().catch(() => undefined);
      if (!file) continue;
      const ref = `web:${root.id}/${path}`;
      files.set(ref, h);
      const folder = rel ? `${root.name}/${rel}` : root.name;
      out.push({
        ref,
        folder,
        name: h.name,
        path: `${folder}/${h.name}`,
        size: file.size,
        mime: file.type || 'audio/mpeg',
        modifiedAt: file.lastModified,
        durationMs: 0,
        kind: 'music',
        needsTags: true,
      });
    }
  };
  await visit(root.handle, '', 0);
}

async function fileOf(ref: string): Promise<File> {
  let h = files.get(ref);
  if (!h) {
    const rest = ref.slice('web:'.length);
    const slash = rest.indexOf('/');
    const root = (await stored()).find((r) => r.id === rest.slice(0, slash));
    if (!root) throw new Error('This music folder is no longer added');
    if ((await permission(root.handle, false)) !== 'granted') {
      throw new Error('Allow Host-Caster to open your music folder again (Library, Add music, Music folder)');
    }
    const parts = rest.slice(slash + 1).split('/');
    let dir = root.handle;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    h = await dir.getFileHandle(parts.at(-1)!);
    files.set(ref, h);
  }
  return h.getFile();
}

export const webScanner: DeviceScanner = {
  platform: 'web',
  access: () => access(false),
  requestAccess: () => access(true),
  scan: async () => {
    const out: DeviceSong[] = [];
    for (const r of await stored()) {
      if ((await permission(r.handle, false)) === 'granted') await walk(r, out);
    }
    return out;
  },
  readTags: async (song) => {
    const meta = await readSongMeta(await fileOf(song.ref));
    const { picture, ...tags } = meta;
    return { ...song, ...tags, needsTags: false, picture };
  },
  url: async (ref) => {
    const have = urls.get(ref);
    if (have) return have;
    const url = URL.createObjectURL(await fileOf(ref));
    urls.set(ref, url);
    return url;
  },
  roots: async () => (await stored()).map((r): DeviceRoot => ({ id: r.id, label: r.name })),
  addRoot: async () => {
    const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
    let handle: DirHandle;
    try {
      handle = await pick({ id: 'hostcaster-music', mode: 'read', startIn: 'music' });
    } catch {
      return undefined; // cancelled
    }
    const roots = await stored();
    for (const r of roots) {
      const same = await (r.handle as unknown as { isSameEntry?: (o: unknown) => Promise<boolean> }).isSameEntry?.(handle).catch(() => false);
      if (same) return { id: r.id, label: r.name };
    }
    const root: StoredRoot = { id: newId(), name: handle.name, handle };
    await kvSet(ROOTS_KEY, [...roots, root]);
    return { id: root.id, label: root.name };
  },
  removeRoot: async (id) => {
    await kvSet(
      ROOTS_KEY,
      (await stored()).filter((r) => r.id !== id),
    );
    for (const ref of [...files.keys()]) if (ref.startsWith(`web:${id}/`)) files.delete(ref);
  },
};
