// Notion connection (server routes in server/src/integrations/notion). The server keeps the token; the app picks what
// the hosts may read and where they write, sends what the listener asked to add, and shows the activity log.
import { kvDelete, kvGet, kvSet } from '../db/kv';
import { isDesktop, isNative, onDeepLink, openAuthUrl } from '../native';
import { createEmitter } from '../util/emitter';
import { api, ApiError, request } from './client';
import { usesBearer } from './auth';

export type NotionItemType = 'page' | 'data_source';

export interface NotionRef {
  id: string;
  type: NotionItemType;
  title: string;
}

export interface NotionWriteTarget {
  id: string;
  title: string;
  /** 'new' = a Host-Caster page we made inside `parentTitle`; 'direct' = the listener's own page */
  mode: 'new' | 'direct';
  parentId?: string;
  parentTitle?: string;
}

export interface NotionSettings {
  read: NotionRef[];
  write: NotionWriteTarget | null;
  writesOn: boolean;
  recapOn: boolean;
  recapDay?: string;
}

export interface NotionStatus {
  configured: boolean;
  connected: boolean;
  workspace?: { name: string; icon?: string };
  connectedAt?: number;
  settings?: NotionSettings;
}

export interface NotionPickerItem {
  id: string;
  type: NotionItemType;
  title: string;
  icon?: string;
  editedAt?: number;
  edited?: string;
  url?: string;
}

export interface NotionNote {
  id: string;
  title: string;
  text: string;
  editedAt?: number;
  /** "today", "yesterday", "3 days ago" by the listener's calendar */
  edited?: string;
}

export interface NotionActivity {
  id: string;
  at: number;
  source: 'call' | 'app' | 'recap';
  kind: 'todo' | 'note';
  text: string;
  pageTitle?: string;
  status: 'done' | 'failed' | 'undone';
  error?: string;
  canUndo: boolean;
}

export interface NotionWriteResult {
  ok: boolean;
  code?: string;
  message?: string;
  pageTitle?: string;
  activity?: NotionActivity;
  duplicate?: boolean;
}

const PKCE_KEY = 'notion:pkce';
const PKCE_TTL = 10 * 60_000;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface NotionEvents {
  /** connected / disconnected / a result from the phone's browser (`link`: from hostcaster://notion, `code` for words) */
  change: { connected?: boolean; error?: string; link?: boolean; code?: string };
}
const events = createEmitter<NotionEvents>();

const ERRORS: Record<string, string> = {
  access_denied: 'You cancelled on Notion. Nothing was connected.',
  state_invalid: 'That connect link expired. Try again.',
  link_expired: 'That connect link expired. Try again.',
  provider_disabled: 'Notion is not set up on this server.',
  code_invalid: 'That connect link expired. Try again.',
  token_exchange_failed: 'Notion did not finish the connection. Try again.',
  token_revoked: 'Notion did not finish the connection. Try again.',
};

/** Plain words for a ?notion= or hostcaster://notion?error= code (only short codes ever show, never free text). */
export const notionErrorText = (code: string): string =>
  ERRORS[code] ?? `Notion could not connect (${/^[a-z_]{1,40}$/.test(code) ? code : 'error'}).`;

let linkOff: (() => void) | undefined;
let whenReady: () => Promise<unknown> = () => Promise.resolve();

/**
 * Phones: catch hostcaster://notion from app start on, not only after Connect in this run. Android may stop the app
 * while Notion's page is open; the link then starts it again and must still finish. `ready` resolves once the saved
 * sign-in is back (finishing needs it). Idempotent.
 */
export function listenForNotionLinks(ready?: () => Promise<unknown>): void {
  if (ready) whenReady = ready;
  linkOff ??= onDeepLink((link) => void handleNotionLink(link).catch((err: unknown) => console.warn('[hostcaster] notion link', err)));
}

/** hostcaster://notion?code=... from the system browser: finish with this app's verifier. */
export async function handleNotionLink(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.host !== 'notion' && u.pathname.replace(/^\/+/, '') !== 'notion') return false;
  const error = u.searchParams.get('error');
  const code = u.searchParams.get('code');
  const saved = (await kvGet<{ verifier: string; at: number }>(PKCE_KEY))?.value;
  await kvDelete(PKCE_KEY);
  const fail = (c: string) => events.emit('change', { error: notionErrorText(c), code: c, link: true });
  if (error || !code) {
    fail(error ?? 'state_invalid');
    return true;
  }
  if (!saved || Date.now() - saved.at > PKCE_TTL) {
    fail('code_invalid');
    return true;
  }
  await whenReady();
  try {
    await request('POST', '/api/notion/finish', { code, verifier: saved.verifier });
    events.emit('change', { connected: true, link: true });
  } catch (err) {
    if (err instanceof ApiError) fail(err.code);
    else events.emit('change', { error: String(err), link: true });
  }
  return true;
}

export const notion = {
  on: events.on.bind(events),

  status: () => request<NotionStatus>('GET', '/api/notion/status'),

  /**
   * Opens Notion's own consent page. Web: this tab goes there and comes back to `returnTo`. Phone and desktop app:
   * the system browser, back through hostcaster://notion with a code only this app can finish.
   */
  async connect(returnTo = '/settings/connections'): Promise<void> {
    if (!isNative && !isDesktop) {
      const { url } = await request<{ url: string }>('POST', '/api/notion/start', { return: returnTo });
      if (usesBearer()) window.open(url, '_blank', 'noopener');
      else window.location.assign(url);
      return;
    }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const cc = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    await kvSet(PKCE_KEY, { verifier, at: Date.now() });
    listenForNotionLinks();
    const { url } = await request<{ url: string }>('POST', '/api/notion/start', { app: true, cc, return: returnTo });
    await openAuthUrl(url);
  },

  async disconnect(): Promise<void> {
    await request('DELETE', '/api/notion');
    await kvDelete('notion:context');
    events.emit('change', { connected: false });
  },

  pages: (q = '') => request<{ items: NotionPickerItem[] }>('GET', `/api/notion/pages?${zoned(q ? { q } : {})}`),

  saveSettings: (patch: { read?: { id: string; type: NotionItemType }[]; write?: { id: string; mode: 'new' | 'direct' } | null; writesOn?: boolean; recapOn?: boolean }) =>
    request<{ settings: NotionSettings }>('PUT', '/api/notion/settings', patch, { timeoutMs: 45_000 }),

  context: () =>
    request<{ notes: NotionNote[]; problems: { id: string; title: string; message: string }[]; fetchedAt: number }>('GET', `/api/notion/context?${zoned({})}`),

  write: (body: { kind: 'todo' | 'note'; text: string; source: 'call' | 'app'; ref?: string }) =>
    request<NotionWriteResult>('POST', '/api/notion/write', { ...body, tz: timeZone() }, { timeoutMs: 15_000 }),

  recap: (day: string, text: string) => request<NotionWriteResult & { code?: string }>('POST', '/api/notion/recap', { day, text, tz: timeZone() }),

  activity: () => request<{ items: NotionActivity[] }>('GET', '/api/notion/activity'),

  undo: (id: string) => request<{ activity: NotionActivity }>('POST', `/api/notion/activity/${encodeURIComponent(id)}/undo`),

  /** true when signed in to a server that may have Notion */
  get reachable(): boolean {
    return api.available && api.signedIn;
  },
};

/** Query string with the listener's time zone, so "edited today" follows their calendar (the server runs in UTC). */
function zoned(params: Record<string, string>): string {
  const tz = timeZone();
  return new URLSearchParams(tz ? { ...params, tz } : params).toString();
}

function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
