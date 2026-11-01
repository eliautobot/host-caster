// The desktop app (Windows, Mac, Linux; Electron, desktop/ in the repo). Its preload exposes window.hostcasterDesktop:
// the online server it uses, system browser, hostcaster:// links, window state, desktop settings, updates, and the
// LOCAL HELPER on 127.0.0.1 (per-launch secret) that runs "Use your ChatGPT plan" on this PC and carries 'device'
// brain and voice calls (no CORS, plain http on the home network). Undefined in the browser and the phone apps.

export interface DesktopWindowState {
  /** on screen: shown and not minimized */
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}

export interface DesktopSettings {
  chatgptPlan: boolean;
  checkUpdates: boolean;
  updateSnooze: { versionCode: number; until: number } | null;
  /** what keeps the ChatGPT sign-in safe on this computer; weak = Linux without a keyring */
  keychain: { available: boolean; backend: string; weak: boolean };
}

export interface DesktopUpdate {
  version: string;
  versionCode: number;
  notes: string[];
  released?: string;
  url: string;
  page?: string;
  size?: number;
  sha256?: string;
  /** the manifest key of the file for this computer (windows-x64, mac-universal, linux-x64-appimage...) */
  file?: string;
  required: boolean;
}

export interface DesktopUpdateCheck {
  checked: boolean;
  update?: DesktopUpdate;
  latest?: string;
  error?: string;
}

type Off = () => void;

export interface DesktopBridge {
  version: string;
  platform: 'win32' | 'darwin' | 'linux' | string;
  arch: string;
  /** the Host-Caster server this build uses until someone picks another one */
  defaultServer: string;
  site: string;
  helper: { url: string; token: string };
  openExternal(url: string): Promise<boolean>;
  launchLinks(): Promise<string[]>;
  onDeepLink(cb: (url: string) => void): Off;
  windowState(): Promise<DesktopWindowState>;
  onWindowState(cb: (s: DesktopWindowState) => void): Off;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<Omit<DesktopSettings, 'keychain'>>): Promise<DesktopSettings>;
  onSettings(cb: (s: DesktopSettings) => void): Off;
  checkForUpdate(): Promise<DesktopUpdateCheck>;
  lastUpdate(): Promise<DesktopUpdate | null>;
  snoozeUpdate(): Promise<void>;
  openUpdate(): Promise<boolean>;
  onUpdate(cb: (u: DesktopUpdate | null) => void): Off;
}

export const desktop: DesktopBridge | undefined =
  typeof window !== 'undefined' ? (window as unknown as { hostcasterDesktop?: DesktopBridge }).hostcasterDesktop : undefined;

/** Running in the desktop app. */
export const isDesktop: boolean = Boolean(desktop);

/** Human name of this computer's system, for text like "Host-Caster for Windows". */
export function desktopOsName(platform = desktop?.platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Mac' : platform === 'linux' ? 'Linux' : 'desktop';
}

const HELPER_HEADER = 'x-hc-helper';

/** A request to the local helper (its own routes: /api/chatgpt/*, /api/ai/*, /health). */
export function helperFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!desktop) return Promise.reject(new Error('Not in the desktop app'));
  const headers = new Headers(init.headers);
  headers.set(HELPER_HEADER, desktop.helper.token);
  return fetch(`${desktop.helper.url}${path}`, { ...init, headers, credentials: 'omit' });
}

/** True for an address the page cannot call itself (another origin over http(s)). */
function isRemoteHttp(url: string): boolean {
  if (!/^https?:/i.test(url)) return false;
  try {
    return new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

/** The helper's own failure (the provider was not reached), not an answer from the provider. */
export const PROXY_ERROR_HEADER = 'x-hc-proxy-error';

/**
 * fetch() for brains and voices on the 'device' transport: in the desktop app the call leaves from this PC through
 * the helper (like the phone apps' native HTTP), so LAN and localhost models work and no CORS is needed.
 */
export function desktopFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  if (!desktop || !isRemoteHttp(url)) return fetch(input, init);
  return helperFetch(`/proxy?url=${encodeURIComponent(url)}`, init);
}
