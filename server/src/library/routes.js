// Server library routes: track list, Range streaming, cover art, rescan. Audio elements cannot send headers, so
// signed-in users get a streamKey (HMAC, 7 days) that stream/art URLs carry as ?k=.
import { createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { requireUser } from '../auth/session.js';
import { getUser } from '../auth/users.js';
import { deriveKey, safeEqual } from '../crypto.js';
import { HttpError } from '../errors.js';
import { scanLibrary } from './scan.js';

const KEY_DAYS = 7;
const ART_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export function makeStreamKey(secret, userId, now = Date.now()) {
  const exp = Math.floor(now / 1000) + KEY_DAYS * 86400;
  const payload = `${userId}.${exp}`;
  const mac = createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 32);
  return Buffer.from(`${payload}.${mac}`).toString('base64url');
}

export function checkStreamKey(secret, key) {
  try {
    const [userId, exp, mac] = Buffer.from(String(key), 'base64url').toString('utf8').split('.');
    if (!userId || !exp || !mac || Number(exp) * 1000 < Date.now()) return undefined;
    const want = createHmac('sha256', secret).update(`${userId}.${exp}`).digest('base64url').slice(0, 32);
    return safeEqual(mac, want) ? userId : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a single "bytes=a-b" range. Returns undefined for none, null for unsatisfiable. */
export function parseRange(header, size) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

const toApi = (r) => ({
  id: r.id,
  title: r.title,
  artist: r.artist,
  album: r.album,
  albumArtist: r.album_artist ?? undefined,
  year: r.year ?? undefined,
  genre: r.genre ?? undefined,
  durationMs: r.duration_ms,
  hasArt: Boolean(r.art_path),
});

export async function libraryRoutes(app) {
  const secret = deriveKey(app.config.secretKey, 'library-stream');
  let scanning;

  const rescan = () => {
    scanning ??= scanLibrary(app.db, { musicDir: app.config.musicDir, dataDir: app.config.dataDir, log: app.log }).finally(() => {
      scanning = undefined;
    });
    return scanning;
  };
  app.decorate('rescanLibrary', rescan);

  const libraryOn = () => {
    if (!app.config.musicDir) throw new HttpError(404, 'library_off', 'This server has no music library (MUSIC_DIR)');
  };
  const viewer = (req) => {
    if (req.user) return req.user;
    const userId = checkStreamKey(secret, req.query?.k);
    const user = userId && getUser(app.db, userId);
    if (!user) throw new HttpError(401, 'not_signed_in', 'Sign in first');
    return user;
  };
  const row = (id) => {
    const r = app.db.prepare('SELECT * FROM server_tracks WHERE id = ?').get(String(id));
    if (!r) throw new HttpError(404, 'not_found', 'No such track');
    const root = resolve(app.config.musicDir) + sep;
    if (!resolve(r.path).startsWith(root)) throw new HttpError(404, 'not_found', 'No such track');
    return r;
  };

  app.get('/api/library/tracks', async (req) => {
    libraryOn();
    const user = requireUser(req);
    const rows = app.db.prepare('SELECT * FROM server_tracks ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, path').all();
    return { tracks: rows.map(toApi), streamKey: makeStreamKey(secret, user.id), scanning: Boolean(scanning) };
  });

  app.post('/api/library/rescan', async (req) => {
    libraryOn();
    requireUser(req);
    const res = await rescan();
    return res;
  });

  app.get('/api/library/stream/:id', async (req, reply) => {
    libraryOn();
    viewer(req);
    const r = row(req.params.id);
    let st;
    try {
      st = await stat(r.path);
    } catch {
      throw new HttpError(404, 'not_found', 'The file is gone; rescan the library');
    }
    const size = st.size;
    const range = parseRange(req.headers.range, size);
    reply.header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=3600').type(r.mime ?? 'application/octet-stream');
    if (range === null) {
      return reply.status(416).header('content-range', `bytes */${size}`).send();
    }
    if (range) {
      reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1);
      return reply.send(createReadStream(r.path, { start: range.start, end: range.end }));
    }
    reply.header('content-length', size);
    return reply.send(createReadStream(r.path));
  });

  app.get('/api/library/art/:id', async (req, reply) => {
    libraryOn();
    viewer(req);
    const r = row(req.params.id);
    if (!r.art_path) throw new HttpError(404, 'not_found', 'No cover art');
    const type = ART_TYPES[extname(r.art_path).toLowerCase()] ?? 'image/jpeg';
    return reply.type(type).header('cache-control', 'private, max-age=86400').send(createReadStream(r.art_path));
  });

  if (app.config.musicDir && app.config.scanOnStart) {
    app.addHook('onReady', async () => {
      rescan()
        .then((r) => app.log.info(r, 'music library scanned'))
        .catch((err) => app.log.error(err, 'music library scan failed'));
    });
  }
}
