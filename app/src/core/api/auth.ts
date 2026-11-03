// Sign-in flows (owner: server agent). Web: OAuth redirects + httpOnly cookie. Native (or a web app talking to a
// server on another origin): system browser -> hostcaster://auth?code= deep link -> /api/auth/exchange -> bearer token
// kept in kv. Signed out = local-only mode: signing out removes the account's data from this device (core/db/account.ts).
import { clearAccountData } from '../db/account';
import { kvDelete, kvGet, kvSet } from '../db/kv';
import { isNative, onDeepLink, openAuthUrl } from '../native';
import type { ApiSession, ApiUser, SignInProvider } from '../types';
import { createEmitter } from '../util/emitter';
import { api, ApiError, request } from './client';
import { forgetHelperSignIns } from './helper';
import { sync } from './sync';

export type GoogleService = 'calendar' | 'gmail' | 'youtube' | 'calendarEvents' | 'tasks';
type OAuthProvider = Exclude<SignInProvider, 'local'>;

const SESSION_KEY = 'api:session';
const DEEP_LINK_TIMEOUT = 5 * 60_000;
/** the verifier of the native sign-in this app started (kept in kv so it survives the app being restarted) */
const PKCE_KEY = 'auth:pkce';
const PKCE_TTL = 10 * 60_000;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Native sign-in proof (like PKCE): the app keeps a random verifier and sends only its hash. The server hands the
 * hostcaster://auth code to whoever opens the deep link, but turns it into a session only for the verifier, so another
 * app that registered the scheme cannot use it, and a code this app did not ask for cannot sign it in.
 */
async function newAppChallenge(): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  await kvSet(PKCE_KEY, { verifier, at: Date.now() });
  return b64url(hash);
}

/** The verifier of a sign-in started here in the last 10 minutes (used once). */
async function takeVerifier(): Promise<string | undefined> {
  const saved = (await kvGet<{ verifier: string; at: number }>(PKCE_KEY))?.value;
  await kvDelete(PKCE_KEY);
  return saved && Date.now() - saved.at < PKCE_TTL ? saved.verifier : undefined;
}

interface AuthEvents {
  change: ApiSession | undefined;
}
const events = createEmitter<AuthEvents>();

/** Bearer sessions: native, or a web app pointed at a server on another origin. */
export const usesBearer = (): boolean => isNative || api.baseUrl !== '';

async function setSession(session: ApiSession | undefined): Promise<void> {
  api.configure({ session });
  if (session) await kvSet(SESSION_KEY, session);
  else await kvDelete(SESSION_KEY);
  events.emit('change', session);
}

// ---- native deep links ----------------------------------------------------------------------------------------------

type Pending = { resolve: (s: ApiSession | undefined) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
let pending: Pending | undefined;

function waitForDeepLink(): Promise<ApiSession | undefined> {
  pending?.reject(new Error('Sign-in restarted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = undefined;
      reject(new ApiError(0, 'timeout', 'Sign-in took too long. Try again.'));
    }, DEEP_LINK_TIMEOUT);
    pending = { resolve, reject, timer };
  });
}

const ERROR_TEXT: Record<string, string> = {
  access_denied: 'You cancelled the sign-in.',
  identity_in_use: 'That account is already linked to another Host-Caster account.',
  signups_closed: 'This server is not taking new accounts.',
  provider_disabled: 'That sign-in is not set up on this server.',
  state_invalid: 'The sign-in link expired. Try again.',
  app_outdated: 'Update the Host-Caster app to sign in.',
  not_started: 'That sign-in was not started in this app. Try again from here.',
  link_expired: 'The link expired. Try again.',
  token_revoked: 'The provider refused the sign-in. Try again.',
  identity_invalid: 'The sign-in could not be verified. Try again.',
};

/** error codes come from a link anyone can open: only a short code name ever shows, never free text */
const errorCode = (code: string): string => (/^[a-z_]{1,40}$/.test(code) ? code : 'provider_error');

export const signInErrorText = (code: string): string => ERROR_TEXT[code] ?? `Sign-in failed (${errorCode(code)}).`;

