// The desktop app: music folders on the computer (the system Music folder first). The main process lists the files
// (main/deviceMusic.js) and serves them at app://host-caster/_device/<folder>/<path> with byte ranges; tags come from
// the first megabyte of each new or changed file.
import { desktop, type DesktopMusicFile, type DesktopMusicFolder } from '../../native/desktop';
import { readSongMetaFromHead } from '../metadata';
import { extOf } from '../text';
import type { DeviceRoot, DeviceScanner, DeviceSong } from './types';

const HEAD_BYTES = 1024 * 1024;
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  wave: 'audio/wav',
  webm: 'audio/webm',
  weba: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
};

const music = () => {
  const m = desktop?.music;
  if (!m) throw new Error('This version of the desktop app cannot open music folders');
  return m;
};

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const root = (f: DesktopMusicFolder): DeviceRoot => ({ id: f.id, label: f.path });

/** 'desktop:<folder id>/<rel>' -> the file's address in the app */
function urlOf(ref: string): string {
  const rest = ref.slice('desktop:'.length);
  const slash = rest.indexOf('/');
  const id = rest.slice(0, slash);
  const rel = rest.slice(slash + 1);
  return `${location.origin}/_device/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function fromDesktop(f: DesktopMusicFile, folders: Map<string, string>): DeviceSong {
  const top = baseName(folders.get(f.folder) ?? f.folder);
  const parts = f.rel.split('/');
  const name = parts.pop() ?? f.rel;
  const dir = parts.join('/');
  const folder = dir ? `${top}/${dir}` : top;
  return {
    ref: `desktop:${f.folder}/${f.rel}`,
    folder,
    name,
    path: `${folder}/${name}`,
    size: f.size,
    mime: MIME[extOf(name)] ?? 'audio/mpeg',
    modifiedAt: f.modifiedAt,
    durationMs: 0,
    kind: 'music',
    needsTags: true,
  };
}

export const desktopScanner: DeviceScanner = {
  platform: 'desktop',
  access: async () => ((await music().folders()).length ? 'granted' : 'prompt'),
  requestAccess: async () => ((await music().folders()).length ? 'granted' : 'prompt'),
  scan: async () => {
    const m = music();
    const folders = new Map((await m.folders()).map((f) => [f.id, f.path]));
    return (await m.scan()).map((f) => fromDesktop(f, folders));
  },
  readTags: async (song) => {
    const url = urlOf(song.ref);
    const res = await fetch(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
    if (!res.ok) throw new Error(`${song.name} could not be read`);
    const head = new Uint8Array(await res.arrayBuffer());
    const meta = await readSongMetaFromHead(head, song, url);
    const { picture, ...tags } = meta;
    return { ...song, ...tags, needsTags: false, picture };
  },
  url: async (ref) => urlOf(ref),
  roots: async () => (await music().folders()).map(root),
  addRoot: async (path) => {
    const f = await music().addFolder(path);
    return f ? root(f) : undefined;
  },
  removeRoot: (id) => music().removeFolder(id),
  suggestedRoot: async () => (await music().suggested()) ?? undefined,
};
