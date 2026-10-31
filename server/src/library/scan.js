// Server music library: scans MUSIC_DIR with music-metadata into server_tracks; embedded art goes to DATA_DIR/art.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseFile } from 'music-metadata';

export const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};
const COVER_NAMES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'album.jpg', 'cover.jpeg', 'Cover.jpg', 'Folder.jpg'];
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

export const trackId = (relPath) => createHash('sha256').update(relPath.split(sep).join('/')).digest('base64url').slice(0, 22);

async function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile() && AUDIO_TYPES[extname(e.name).toLowerCase()]) yield full;
  }
}

function folderCover(file) {
  const dir = dirname(file);
  for (const name of COVER_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const firstNum = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);

/** Scans the library; unchanged files (same size + mtime) are skipped, missing ones removed. */
export async function scanLibrary(db, { musicDir, dataDir, log }) {
  const root = resolve(musicDir);
  const artDir = join(dataDir, 'art');
  mkdirSync(artDir, { recursive: true });
  const known = new Map(db.prepare('SELECT id, path, size, mtime FROM server_tracks').all().map((r) => [r.path, r]));
  const seen = new Set();
  const upsert = db.prepare(`
    INSERT INTO server_tracks (id, path, title, artist, album, album_artist, year, genre, duration_ms, mime, size, mtime, art_path, added_at, updated_at)
    VALUES (@id, @path, @title, @artist, @album, @album_artist, @year, @genre, @duration_ms, @mime, @size, @mtime, @art_path, @t, @t)
    ON CONFLICT (path) DO UPDATE SET title = excluded.title, artist = excluded.artist, album = excluded.album,
      album_artist = excluded.album_artist, year = excluded.year, genre = excluded.genre, duration_ms = excluded.duration_ms,
      mime = excluded.mime, size = excluded.size, mtime = excluded.mtime, art_path = excluded.art_path, updated_at = excluded.updated_at`);
  let added = 0;
  let failed = 0;

  for await (const file of walk(root)) {
    seen.add(file);
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    const prev = known.get(file);
    const mtime = Math.round(st.mtimeMs);
    if (prev && prev.size === st.size && prev.mtime === mtime) continue;
    const rel = relative(root, file);
    const id = trackId(rel);
    const ext = extname(file).toLowerCase();
    let meta;
    try {
      meta = await parseFile(file, { duration: false, skipPostHeaders: true });
    } catch (err) {
      failed++;
      log?.warn?.({ file: rel, err: err.message }, 'music-metadata could not read a file');
      meta = { common: {}, format: {} };
    }
    const c = meta.common ?? {};
    let artPath = null;
    const pic = c.picture?.[0];
    if (pic?.data?.length) {
      artPath = join(artDir, `${id}${IMAGE_EXT[pic.format] ?? '.jpg'}`);
      await writeFile(artPath, pic.data).catch(() => {
        artPath = null;
      });
    }
    artPath ??= folderCover(file);
    upsert.run({
      id,
      path: file,
      title: c.title?.trim() || basename(file, ext).replace(/^\d+[\s.-]+/, ''),
      artist: c.artist?.trim() || c.albumartist?.trim() || '',
      album: c.album?.trim() || '',
      album_artist: c.albumartist?.trim() || null,
      year: firstNum(c.year),
      genre: c.genre?.[0] ?? null,
      duration_ms: Math.round((meta.format?.duration ?? 0) * 1000),
      mime: AUDIO_TYPES[ext],
      size: st.size,
      mtime,
      art_path: artPath,
      t: Date.now(),
    });
    added++;
  }
  const gone = [...known.keys()].filter((p) => !seen.has(p));
  const del = db.prepare('DELETE FROM server_tracks WHERE path = ?');
  for (const p of gone) del.run(p);
  const total = db.prepare('SELECT COUNT(*) AS n FROM server_tracks').get().n;
  return { count: total, changed: added, removed: gone.length, failed };
}
