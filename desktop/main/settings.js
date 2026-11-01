// Desktop-only settings (a small JSON file in the app's data folder). Everything else (hosts, stations, the account)
// lives in the app itself and syncs with the account.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  /**
   * "Use your ChatGPT plan" on this PC. Off until the person turns it on: OpenAI's terms leave open whether an app from a
   * company that also sells a hosted service may offer it without OpenAI's approval (docs/DESKTOP.md).
   */
  chatgptPlan: false,
  /** look for a newer version on host-caster.com (at launch and every 6 hours) */
  checkUpdates: true,
  /** "Later" on an update: { versionCode, until } */
  updateSnooze: null,
});

const VALID = {
  chatgptPlan: (v) => typeof v === 'boolean',
  checkUpdates: (v) => typeof v === 'boolean',
  updateSnooze: (v) => v === null || (typeof v === 'object' && Number.isInteger(v.versionCode) && Number.isFinite(v.until)),
};

export function createSettings(file) {
  let current = { ...DEFAULT_SETTINGS };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const [k, ok] of Object.entries(VALID)) if (k in saved && ok(saved[k])) current[k] = saved[k];
  } catch {
    // first launch or an unreadable file: defaults
  }
  const listeners = new Set();
  return {
    get: () => ({ ...current }),
    /** Applies the known, valid keys of `patch`; returns the new settings. */
    set(patch) {
      const next = { ...current };
      for (const [k, v] of Object.entries(patch ?? {})) if (VALID[k]?.(v)) next[k] = v;
      current = next;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
      for (const cb of listeners) cb({ ...current });
      return { ...current };
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
