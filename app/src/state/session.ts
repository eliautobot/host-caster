// Session + sync state for React (owner: server agent). Restores the sign-in at boot, starts/stops sync, handles the
// web OAuth return (?signedIn= / ?linked= / ?error=) and sends first-run users to onboarding.
import { create } from 'zustand';
import { api, auth, isOnline, listenForDeepLinks, online, signInErrorText, sync, type SyncState } from '@/core/api';
import { getSettings } from '@/core/db';
import { onDeepLink, sellsPlans } from '@/core/native';
import type { ApiSession, ServerConfig } from '@/core/types';
import { toast } from '@/ui/components/Toast';
import { navigate, useRoute } from './router';
import { startPlanStore, usePlan } from './plan';

interface SessionStore {
  /** false until the saved session was checked */
  ready: boolean;
  session?: ApiSession;
  config?: ServerConfig;
  available: boolean;
  sync: SyncState;
}

export const useSession = create<SessionStore>(() => ({
  ready: false,
  available: api.available,
  config: api.config,
  sync: sync.state,
}));

export const useSignedIn = () => useSession((s) => Boolean(s.session));

const RETURN_KEYS = ['signedIn', 'linked', 'error'] as const;
const PROVIDER_NAME: Record<string, string> = { google: 'Google', x: 'X', apple: 'Apple', local: 'your account' };

/** Shows a toast for ?signedIn= / ?linked= / ?error= after an OAuth redirect and removes the params. */
function handleAuthReturn(session: ApiSession | undefined): void {
  const { path, query } = useRoute.getState();
  if (!RETURN_KEYS.some((k) => query[k])) return;
  if (query.signedIn && session) toast.success(`Signed in as ${session.user.name || session.user.email || PROVIDER_NAME[query.signedIn]}`);
  // the query comes from a link anyone can make: only known names show, never its text
  if (query.linked && PROVIDER_NAME[query.linked]) toast.success(`${PROVIDER_NAME[query.linked]} connected`);
  if (query.error && path !== '/sign-in') toast.error('Sign-in did not finish', signInErrorText(query.error));
  if (path === '/sign-in' && query.error) return; // the sign-in screen shows it inline
  const rest = Object.fromEntries(Object.entries(query).filter(([k]) => !(RETURN_KEYS as readonly string[]).includes(k)));
  const q = new URLSearchParams(rest).toString();
  navigate(`${path}${q ? `?${q}` : ''}`, { replace: true });
}

/**
 * Resolves once the first sync after sign-in has finished (or failed, or after `timeoutMs`), so a decision that
 * depends on the account's data (did it finish onboarding on another device?) sees the pulled settings.
 */
export function waitForFirstSync(timeoutMs = 4000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (sync.state.lastSyncedAt || sync.state.status === 'off') return resolve();
    const t = setTimeout(done, timeoutMs);
    const off = sync.on('state', (s) => s.status !== 'syncing' && Boolean(s.lastSyncedAt || s.status !== 'idle') && done());
    function done() {
      clearTimeout(t);
      off();
      resolve();
    }
  });
}

/**
 * First run: Home -> /welcome until onboarding is done or skipped. Deep links are left alone. Back on /welcome
 * from a sign-in whose account already finished onboarding (on another device): go home instead.
 */
async function maybeOnboard(returnedFromSignIn: boolean): Promise<void> {
  const settings = await getSettings();
  const { path, query } = useRoute.getState();
  if (settings.onboarded) {
    if (returnedFromSignIn && path === '/welcome') navigate('/', { replace: true });
    return;
  }
  if (path === '/' && !query.signedIn) navigate('/welcome', { replace: true });
}

/**
 * Online edition: an account is required. Signed out -> sign in; no confirmed email -> confirm it; a new account sees
 * the plan picker once, then onboarding.
 */
let routingRun = 0;
async function routeOnline(session: ApiSession | undefined): Promise<void> {
  // the latest call wins (a sign-in while the boot check is still running)
  const run = ++routingRun;
  const stale = () => run !== routingRun;
  const { path } = useRoute.getState();
  if (!session || !session.user.emailVerified) {
    if (path !== '/sign-in') navigate('/sign-in', { replace: true });
    return;
  }
  const status = await usePlan.getState().refresh();
  if (stale()) return;
  if (path === '/sign-in') navigate('/', { replace: true });
  // the phone apps sell no plans: with the free plan on there is nothing to pick there
  const picker = sellsPlans || status?.freePlan === false;
  if (status && !status.plan && status.enabled && picker && !(await online.planChosen()) && useRoute.getState().path !== '/plans') {
    if (!stale()) navigate('/plans', { replace: true });
    return;
  }
  await waitForFirstSync();
  if (!stale()) await maybeOnboard(true);
}

export function startSessionStore(): () => void {
  listenForDeepLinks();
  startPlanStore();
  const offs = [
    auth.on('change', (session) => {
      const was = useSession.getState().session;
      useSession.setState({ session });
      if (session) void sync.start();
      else void sync.stop();
      // a sign-in, a confirmed email or a sign-out while the app is open
      if (isOnline() && useSession.getState().ready && (was?.user.id !== session?.user.id || was?.user.emailVerified !== session?.user.emailVerified)) {
        void routeOnline(session);
      }
    }),
    // phones: Stripe Checkout and the Portal hand back with hostcaster://billing?status=...
    onDeepLink((url) => {
      const m = /^[a-z][a-z0-9+.-]*:\/\/billing\?status=([a-z]+)/i.exec(url);
      if (m) navigate(m[1] === 'done' ? '/settings/plan?checkout=done' : '/settings/plan?portal=1');
    }),
    sync.on('state', (s) => useSession.setState({ sync: s })),
    api.on('probe', (config) => useSession.setState({ config, available: api.available })),
    // the server forgot this session (expired, signed out elsewhere, account deleted)
    api.on('unauthorized', () => {
      void auth.dropSession();
      toast({ title: 'You were signed out', description: 'Your hosts and stations stay on this device.' });
      if (isOnline()) navigate('/sign-in', { replace: true });
    }),
  ];
  void (async () => {
    if (!api.config) await api.probe();
    const session = await auth.restore();
    useSession.setState({ ready: true, session, config: api.config, available: api.available });
    const returnedFromSignIn = Boolean(session && useRoute.getState().query.signedIn);
    handleAuthReturn(session);
    // restore() started sync; let the first pull land before deciding about onboarding (the account may have done
    // it on another device)
    if (isOnline()) return routeOnline(session);
    if (session) await waitForFirstSync();
    await maybeOnboard(returnedFromSignIn);
  })();
  return () => offs.forEach((off) => off());
}
