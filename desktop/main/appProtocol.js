// The app's own pages: the web app (built with Vite) is bundled inside the desktop app and served from app://host-caster
// (a privileged, secure, standard scheme: a stable origin for IndexedDB, Media Session, fetch and CORS). Nothing
// outside the bundled folder can be read, and unknown paths fall back to index.html (Spotify's /spotify/callback).
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { protocol } from 'electron';
import { contentSecurityPolicy } from './csp.js';

export const APP_SCHEME = 'app';
export const APP_HOST = 'host-caster';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Must run before the app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
  ]);
}

/** Serves `appDir` on app://host-caster. */
export function handleAppProtocol(appDir) {
  const root = normalize(appDir);
  const index = join(root, 'index.html');
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) return new Response('Not found', { status: 404 });
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) file = index;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const body = await readFile(file).catch(() => undefined);
    if (!body) return new Response('Not found', { status: 404 });
    const headers = { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
    if (file === index) headers['content-security-policy'] = contentSecurityPolicy(body.toString('utf8'));
    return new Response(body, { status: 200, headers });
  });
}
