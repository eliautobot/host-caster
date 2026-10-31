// Hash router: '#/hosts/abc?tab=voice'. Hash URLs work from file://, Capacitor and any static host.
import { create } from 'zustand';

export interface RouteLocation {
  /** '/hosts/abc' */
  path: string;
  query: Record<string, string>;
  /** history depth inside the app; 0 = first page of this visit */
  depth: number;
}

export function parseHash(hash: string): Pick<RouteLocation, 'path' | 'query'> {
  const raw = hash.replace(/^#/, '') || '/';
  const [p = '/', q = ''] = raw.split('?');
  const path = '/' + p.split('/').filter(Boolean).join('/');
  return { path, query: Object.fromEntries(new URLSearchParams(q)) };
}

/** Matches '/hosts/:id' against '/hosts/abc' -> { id: 'abc' }; null when it does not match. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a[a.length - 1] === '*') {
    if (b.length < a.length - 1) return null;
  } else if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg === '*') break;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(b[i]!);
    else if (seg !== b[i]) return null;
  }
  return params;
}

/** Builds '/hosts/abc' from '/hosts/:id' + { id: 'abc' }. */
export function buildPath(pattern: string, params: Record<string, string> = {}): string {
  return pattern.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
}

export function href(path: string): string {
  return `#${path}`;
}

const readDepth = (): number => {
  const s = typeof history !== 'undefined' ? (history.state as { awDepth?: number } | null) : null;
  return typeof s?.awDepth === 'number' ? s.awDepth : 0;
};

const current = (): RouteLocation => ({
  ...(typeof location !== 'undefined' ? parseHash(location.hash) : { path: '/', query: {} }),
  depth: readDepth(),
});

export const useRoute = create<RouteLocation>(() => current());

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = to.startsWith('#') ? to : href(to);
  if (target === location.hash && !opts.replace) return;
  const depth = opts.replace ? readDepth() : readDepth() + 1;
  if (opts.replace) history.replaceState({ awDepth: depth }, '', target);
  else history.pushState({ awDepth: depth }, '', target);
  useRoute.setState(current());
}

/** Goes back inside the app, or to `fallback` when this is the first page of the visit (deep link). */
export function back(fallback = '/'): void {
  if (readDepth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

if (typeof window !== 'undefined') {
  if (typeof (history.state as { awDepth?: number } | null)?.awDepth !== 'number') {
    history.replaceState({ ...(history.state as object | null), awDepth: 0 }, '');
  }
  window.addEventListener('popstate', () => useRoute.setState(current()));
  window.addEventListener('hashchange', () => useRoute.setState(current()));
}
