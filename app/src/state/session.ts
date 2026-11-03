// Session + sync state for React (owner: server agent). Restores the sign-in at boot, starts/stops sync, handles the
// web OAuth return (?signedIn= / ?linked= / ?error=) and sends first-run users to onboarding.
import { create } from 'zustand';
import { api, auth, isOnline, listenForDeepLinks, online, signInErrorText, sync, type SyncState } from '@/core/api';
import { listenForNotionLinks, notion } from '@/core/api/notion';
import { getSettings } from '@/core/db';
import { onDeepLink, sellsPlans } from '@/core/native';
import { player } from '@/core/player';
import { radio } from '@/core/radio';
import type { ApiSession, ServerConfig } from '@/core/types';
import { toast } from '@/ui/components/Toast';
import { announceSignOut } from '@/ui/account/flash';
import { applyIncluded } from '@/ui/online/setupIncluded';
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

const FROM_APP = 'hostcaster:fromApp';

/** This browser tab came from the app's plan link (?from=app): the website's plan pages offer "Back to the app". */
export function openedFromApp(): boolean {
  try {
    return sessionStorage.getItem(FROM_APP) === '1';
  } catch {
    return false;
  }
}

/** Keeps ?from=app for this tab (it survives the trip through Stripe) and takes it off the address. */
function captureFromApp(): void {
  const { path, query } = useRoute.getState();
  if (query.from !== 'app') return;
  try {
    sessionStorage.setItem(FROM_APP, '1');
  } catch {
    // private mode without storage: the page just does not offer the way back
  }
  const rest = new URLSearchParams(Object.entries(query).filter(([k]) => k !== 'from')).toString();
  navigate(`${path}${rest ? `?${rest}` : ''}`, { replace: true });
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
  // opened from the app's plan link: this browser goes to the plan page, not the first-run plan picker
  if (openedFromApp()) await online.markPlanChosen();
  // the phone apps sell no plans: with the free plan on there is nothing to pick there
  const picker = sellsPlans || status?.freePlan === false;
  if (status && !status.plan && status.enabled && picker && !(await online.planChosen()) && useRoute.getState().path !== '/plans') {
    if (!stale()) navigate('/plans', { replace: true });
    return;
  }
  await waitForFirstSync();
  if (!stale()) await maybeOnboard(true);
}

/** Resolves once the saved session was checked at boot. */
const sessionReady = (): Promise<void> =>
  new Promise((resolve) => {
    if (useSession.getState().ready) return resolve();
    const off = useSession.subscribe((s) => {
      if (!s.ready) return;
      off();
      resolve();
    });
  });

/** The plan changed on the website after the app's plan link: say so once and put what it includes to work. */
function announcePlanChanges(): () => void {
  let announced: string | null | undefined;
  return usePlan.subscribe((s, prev) => {
    const now = s.status?.plan;
    if (!online.handedOffAt() || !s.status || !prev.status || !now || now === prev.status.plan || now === announced) return;
    announced = now;
    toast.success(`You are on ${s.status.plans.find((p) => p.id === now)?.name ?? now}`);
    void applyIncluded({ brain: s.status.includes.brain, voices: s.status.includes.voices, premium: s.status.includes.premium });
  });
}

export function startSessionStore(): () => void {
  captureFromApp();
  listenForDeepLinks();
  listenForNotionLinks(sessionReady);
  startPlanStore();
  const offs = [
    auth.on('change', (session) => {
      const was = useSession.getState().session;
      useSession.setState({ session });
      if (session) void sync.start();
      // a session that ended by itself keeps what was synced (the data here is still that account's); signing out
      // removed it already (auth.signOut)
      else void sync.stop(true);
      // a sign-in, a confirmed email or a sign-out while the app is open
      if (isOnline() && useSession.getState().ready && (was?.user.id !== session?.user.id || was?.user.emailVerified !== session?.user.emailVerified)) {
        void routeOnline(session);
      }
    }),
    // phones: Stripe Checkout and the Portal hand back with hostcaster://billing?status=...
    onDeepLink((url) => {
      const m = /^[a-z][a-z0-9+.-]*:\/\/billing\?status=([a-z]+)/i.exec(url);
      if (m) navigate(m[1] === 'done' ? '/settings/plan?checkout=done' : '/settings/plan?portal=1');
      // the website's "Back to the app" after the plan link: re-read the plan from Stripe and show it
      if (/^[a-z][a-z0-9+.-]*:\/\/plan(?:[/?#]|$)/i.test(url)) {
        if (useRoute.getState().path !== '/plans') navigate('/settings/plan?returned=1');
        void usePlan.getState().sync();
      }
    }),
    announcePlanChanges(),
    // phones: Notion's consent came back while Connections was not open (Android stopped the app meanwhile and the
    // link started it again): show the result there, where the card opens the page picker
    notion.on('change', (e) => {
      if (!e.link || useRoute.getState().path === '/settings/connections') return;
      navigate(`/settings/connections?notion=${e.connected ? 'connected' : encodeURIComponent(e.code ?? 'error')}`);
    }),
    sync.on('state', (s) => useSession.setState({ sync: s })),
    sync.on('notice', (notice) => {
      // the other account's station and queue leave with its data
      if (notice === 'other-account') {
        radio.stop();
        player.stop();
        void player.load([]);
      }
      if (notice === 'other-account') toast({ title: 'Started fresh for this account', description: 'This device had another account\'s hosts and stations. They were removed here and stay in that account.' });
      else toast({ title: 'Your account stayed as it was', description: 'This device\'s copies would have replaced most of it, so your account\'s versions stayed. Anything new from this device was added.' });
    }),
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
    announceSignOut();
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
