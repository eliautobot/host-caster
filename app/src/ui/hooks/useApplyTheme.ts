import { useEffect } from 'react';
import { useSettings } from '@/state/settings';
import { useMediaQuery } from './useMediaQuery';

const THEME_COLOR = { dark: '#0a0a0b', light: '#f3f3f4' } as const;

/** Applies settings.theme to <html data-theme> and remembers it for the pre-paint script in index.html. */
export function useApplyTheme(): 'dark' | 'light' {
  const pref = useSettings((s) => s.settings.theme);
  const systemLight = useMediaQuery('(prefers-color-scheme: light)');
  const theme = pref === 'system' ? (systemLight ? 'light' : 'dark') : pref;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
    try {
      localStorage.setItem('hostcaster.theme', pref);
    } catch {
      // storage blocked
    }
  }, [theme, pref]);
  return theme;
}
