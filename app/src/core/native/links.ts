// Sign-in in the system browser and the hostcaster:// deep links that bring the app back.
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { desktop } from './desktop';
import { isNative, platform } from './platform';

export const APP_SCHEME = 'hostcaster';

/** Native: in-app browser tab (Custom Tabs / SFSafariViewController). Desktop: the system browser. Web: same-window navigation. */
export async function openAuthUrl(url: string): Promise<void> {
  if (desktop) {
    await desktop.openExternal(url);
    return;
  }
  if (isNative) {
    await Browser.open({ url, presentationStyle: 'popover', toolbarColor: '#0a0a0b' });
    return;
  }
  if (typeof window !== 'undefined') window.location.assign(url);
}

/**
 * The in-app browser tab was closed: by the user (sign-in cancelled) and on Android also right after a sign-in
 * deep link brought the app back. Wait ~2 s for a deep link before treating it as a cancel. No-op on web.
 */
export function onBrowserClosed(cb: () => void): () => void {
  if (!isNative) return () => {};
  let removed = false;
  let handle: { remove: () => Promise<void> } | undefined;
  void Browser.addListener('browserFinished', cb).then((h) => {
    if (removed) void h.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    void handle?.remove();
  };
}

/** Opens any web page outside the app (help links, provider key pages). */
/** Only web pages open from data (a station's homepage, a feed link): never javascript:, data: or file: URLs. */
export const isWebUrl = (url: string): boolean => /^https?:\/\/[^\s]+$/i.test(String(url ?? '').trim());

export async function openExternal(url: string): Promise<void> {
  if (!isWebUrl(url)) return;
  if (desktop) await desktop.openExternal(url);
  else if (isNative) await Browser.open({ url, toolbarColor: '#0a0a0b' });
  else if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
}

type LinkCb = (url: string) => void;
const subscribers = new Set<LinkCb>();
const queued: string[] = [];
let started = false;
let lastUrl: string | undefined;
let lastAt = 0;

function deliver(url: string): void {
  // the launch URL and appUrlOpen can report the same link: keep one
  const now = Date.now();
  if (url === lastUrl && now - lastAt < 3000) return;
  lastUrl = url;
  lastAt = now;
  // The sign-in tab stays open on iOS after the redirect. Android already removed it (MainActivity is singleTask),
  // and Browser.close() there re-creates the controller activity, which opens the sign-in URL a second time.
  if (platform === 'ios' && url.startsWith(`${APP_SCHEME}://auth`)) void Browser.close().catch(() => {});
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hostcaster:deeplink', { detail: url }));
  if (!subscribers.size) {
    queued.push(url);
    return;
  }
  for (const cb of subscribers) {
    try {
      cb(url);
    } catch (err) {
      console.error('[hostcaster] deep link handler failed', err);
    }
  }
}

function start(): void {
  if (started || (!isNative && !desktop)) return;
  started = true;
  if (desktop) {
    // the desktop app: links from the OS (sign-in, Stripe, the ChatGPT page), and the one that launched it
    desktop.onDeepLink((url) => deliver(url));
    void desktop.launchLinks().then((links) => {
      for (const url of links) deliver(url);
    });
    return;
  }
  void App.addListener('appUrlOpen', (e) => deliver(e.url));
  void App.getLaunchUrl().then((r) => {
    if (r?.url && r.url.startsWith(`${APP_SCHEME}:`)) deliver(r.url);
  });
}

/**
 * hostcaster://... links (sign-in return `hostcaster://auth?code=...`). Links that arrive before anyone subscribes
 * (cold start from the link) are kept and handed to the first subscriber. Also fired as window 'hostcaster:deeplink'.
 */
export function onDeepLink(cb: LinkCb): () => void {
  start();
  subscribers.add(cb);
  if (queued.length) {
    for (const url of queued.splice(0)) cb(url);
  }
  return () => {
    subscribers.delete(cb);
  };
}

/** Start catching links at boot even before a subscriber exists (they are queued). */
export function startDeepLinks(): void {
  start();
}
