// "A new version is ready": the desktop app reads a small manifest on host-caster.com (like the Android direct
// download) and offers the download in the browser. It never installs anything by itself.
//   <site>/download/desktop/latest.json
//   { "version": "0.1.1", "versionCode": 10100, "released": "2026-11-02", "notes": ["..."], "minimumSupported": 10000,
//     "page": "https://host-caster.com/download#desktop",
//     "files": { "windows-x64": { "url", "sha256", "size" }, "mac-universal": {...}, "linux-x64-appimage": {...},
//                "linux-x64-deb": {...} } }
// Later, signed builds can switch to electron-updater with GitHub Releases (autoUpdaterHook below).

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_NOTES = 5;

/** Same scheme as the Android builds: MAJOR*1e6 + MINOR*1e4 + PATCH*100 + BUILD. */
export function versionCode(version, build = 0) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return 0;
  return Number(m[1]) * 1e6 + Number(m[2]) * 1e4 + Number(m[3]) * 100 + build;
}

/** Downloads come over https; plain http only from this computer (tests). */
export function isDownloadUrl(url) {
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

/** The manifest keys to try for this computer, best first. */
export function platformKeys(platform = process.platform, arch = process.arch, env = process.env) {
  if (platform === 'win32') return [`windows-${arch}`, 'windows-x64'];
  if (platform === 'darwin') return [`mac-${arch}`, 'mac-universal'];
  // an AppImage updates with an AppImage; a .deb install with a .deb
  const kinds = env.APPIMAGE ? ['appimage', 'deb'] : ['deb', 'appimage'];
  return kinds.map((k) => `linux-${arch}-${k}`);
}

/** Checks and trims a manifest; undefined when it is not one. */
export function parseManifest(json) {
  if (!json || typeof json !== 'object') return undefined;
  const { version, versionCode: code, minimumSupported } = json;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version) || !Number.isInteger(code) || code <= 0) return undefined;
  const files = {};
  for (const [k, f] of Object.entries(json.files && typeof json.files === 'object' ? json.files : {})) {
    if (!/^[a-z0-9-]{3,40}$/.test(k) || !isDownloadUrl(f?.url)) continue;
    files[k] = {
      url: f.url,
      ...(typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(f.sha256) ? { sha256: f.sha256.toLowerCase() } : {}),
      ...(Number.isInteger(f.size) && f.size > 0 ? { size: f.size } : {}),
    };
  }
  return {
    version,
    versionCode: code,
    minimumSupported: Number.isInteger(minimumSupported) ? minimumSupported : 0,
    notes: (Array.isArray(json.notes) ? json.notes : []).filter((n) => typeof n === 'string').slice(0, MAX_NOTES).map((n) => n.slice(0, 300)),
    ...(typeof json.released === 'string' ? { released: json.released.slice(0, 40) } : {}),
    ...(isDownloadUrl(json.page) ? { page: json.page } : {}),
    files,
  };
}

/**
 * What to tell the person: nothing, an update (with the file for this computer, else the download page) or a
 * required one (this version is below minimumSupported: "Later" is not offered).
 */
export function decide(manifest, current, { keys = platformKeys(), snooze, now = Date.now() } = {}) {
  if (!manifest || manifest.versionCode <= current) return undefined;
  const key = keys.find((k) => manifest.files[k]);
  const file = key ? manifest.files[key] : undefined;
  const url = file?.url ?? manifest.page;
  if (!url) return undefined;
  const required = current < manifest.minimumSupported;
  if (!required && snooze && snooze.versionCode === manifest.versionCode && snooze.until > now) return undefined;
  return {
    version: manifest.version,
    versionCode: manifest.versionCode,
    notes: manifest.notes,
    released: manifest.released,
    url,
    page: manifest.page,
    ...(file?.size ? { size: file.size } : {}),
    ...(file?.sha256 ? { sha256: file.sha256 } : {}),
    file: key,
    required,
  };
}

/**
 * @param {{ manifestUrl: string, version: string, fetch: typeof fetch, settings: { get: Function, set: Function },
 *   onUpdate: (update: object | undefined) => void, log?: { warn: Function } }} opts
 */
export function createUpdates(opts) {
  const current = versionCode(opts.version);
  let timer;
  let last;

  async function check({ manual = false } = {}) {
    if (!manual && !opts.settings.get().checkUpdates) return undefined;
    try {
      const res = await opts.fetch(opts.manifestUrl, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = parseManifest(await res.json());
      if (!manifest) throw new Error('not a release manifest');
      // asking by hand shows an update even when it was put off
      last = decide(manifest, current, { snooze: manual ? undefined : opts.settings.get().updateSnooze });
      opts.onUpdate(last);
      return { checked: true, update: last, latest: manifest.version };
    } catch (err) {
      opts.log?.warn(`update check failed: ${err?.message ?? err}`);
      return { checked: false, error: 'Could not check for updates right now.' };
    }
  }

  return {
    check,
    get last() {
      return last;
    },
    /** "Later": hide this version for 3 days (a required update cannot be put off). */
    snooze() {
      if (!last || last.required) return;
      opts.settings.set({ updateSnooze: { versionCode: last.versionCode, until: Date.now() + SNOOZE_MS } });
      last = undefined;
      opts.onUpdate(undefined);
    },
    start(firstDelayMs = 8000) {
      clearTimeout(timer);
      const loop = async () => {
        await check();
        timer = setTimeout(loop, CHECK_EVERY_MS);
        timer.unref?.();
      };
      timer = setTimeout(loop, firstDelayMs);
      timer.unref?.();
    },
    stop: () => clearTimeout(timer),
  };
}

/**
 * Hook for signed builds later: with HOSTCASTER_AUTO_UPDATE=github and electron-updater installed, updates come from
 * GitHub Releases (electron-builder's publish config) instead of the manifest notice. Unsigned builds keep the notice:
 * macOS refuses to auto-update an unsigned app, and Windows would warn on every update.
 */
export async function autoUpdaterHook(log) {
  if (process.env.HOSTCASTER_AUTO_UPDATE !== 'github') return false;
  try {
    const pkg = 'electron-updater';
    const { autoUpdater } = await import(pkg);
    autoUpdater.autoDownload = false;
    await autoUpdater.checkForUpdatesAndNotify();
    return true;
  } catch (err) {
    log?.warn(`electron-updater not available: ${err?.message ?? err}`);
    return false;
  }
}