/** Handles hostcaster://auth?code=...|linked=...|error=... (call from the app's deep link listener). */
export async function handleDeepLink(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = `${api.config?.appScheme ?? 'hostcaster'}:`;
  if (u.protocol !== scheme || (u.host !== 'auth' && u.pathname.replace(/^\/+/, '') !== 'auth')) return false;
  const p = pending;
  pending = undefined;
  if (p) clearTimeout(p.timer);
  try {
    const error = u.searchParams.get('error');
    if (error) throw new ApiError(400, errorCode(error), signInErrorText(error));
    const code = u.searchParams.get('code');
    const linkcode = u.searchParams.get('linkcode');
    if (code || linkcode) {
      // only a sign-in this app started (another page or app can open hostcaster://auth?code=... too)
      const verifier = await takeVerifier();
      if (!verifier) throw new ApiError(400, 'not_started', signInErrorText('not_started'));
      if (code) {
        const session = await request<ApiSession>('POST', '/api/auth/exchange', { code, verifier });
        await setSession(session);
        p?.resolve(session);
      } else {
        // linking to the signed-in account finishes with this app's session and verifier
        await request('POST', '/api/auth/link/finish', { code: linkcode, verifier });
        p?.resolve(await auth.me());
      }
    } else {
      // linked=google: refresh the user so the new identity shows
      const fresh = await auth.me();
      p?.resolve(fresh);
    }
  } catch (err) {
    if (p) p.reject(err as Error);
    else throw err;
  }
  return true;
}

let deepLinkOff: (() => void) | undefined;
/** Listens for auth deep links (native). Idempotent. */
export function listenForDeepLinks(): void {
  deepLinkOff ??= onDeepLink((url) => void handleDeepLink(url).catch((err: unknown) => console.warn('[hostcaster] auth link', err)));
}

// ---- flows ----------------------------------------------------------------------------------------------------------

function startUrl(provider: OAuthProvider, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])));
  return api.url(`/auth/${provider}/start${q.size ? `?${q}` : ''}`);
}

