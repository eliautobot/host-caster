// Music folders on the computer ("Add a music folder", the app's src/core/library/device/desktop.ts). The person picks
// the folders (the system Music folder is suggested); the app lists the song files in them and plays them from where
// they are at app://host-caster/_device/<folder id>/<path>, with byte ranges for seeking. Only files with a song
// extension inside a picked folder are ever served. No Electron imports (unit tested with node --test).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.caf': 'audio/x-caf',
};
export const DEVICE_PREFIX = '/_device/';
const MAX_FILES = 50_000;
const MAX_DEPTH = 12;

export const folderId = (path) => createHash('sha256').update(resolve(path)).digest('hex').slice(0, 12);
const isAudio = (name) => Object.hasOwn(AUDIO_MIME, extname(name).toLowerCase());
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Song files under `root` (no hidden folders, no links followed): [{ rel ('/' separated), size, modifiedAt }]. */
export async function walk(root, { maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  const out = [];
  const visit = async (dir, rel, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // no access to this folder: skip it
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.')) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth) await visit(join(dir, e.name), path, depth + 1);
      } else if (e.isFile() && isAudio(e.name)) {
        const info = await stat(join(dir, e.name)).catch(() => undefined);
        if (info) out.push({ rel: path, size: info.size, modifiedAt: Math.round(info.mtimeMs) });
      }
    }
  };
  await visit(root, '', 0);
  return out;
}

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" -> { start, end }; null = whole file; 'invalid' = outside the file (416) */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** A song file as an HTTP response, with byte ranges (seeking). */
export async function serveFile(request, file) {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return new Response('Not found', { status: 404 });
  const size = info.size;
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = {
    'content-type': AUDIO_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status: range ? 206 : 200, headers });
  const body = Readable.toWeb(createReadStream(file, { start, end }));
  return new Response(body, { status: range ? 206 : 200, headers });
}

/**
 * The music folders, kept in `file` (JSON). `pickFolder()` opens the system folder picker (null = cancelled);
 * `musicDir()` is the system Music folder.
 */
export function createDeviceMusic(file, { pickFolder, musicDir }) {
  let folders;
  const load = async () => {
    if (folders) return folders;
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      folders = Array.isArray(saved.folders) ? saved.folders.filter((f) => typeof f?.path === 'string').map((f) => ({ id: folderId(f.path), path: f.path })) : [];
    } catch {
      folders = [];
    }
    return folders;
  };
  const save = async () => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ folders: folders.map(({ path }) => ({ path })) }, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  };
  const suggested = async () => {
    const dir = musicDir();
    if (!dir || !isDir(dir)) return null;
    return (await load()).some((f) => f.id === folderId(dir)) ? null : dir;
  };

  return {
    folders: async () => (await load()).map((f) => ({ ...f })),
    suggested,
    /** `path` is accepted only when it is the suggested Music folder; anything else goes through the picker */
    async addFolder(path) {
      const suggestion = await suggested();
      const chosen = path && suggestion && resolve(path) === resolve(suggestion) ? suggestion : await pickFolder();
      if (!chosen || !isDir(chosen)) return null;
      const list = await load();
      const id = folderId(chosen);
      const have = list.find((f) => f.id === id);
      if (have) return { ...have };
      const f = { id, path: resolve(chosen) };
      list.push(f);
      await save();
      return { ...f };
    },
    async removeFolder(id) {
      const list = await load();
      folders = list.filter((f) => f.id !== id);
      await save();
    },
    /** every song file in every folder: [{ folder (id), rel, size, modifiedAt }]; a folder that is not there is skipped */
    async scan() {
      const out = [];
      for (const f of await load()) {
        if (!existsSync(f.path)) continue;
        for (const s of await walk(f.path)) out.push({ folder: f.id, ...s });
      }
      return out;
    },
    /** app://host-caster/_device/<id>/<rel>: `path` is the decoded URL path */
    async serve(request, path) {
      const rest = path.slice(DEVICE_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash < 1) return new Response('Not found', { status: 404 });
      const root = (await load()).find((f) => f.id === rest.slice(0, slash));
      const rel = rest.slice(slash + 1);
      if (!root || !rel || !isAudio(rel)) return new Response('Not found', { status: 404 });
      const base = normalize(root.path);
      const target = normalize(join(base, ...rel.split('/')));
      if (!target.startsWith(base.endsWith(sep) ? base : base + sep)) return new Response('Not found', { status: 404 });
      if (rel.split('/').some((part) => part.startsWith('.'))) return new Response('Not found', { status: 404 });
      return serveFile(request, target);
    },
  };
}
