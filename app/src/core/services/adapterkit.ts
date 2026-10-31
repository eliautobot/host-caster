// Small helpers shared by the service PlayerAdapters (owner: services builder).
import type { AdapterEvents } from '../types';
import { createEmitter, type Emitter } from '../util/emitter';

export function adapterEmitter(): Emitter<AdapterEvents> {
  return createEmitter<AdapterEvents>();
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/**
 * Fades a volume from `from` to `to` over `ms` with `steps` calls to `set`. Returns a cancel function.
 * Used by adapters whose audio is outside Web Audio (YouTube iframe, Spotify SDK / Connect).
 */
export function rampSteps(
  from: number,
  to: number,
  ms: number,
  set: (v: number) => void,
  steps = Math.max(1, Math.round(ms / 50)),
): () => void {
  if (ms <= 0 || steps <= 1 || from === to) {
    set(to);
    return () => {};
  }
  let i = 0;
  const timer = setInterval(() => {
    i++;
    const t = i / steps;
    // ease-in-out so the dip sounds smooth even with few steps
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    set(from + (to - from) * eased);
    if (i >= steps) clearInterval(timer);
  }, ms / steps);
  return () => clearInterval(timer);
}

/** Loads a <script> once; resolves when `ready()` returns a value (or the script fires load). */
const scripts = new Map<string, Promise<void>>();
export function loadScriptOnce(src: string, timeoutMs = 15000, readyGlobal?: string): Promise<void> {
  let p = scripts.get(src);
  if (p) return p;
  p = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('No document'));
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    const timer = setTimeout(() => reject(new Error(`Timed out loading ${new URL(src).host}`)), timeoutMs);
    s.onerror = () => {
      clearTimeout(timer);
      scripts.delete(src);
      reject(new Error(`Could not load ${new URL(src).host} (offline or blocked)`));
    };
    s.onload = () => {
      if (!readyGlobal) {
        clearTimeout(timer);
        resolve();
      }
    };
    if (readyGlobal) {
      const w = window as unknown as Record<string, unknown>;
      const prev = w[readyGlobal] as (() => void) | undefined;
      w[readyGlobal] = () => {
        prev?.();
        clearTimeout(timer);
        resolve();
      };
    }
    document.head.appendChild(s);
  });
  scripts.set(src, p);
  return p;
}
