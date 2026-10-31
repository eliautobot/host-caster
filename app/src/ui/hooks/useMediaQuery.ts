import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** Desktop layout = sidebar + player bar. Keep in sync with the 900px media queries in CSS. */
export const DESKTOP_QUERY = '(min-width: 900px)';

export const useIsDesktop = () => useMediaQuery(DESKTOP_QUERY);
