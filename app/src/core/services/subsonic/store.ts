// Subsonic connection: one server per device. settings.connections.subsonic holds { url, username } (synced);
// kv 'subsonic:auth' holds salt + token (device only, never the plain password).
import { getSettings, kvDelete, kvGet, kvSet, saveSettings } from '../../db';
import { isNative } from '../../native';
import { passwordAuth, tokenAuth, normalizeServerUrl, type SubsonicAuth } from './auth';
import { SUBSONIC_ERR, SubsonicClient, SubsonicError } from './client';
import type { SubsonicServerInfo } from './types';

const AUTH_KEY = 'subsonic:auth';
const INFO_KEY = 'subsonic:server';

interface StoredAuth {
  url: string;
  auth: SubsonicAuth;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let cached: SubsonicClient | undefined;
let fetchOverride: FetchLike | undefined;

/** Tests (and native CapacitorHttp later) can swap the fetch used by new clients. */
export function setSubsonicFetch(fn: FetchLike | undefined): void {
  fetchOverride = fn;
  cached = undefined;
}

export interface SubsonicConnectInput {
  url: string;
  username: string;
  password?: string;
  /** OpenSubsonic API key (Navidrome 0.56+ and others); replaces username + password */
  apiKey?: string;
}

export interface SubsonicStatus {
  connected: boolean;
  url?: string;
  username?: string;
  server?: SubsonicServerInfo;
}

function mixedContentProblem(url: string): string | undefined {
  if (isNative || typeof location === 'undefined') return undefined;
  if (location.protocol === 'https:' && url.startsWith('http:') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url)) {
    return 'This page is served over https, so the browser blocks an http server. Give your server an https address, or use the Android app.';
  }
  return undefined;
}

/** Signs in (ping), then saves the connection. Throws SubsonicError / Error with a message for the user. */
export async function connectSubsonic(input: SubsonicConnectInput): Promise<SubsonicServerInfo> {
  const url = normalizeServerUrl(input.url);
  const mixed = mixedContentProblem(url);
  if (mixed) throw new Error(mixed);
  const username = input.username.trim();
  const apiKey = input.apiKey?.trim();
  if (!apiKey && (!username || !input.password)) throw new Error('Enter your username and password');

  let auth: SubsonicAuth = apiKey ? { kind: 'apiKey', apiKey } : tokenAuth(username, input.password!);
  let client = new SubsonicClient(url, auth, fetchOverride);
  let info: SubsonicServerInfo;
  try {
    info = await client.ping();
  } catch (err) {
    const legacy =
      err instanceof SubsonicError &&
      (err.code === SUBSONIC_ERR.tokenNotSupported || err.code === SUBSONIC_ERR.authMechanismNotSupported);
    if (!legacy || apiKey) throw err;
    // LDAP users / some servers: fall back to the hex-encoded password.
    auth = passwordAuth(username, input.password!);
    client = new SubsonicClient(url, auth, fetchOverride);
    info = await client.ping();
  }

  await kvSet<StoredAuth>(AUTH_KEY, { url, auth });
  await kvSet(INFO_KEY, info);
  const settings = await getSettings();
  await saveSettings({
    connections: { ...settings.connections, subsonic: { url, username: apiKey ? username || 'API key' : username } },
  });
  cached = client;
  return info;
}

export async function disconnectSubsonic(): Promise<void> {
  cached = undefined;
  await kvDelete(AUTH_KEY);
  await kvDelete(INFO_KEY);
  const settings = await getSettings();
  const { subsonic: _drop, ...rest } = settings.connections;
  await saveSettings({ connections: rest });
}

/** The signed-in client, or undefined when no server is connected on this device. */
export async function getSubsonicClient(): Promise<SubsonicClient | undefined> {
  if (cached) return cached;
  const stored = await kvGet<StoredAuth>(AUTH_KEY);
  if (!stored) return undefined;
  cached = new SubsonicClient(stored.value.url, stored.value.auth, fetchOverride);
  return cached;
}

export async function requireSubsonicClient(): Promise<SubsonicClient> {
  const c = await getSubsonicClient();
  if (!c) throw new Error('Connect your music server in Settings > Music services first');
  return c;
}

export async function subsonicStatus(): Promise<SubsonicStatus> {
  const [stored, info, settings] = await Promise.all([
    kvGet<StoredAuth>(AUTH_KEY),
    kvGet<SubsonicServerInfo>(INFO_KEY),
    getSettings(),
  ]);
  const conn = settings.connections.subsonic;
  return {
    connected: Boolean(stored),
    url: stored?.value.url ?? conn?.url,
    username: conn?.username,
    server: info?.value,
  };
}

/** Playable URL for a subsonic track ref (used by core/services/resolve.ts). */
export async function subsonicStreamUrl(id: string): Promise<string> {
  return (await requireSubsonicClient()).streamUrl(id);
}
