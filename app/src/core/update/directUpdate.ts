// "A new version is ready" for the Android APK downloaded from the website (direct distribution only; Google Play
// updates its own builds). The website publishes a small manifest next to the APK:
//   <site>/download/android/latest.json
//   { "version": "0.1.1", "versionCode": 10100, "url": "https://.../host-caster-0.1.1.apk", "sha256": "<64 hex>",
//     "size": 5000000, "released": "2026-11-02", "notes": ["..."], "minimumSupported": 10000, "page": "https://..." }
// The app compares versionCode with its own, and the notice opens `url` in the browser: Android's own installer
// does the update (the app never installs anything itself and has no REQUEST_INSTALL_PACKAGES permission).
import { kvGet, kvSet } from '../db/kv';

const SITE = (import.meta.env.VITE_HOSTCASTER_SITE ?? 'https://host-caster.com').trim().replace(/\/+$/, '');

/** Where a direct build looks for a newer version. VITE_HOSTCASTER_UPDATE_URL overrides it (tests, other sites). */
export const UPDATE_MANIFEST_URL = (import.meta.env.VITE_HOSTCASTER_UPDATE_URL ?? `${SITE}/download/android/latest.json`).trim();

/** How often the app asks (at launch and when it comes back to the screen). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** "Later" hides an optional update for this long. */
export const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const STATE_KEY = 'update:direct';
const MAX_NOTES = 5;

export interface ReleaseManifest {
  version: string;
  versionCode: number;
  url: string;
  sha256: string;
  size?: number;
  released?: string;
  notes: string[];
  /** Installed versionCodes below this are no longer supported: the notice cannot be put off. */
  minimumSupported: number;
  /** The download page with the install guide, when the manifest names one. */
  page?: string;
}

export interface UpdateState {
  lastCheck?: number;
  /** The manifest from the last successful check, so a launch between checks still shows the notice. */
  release?: ReleaseManifest;
  /** The manifest URL it came from: a cached release from another address (another build) is ignored. */
  source?: string;
  /** "Later" on this versionCode until this time. */
  snoozed?: { versionCode: number; until: number };
}

export type UpdateDecision = { kind: 'none' } | { kind: 'available' | 'required'; release: ReleaseManifest };

const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** Downloads come over https; plain http only from this device (a test server through adb reverse). */
export function isDownloadUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Strict reading of latest.json: anything unexpected means "no update" rather than a broken notice. */
export function parseManifest(raw: unknown): ReleaseManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+([.+-][\w.]+)?$/.test(m.version) || m.version.length > 40) return null;
  if (!isPositiveInt(m.versionCode)) return null;
  if (!isDownloadUrl(m.url)) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return null;
  const notesIn = typeof m.notes === 'string' ? [m.notes] : Array.isArray(m.notes) ? m.notes : [];
  const notes = notesIn
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_NOTES);
  return {
    version: m.version,
    versionCode: m.versionCode,
    url: m.url,
    sha256: m.sha256.toLowerCase(),
    size: isPositiveInt(m.size) ? m.size : undefined,
    released: typeof m.released === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.released) ? m.released : undefined,
    notes,
    minimumSupported: isPositiveInt(m.minimumSupported) ? m.minimumSupported : 0,
    page: isDownloadUrl(m.page) ? m.page : undefined,
  };
}

/** What to show for this release, given the installed versionCode and the saved "Later". */
export function decide(release: ReleaseManifest | null, installedCode: number, state: UpdateState, now: number): UpdateDecision {
  if (!release || !isPositiveInt(installedCode) || release.versionCode <= installedCode) return { kind: 'none' };
  if (installedCode < release.minimumSupported) return { kind: 'required', release };
  const s = state.snoozed;
  if (s && s.versionCode >= release.versionCode && s.until > now) return { kind: 'none' };
  return { kind: 'available', release };
}

/** True when the last check is old enough to ask the website again. */
export function isDue(state: UpdateState, now: number): boolean {
  return !state.lastCheck || now - state.lastCheck >= CHECK_EVERY_MS || state.lastCheck > now;
}

async function readState(): Promise<UpdateState> {
  const rec = await kvGet<UpdateState>(STATE_KEY).catch(() => undefined);
  return rec?.value && typeof rec.value === 'object' ? rec.value : {};
}

/** The parsed manifest; null when the site has none (404, 410); throws when the check itself failed. */
async function fetchManifest(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: ctrl.signal }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs + 500)),
    ]);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the website (at most every CHECK_EVERY_MS unless force) and decides. Quiet on problems: a failed check (offline,
 * timeout, server error) keeps the last good manifest for the next launch; "no manifest" (404) or a malformed one
 * clears it. fetchJson returns the parsed JSON, or null when the site has no manifest, and throws when it failed.
 */
export async function checkForUpdate(opts: {
  installedCode: number;
  force?: boolean;
  now?: number;
  url?: string;
  fetchJson?: (url: string) => Promise<unknown>;
}): Promise<UpdateDecision> {
  const now = opts.now ?? Date.now();
  const url = opts.url ?? UPDATE_MANIFEST_URL;
  const state = await readState();
  const cached = state.source === url ? parseManifest(state.release) : null;
  if (!opts.force && !isDue(state, now) && state.source === url) return decide(cached, opts.installedCode, state, now);
  let release: ReleaseManifest | null;
  try {
    release = parseManifest(await (opts.fetchJson ?? ((u) => fetchManifest(u, 10_000)))(url));
  } catch {
    release = cached;
  }
  const next: UpdateState = { ...state, lastCheck: now, source: url, release: release ?? undefined };
  await kvSet<UpdateState>(STATE_KEY, next).catch(() => undefined);
  return decide(release, opts.installedCode, state, now);
}

/** "Later": hide this optional update for SNOOZE_MS (a required one comes back at the next launch). */
export async function snoozeUpdate(versionCode: number, now = Date.now()): Promise<void> {
  const state = await readState();
  await kvSet<UpdateState>(STATE_KEY, { ...state, snoozed: { versionCode, until: now + SNOOZE_MS } });
}
