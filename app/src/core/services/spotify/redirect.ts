// Spotify sends the browser back to `${origin}/spotify/callback?code=...&state=...` (a real path, because
// Spotify does not allow #fragments in redirect URIs). The server/dev server answers that path with the app;
// this turns it into the hash route the app router understands, before the router reads the URL.
// Keep this file free of imports: it runs first in main.tsx.

export const SPOTIFY_CALLBACK_ROUTE = '/services/spotify/callback';

export function captureSpotifyRedirect(loc: Pick<Location, 'pathname' | 'search' | 'hash'> = location): boolean {
  const m = /^(.*\/)spotify\/callback\/?$/.exec(loc.pathname);
  if (!m) return false;
  const base = m[1] || '/';
  const params = new URLSearchParams(loc.search);
  const keep = new URLSearchParams();
  for (const k of ['code', 'state', 'error']) {
    const v = params.get(k);
    if (v) keep.set(k, v);
  }
  history.replaceState(null, '', `${base}#${SPOTIFY_CALLBACK_ROUTE}?${keep.toString()}`);
  // the hash router may already have read the old URL: tell it (replaceState fires no event)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof HashChangeEvent !== 'undefined') {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
  return true;
}