/** Current hash route, used as the return target after a web redirect. */
const currentRoute = (): string => (typeof location !== 'undefined' ? location.hash.replace(/^#/, '') || '/' : '/');

async function oauth(provider: OAuthProvider, opts: { scopes?: GoogleService[]; link?: boolean; returnTo?: string }) {
  const scopes = opts.scopes?.join(',');
  if (!usesBearer()) {
    // Web, same origin: the server sets the cookie and redirects back into the app.
    const url = startUrl(provider, { scopes, link: opts.link ? '1' : undefined, return: opts.returnTo });
    window.location.assign(url);
    return new Promise<ApiSession | undefined>(() => {}); // the page navigates away
  }
  let link: string | undefined;
  if (opts.link || (scopes && api.session)) {
    link = (await request<{ ticket: string }>('POST', '/api/auth/link-ticket')).ticket;
  }
  listenForDeepLinks();
  const cc = await newAppChallenge();
  const done = waitForDeepLink();
  await openAuthUrl(startUrl(provider, { app: '1', cc, scopes, link }));
  return done;
}

export const auth = {
  on: events.on.bind(events),

  /** Restores the saved session (bearer) or asks the server about the cookie. Never throws. */
  async restore(): Promise<ApiSession | undefined> {
    const saved = (await kvGet<ApiSession>(SESSION_KEY))?.value;
    if (saved) api.configure({ session: saved });
    if (!api.available) return saved; // offline: stay signed in locally, sync resumes later
    try {
      const me = await request<{ user: ApiUser; kind: 'web' | 'app' }>('GET', '/api/me');
      const session: ApiSession = { user: me.user, kind: me.kind, token: saved?.token };
      await setSession(session);
      return session;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        if (saved) await setSession(undefined);
        return undefined;
      }
      return saved;
    }
  },

  /** google / x: redirect (web) or system browser + deep link (native). local: email + password. */
  async signIn(
    provider: SignInProvider,
    creds?: { email: string; password: string; name?: string; create?: boolean },
    opts: { scopes?: GoogleService[]; returnTo?: string } = {},
  ): Promise<ApiSession | undefined> {
    if (!api.available) throw new ApiError(0, 'offline', 'No Host-Caster server is reachable');
    if (provider === 'local') {
      if (!creds) throw new ApiError(400, 'invalid_request', 'Enter your email and password');
      const path = creds.create ? '/api/auth/local/signup' : '/api/auth/local/login';
      const session = await request<ApiSession>('POST', path, {
        email: creds.email,
        password: creds.password,
        name: creds.name,
        app: usesBearer(),
      });
      await setSession(session);
      return session;
    }
    return oauth(provider, { scopes: opts.scopes, returnTo: opts.returnTo ?? '/' });
  },

  /** Adds Google services (incremental consent) to the signed-in account, or signs in with them. */
  connectGoogle(scopes: GoogleService[], returnTo = currentRoute()): Promise<ApiSession | undefined> {
    return oauth('google', { scopes, link: Boolean(api.session), returnTo });
  },

  /**
   * Adds Google API scopes (calendar, gmail, youtube) to the signed-in account and comes back to `returnTo`.
   * Web: redirect with the cookie session. Native: system browser with a one-time link ticket, resolves when the
   * hostcaster://auth?linked=google deep link arrives. Signed out: signs in with Google and those scopes.
   */
  linkGoogle(scopes: GoogleService[], returnTo = currentRoute()): Promise<ApiSession | undefined> {
    return oauth('google', { scopes, link: Boolean(api.session), returnTo });
  },

  /** Links another sign-in (Google or X) to this account. */
  link(provider: OAuthProvider, returnTo = currentRoute()): Promise<ApiSession | undefined> {
    return oauth(provider, { link: true, returnTo });
  },

  async unlink(provider: SignInProvider): Promise<ApiUser> {
    const { user } = await request<{ user: ApiUser }>('DELETE', `/api/me/identities/${provider}`);
    await auth.updateUser(user);
    return user;
  },

  async setPassword(password: string, opts: { email?: string; current?: string } = {}): Promise<ApiUser> {
    const { user } = await request<{ user: ApiUser }>('PUT', '/api/me/password', { password, ...opts });
    await auth.updateUser(user);
    return user;
  },

  async rename(name: string): Promise<ApiUser> {
    const { user } = await request<{ user: ApiUser }>('PATCH', '/api/me', { name });
    await auth.updateUser(user);
    return user;
  },

  /** Uses a session the server just issued (email code sign-in, online edition). */
  async adopt(session: ApiSession): Promise<void> {
    await setSession(session);
  },

  async updateUser(user: ApiUser): Promise<void> {
    if (api.session) await setSession({ ...api.session, user });
  },

  /**
   * Signs out and removes the account's data from this device (hosts, stations, brains, voices, profile, settings,
   * Your list, memories, history, tokens; kept: song files and music folders of this device, player and device
   * settings), leaving a clean first run; the caller restarts the app. Call sync.flush() first to push what waits.
   * Data that never joined the account (a join still waiting for an answer) is not the account's and stays. Returns
   * whether the account's data was removed.
   */
  async signOut(): Promise<boolean> {
    const userId = api.session?.user.id;
    const holds = userId ? await sync.holdsAccountData(userId) : false;
    await sync.stop(true);
    if (api.available && api.session) await request('POST', '/api/auth/logout').catch(() => undefined);
    if (holds) {
      await forgetHelperSignIns();
      await clearAccountData();
    } else await sync.stop(false);
    await setSession(undefined);
    return holds;
  },

  /** Deletes the account and everything the server stores for it. Local data stays (belonging to no account). */
  async deleteAccount(): Promise<void> {
    await request('DELETE', '/api/me');
    await sync.stop(false);
    await setSession(undefined);
  },

  /** Forgets the session locally (expired / revoked). */
  async dropSession(): Promise<void> {
    await setSession(undefined);
  },

  async me(): Promise<ApiSession | undefined> {
    if (!api.available) return api.session;
    try {
      const me = await request<{ user: ApiUser; kind: 'web' | 'app' }>('GET', '/api/me');
      const session: ApiSession = { user: me.user, kind: me.kind, token: api.session?.token };
      await setSession(session);
      return session;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return undefined;
      throw err;
    }
  },
};
