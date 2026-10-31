// The hosted Host-Caster service (online edition): email sign-in codes, Sign in with Apple, plans (Stripe Checkout and
// Customer Portal, opened in the browser), usage meters and the admin summary. Self-hosted servers have none of it.
import { kvDelete, kvGet, kvSet } from '../db/kv';
import { isNative, openAuthUrl, sellsPlans } from '../native';
import type { ApiSession, PlanInfo } from '../types';
import { api, request } from './client';
import { auth, usesBearer } from './auth';

export type PlanId = PlanInfo['id'];
export type MeterCategory = 'brain' | 'voice' | 'premium';

export interface UsageMeter {
  included: boolean;
  usedUsd: number;
  budgetUsd: number;
  percent: number;
  hoursTotal?: number;
  hoursLeft?: number;
  /** off = not in the plan; near = 80 percent used; reached = used up until the renewal */
  state: 'off' | 'ok' | 'near' | 'reached';
}

export interface BillingStatus {
  enabled: boolean;
  freePlan: boolean;
  plan: PlanId | null;
  /** canceling = cancelled, works until renewsAt; past_due = the card failed, works until graceUntil */
  status: 'none' | 'active' | 'canceling' | 'past_due';
  includes: { brain: boolean; voices: boolean; premium?: boolean };
  renewsAt?: number;
  cancelAtPeriodEnd: boolean;
  graceUntil?: number;
  plans: PlanInfo[];
  meters: Partial<Record<MeterCategory, UsageMeter>>;
  /** included AI is paused for everyone today (platform spend limit) */
  paused?: boolean;
}

export interface AdminSummary {
  users: { total: number; verified: number; newToday: number };
  plans: { voice: number; brain: number; both: number; premium?: number; free: number; canceling: number; pastDue: number };
  spend: { todayUsd: number; monthUsd: number; dailyLimitUsd: number; paused: boolean };
  top: { id: string; email: string; name: string; plan: PlanId | null; spendUsd: number; brainUsd: number; voiceUsd: number; premiumUsd: number }[];
  /** AI breaks people reported (POST /api/reports) */
  reports?: { last7Days: number };
  at: number;
}

/** Codes the included AI answers with when it cannot run (the radio's stand-in notice explains them). */
export const INCLUDED_CODES = ['included_budget_reached', 'included_paused', 'included_plan_required', 'included_off'] as const;
export const isIncludedCode = (code: string | undefined): boolean => Boolean(code && code.startsWith('included_'));

export const isOnline = (): boolean => api.config?.edition === 'online';

const PLAN_CHOSEN = 'online:planChosen';

export const online = {
  // ---- sign-in ----
  /** Sends a 6-digit code. Signed in without a confirmed email (X): the code adds the email to this account. */
  startEmail: (email: string) => request<{ sent: boolean; minutes: number }>('POST', '/api/auth/email/start', { email }),

  async verifyEmail(email: string, code: string): Promise<ApiSession> {
    const res = await request<ApiSession>('POST', '/api/auth/email/verify', { email, code, app: usesBearer() });
    // a confirmed email on the signed-in account keeps its token; a new sign-in brings its own
    const session: ApiSession = { ...res, token: res.token ?? api.session?.token };
    await auth.adopt(session);
    return session;
  },

  // ---- plans ----
  status: () => request<BillingStatus>('GET', '/api/billing/status'),
  /** Re-reads the plan from Stripe (after Checkout or the Portal; webhooks can lag a few seconds). */
  sync: () => request<BillingStatus>('POST', '/api/billing/sync', {}),

  /** Opens Stripe Checkout for a new plan (this tab on web, the browser on phones). from = where it returns. */
  async checkout(plan: PlanId, from: 'plans' | 'settings' = 'settings'): Promise<void> {
    if (!sellsPlans) throw new Error('Plans are not sold in this app.');
    const { url } = await request<{ url: string }>('POST', '/api/billing/checkout', { plan, app: isNative, from });
    await openExternal(url);
  },

  /** The Stripe Customer Portal: change plan, card or cancel (cancel = at the end of the period). */
  async portal(opts: { flow?: 'cancel' | 'change'; plan?: PlanId } = {}): Promise<void> {
    if (!sellsPlans) throw new Error('Plan changes are not available in this app.');
    const { url } = await request<{ url: string }>('POST', '/api/billing/portal', { ...opts, app: isNative });
    await openExternal(url);
  },

  admin: () => request<AdminSummary>('GET', '/api/admin/summary'),

  /** First run: the plan step shows once per account on this device. */
  async planChosen(): Promise<boolean> {
    const id = api.session?.user.id;
    return Boolean(id && (await kvGet<string>(PLAN_CHOSEN))?.value === id);
  },
  async markPlanChosen(): Promise<void> {
    if (api.session) await kvSet(PLAN_CHOSEN, api.session.user.id);
  },
  async forgetPlanChosen(): Promise<void> {
    await kvDelete(PLAN_CHOSEN);
  },
};

async function openExternal(url: string): Promise<void> {
  if (isNative) await openAuthUrl(url);
  else window.location.assign(url);
}

/** "about 430 hours" style text for a meter. */
export function hoursText(hours: number | undefined): string {
  if (hours === undefined) return '';
  if (hours < 1) return 'less than an hour';
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
