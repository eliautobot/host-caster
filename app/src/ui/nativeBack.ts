// Android hardware back button (wired in main.tsx through core/native startNativeShell).
import { back, navigate, useRoute } from '@/state/router';

type BackHandler = () => boolean;
const handlers: BackHandler[] = [];

/**
 * Lets a screen with its own inner steps (onboarding) take the back button first. The handler returns true when
 * it handled back, false to let the app go to the background. Returns the unsubscribe function.
 */
export function onNativeBack(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.lastIndexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** Closes the top sheet, else goes back a page, else returns false (home: the app goes to the background). */
export function handleNativeBack(): boolean {
  // Sheets close on Escape (components/Sheet.tsx); a closing sheet is no longer data-state="open"
  const sheet = document.querySelector('.aw-sheet-root[data-state="open"] [role="dialog"][aria-modal="true"]');
  if (sheet) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }
  const top = handlers[handlers.length - 1];
  if (top) return top();
  const { path, depth } = useRoute.getState();
  if (depth > 0) {
    back();
    return true;
  }
  if (path !== '/') {
    navigate('/', { replace: true });
    return true;
  }
  return false;
}
