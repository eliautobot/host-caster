// The signed-in account's plan and usage meters (online edition). Refreshed on demand, on focus and every few
// minutes while the app is open; empty on self-hosted servers.
import { create } from 'zustand';
import { api, isOnline, online, type BillingStatus } from '@/core/api';
import { onForeground } from '@/core/native/links';

interface PlanStore {
  status?: BillingStatus;
  loading: boolean;
  error?: string;
  /** GET /api/billing/status */
  refresh(): Promise<BillingStatus | undefined>;
  /** POST /api/billing/sync: re-read from Stripe (after Checkout / the Portal) */
  sync(): Promise<BillingStatus | undefined>;
}

const canAsk = () => isOnline() && api.available && Boolean(api.session?.user.emailVerified);

export const usePlan = create<PlanStore>((set) => ({
  loading: false,
  async refresh() {
    if (!canAsk()) {
      set({ status: undefined });
      return undefined;
    }
    set({ loading: true });
    try {
      const status = await online.status();
      set({ status, loading: false, error: undefined });
      return status;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  },
  async sync() {
    if (!canAsk()) return undefined;
    set({ loading: true });
    try {
      const status = await online.sync();
      set({ status, loading: false, error: undefined });
      return status;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  },
}));

/**
 * Waits until a plan shows up after Checkout (its webhook can take a few seconds): reads the stored plan every 1.5 s
 * and asks Stripe itself (sync, rate limited) only now and then, in case the webhook is slow or lost.
 */
export async function waitForPlan(timeoutMs = 25_000): Promise<BillingStatus | undefined> {
  const end = Date.now() + timeoutMs;
  let last: BillingStatus | undefined;
  for (let i = 0; Date.now() < end; i++) {
    const { sync, refresh } = usePlan.getState();
    last = (i === 0 || i % 6 === 5 ? await sync() : await refresh()) ?? last;
    if (last?.plan) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/** Coming back within this long after the plan link re-reads the plan from Stripe (a webhook may still be on its way). */
export const HANDOFF_FRESH_MS = 30 * 60_000;

/**
 * The app came back to the foreground. Right after the plan link sent someone to the website: re-read the plan from
 * Stripe, so a plan bought or changed there shows within seconds. Otherwise the stored plan is enough.
 */
export function refreshOnReturn(now = Date.now()): Promise<BillingStatus | undefined> {
  const at = online.handedOffAt();
  return at && now - at < HANDOFF_FRESH_MS ? usePlan.getState().sync() : usePlan.getState().refresh();
}

let started = false;
/** Keeps the plan fresh while the app is open (called once at boot). */
export function startPlanStore(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const tick = () => void usePlan.getState().refresh();
  window.addEventListener('focus', tick);
  // phones: back from the browser (Custom Tab) or the app switcher; 'focus' does not fire there
  onForeground(() => void refreshOnReturn());
  setInterval(tick, 5 * 60_000);
}
