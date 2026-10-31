// Subsonic auth (API 1.13+): token = md5(password + salt). Falls back to the hex-encoded password for servers
// that cannot do token auth (LDAP users, some Jellyfin/Ampache setups: error 41/42).
import { md5 } from './md5';

export const SUBSONIC_API_VERSION = '1.16.1';
export const SUBSONIC_CLIENT = 'Host-Caster';

/** What we keep on the device. Never the plain password. */
export type SubsonicAuth =
  | { kind: 'token'; username: string; salt: string; token: string }
  | { kind: 'password'; username: string; /** 'enc:' + hex(utf8(password)) */ encPassword: string }
  | { kind: 'apiKey'; apiKey: string };

/** Random salt, at least 6 chars (the spec minimum); hex from crypto.getRandomValues. */
export function makeSalt(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function tokenFor(password: string, salt: string): string {
  return md5(password + salt);
}

export function tokenAuth(username: string, password: string, salt = makeSalt()): SubsonicAuth {
  return { kind: 'token', username, salt, token: tokenFor(password, salt) };
}

export function encodePassword(password: string): string {
  const hex = Array.from(new TextEncoder().encode(password), (b) => b.toString(16).padStart(2, '0')).join('');
  return `enc:${hex}`;
}

export function passwordAuth(username: string, password: string): SubsonicAuth {
  return { kind: 'password', username, encPassword: encodePassword(password) };
}

/** Query params every Subsonic call carries. */
export function authParams(auth: SubsonicAuth): Record<string, string> {
  const base = { v: SUBSONIC_API_VERSION, c: SUBSONIC_CLIENT };
  switch (auth.kind) {
    case 'token':
      return { ...base, u: auth.username, t: auth.token, s: auth.salt };
    case 'password':
      return { ...base, u: auth.username, p: auth.encPassword };
    case 'apiKey':
      return { ...base, apiKey: auth.apiKey };
  }
}

/**
 * Cleans what people paste: adds a scheme (http for LAN/localhost/IPs, https otherwise), drops trailing slashes,
 * a trailing /rest, and web UI paths such as /app/#/album/... (Navidrome) or /web/index.html (Jellyfin).
 */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Enter your server address');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/:]/)[0] ?? '';
    const local =
      host === 'localhost' ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.lan') ||
      !host.includes('.');
    s = `${local ? 'http' : 'https'}://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That does not look like a server address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Use an http:// or https:// address');
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(app|web)(\/.*)?$/i, '').replace(/\/rest(\/.*)?$/i, '').replace(/\/index\.html$/i, '');
  return `${u.protocol}//${u.host}${path}`;
}
