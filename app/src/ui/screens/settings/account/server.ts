// Which Host-Caster server this device talks to (settings.serverUrl). '' on web = the server that served the app.
import { api, auth, sync } from '@/core/api';
import { saveSettings } from '@/core/db';
import { desktop, isNative } from '@/core/native';
import type { ServerConfig } from '@/core/types';

/**
 * The server the phone apps use until someone picks another one: the hosted service, or VITE_HOSTCASTER_SERVER at
 * build time (empty = no default, the app asks for an address).
 */
export const DEFAULT_NATIVE_SERVER = (import.meta.env.VITE_HOSTCASTER_SERVER ?? 'https://app.host-caster.com').trim();

/**
 * Where this device talks to when no server was picked: the default on the phone apps, the one the desktop app was
 * built for (the hosted service unless its build says otherwise), the page's own server on web.
 */
export const defaultServerUrl = (): string => (desktop ? desktop.defaultServer : isNative ? DEFAULT_NATIVE_SERVER : '');

/** A host on this device, a home or private network, or a tailnet (where plain http is acceptable). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) return h === '::1' || /^f[cd]/.test(h) || h.startsWith('fe80:');
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return h === 'localhost' || !h.includes('.') || /\.(local|lan|home\.arpa|internal|ts\.net)$/.test(h);
}

/**
 * "radio.example.com" -> "https://radio.example.com"; strips paths after the host part's last slash. Plain http only
 * for a server on a private network: over the internet the sign-in token and keys could be read on the way.
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${/^(localhost|127\.|10\.|192\.168\.|\d+\.\d+\.\d+\.\d+)/.test(raw) ? 'http' : 'https'}://${raw}`;
  const u = new URL(withScheme);
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) {
    throw new Error('Use https:// for a server on the internet. Plain http:// is only for a server on your own network.');
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** Shown address of the current server. */
export function serverLabel(): string {
  if (api.baseUrl) return api.baseUrl.replace(/^https?:\/\//, '');
  return typeof location !== 'undefined' ? location.host : '';
}

/** Points the app at another server (signs out of the old one). Returns its config, or undefined if unreachable. */
export async function setServerUrl(input: string): Promise<ServerConfig | undefined> {
  // an empty address goes back to the default (the phone apps' hosted server)
  const url = normalizeServerUrl(input) || defaultServerUrl();
  if (url === api.baseUrl) return api.probe();
  if (api.session) {
    await sync.stop();
    await auth.signOut();
  }
  api.configure({ baseUrl: url });
  await saveSettings({ serverUrl: url || undefined });
  return api.probe();
}

/** Native apps need a server address; the web app defaults to its own origin. */
export const needsServerUrl = (): boolean => isNative && !api.baseUrl;
