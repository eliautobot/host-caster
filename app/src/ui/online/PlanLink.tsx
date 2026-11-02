// The phone apps' way to a plan: they sell nothing themselves (store payment rules), so a button opens the website's
// plan page in the system browser (Custom Tab on Android), already signed in to this account (online.openWebsite).
// Shown only when the build allows the link (VITE_HOSTCASTER_PLAN_LINK) and the server sells plans (the online service
// with Stripe set up; never on a self-hosted server). On the website, a tab opened that way offers "Back to the app".
import { useState, type ReactNode } from 'react';
import { ArrowLeft, ExternalLink, Smartphone } from 'lucide-react';
import { online, planSiteName } from '@/core/api';
import { linksToPlans, planLink, sellsPlans } from '@/core/native';
import { usePlan } from '@/state/plan';
import { openedFromApp, useSession } from '@/state/session';
import { runAction } from '../actions';
import { Button, cx } from '../components';
import { Actions, SectionCard } from '../screens/settings/account/parts';

export interface PlanLinkInfo {
  /** this app links to the website for plans and the server sells them */
  shown: boolean;
  /** "See plans on host-caster.com" (free), "Manage your plan on host-caster.com" (a plan) */
  label: string;
  /** one short line: where plans are bought and that they work here right away */
  note: string;
}

export function usePlanLink(): PlanLinkInfo {
  const config = useSession((s) => s.config);
  const status = usePlan((s) => s.status);
  const shown = linksToPlans && config?.edition === 'online' && config.online?.billing === true && status?.enabled !== false;
  const site = planSiteName();
  if (planLink === 'account') return { shown, label: `Open your account on ${site}`, note: `Your plan is managed on ${site}.` };
  return {
    shown,
    label: status?.plan ? `Manage your plan on ${site}` : `See plans on ${site}`,
    note: status?.plan
      ? 'Plan changes are made on the website and show in the app right away.'
      : 'Plans are bought on the website and work in the app right away.',
  };
}

function useOpen(): [boolean, () => void] {
  const [busy, setBusy] = useState(false);
  return [
    busy,
    () => {
      if (busy) return;
      setBusy(true);
      void runAction(() => online.openWebsite()).finally(() => setBusy(false));
    },
  ];
}

/** The plan link as a button (nothing when it is not shown). */
export function PlanLinkButton({ size, variant = 'primary', block }: { size?: 'sm' | 'md' | 'lg'; variant?: 'primary' | 'secondary'; block?: boolean }) {
  const link = usePlanLink();
  const [busy, open] = useOpen();
  if (!link.shown) return null;
  return (
    <Button size={size} variant={variant} block={block} iconRight={ExternalLink} loading={busy} onClick={open} data-plan-link>
      {link.label}
    </Button>
  );
}

/** The plan link inside a sentence (pickers, notices). */
export function PlanLinkText({ children, className }: { children?: ReactNode; className?: string }) {
  const link = usePlanLink();
  const [busy, open] = useOpen();
  if (!link.shown) return null;
  return (
    <button type="button" className={cx('aw-textlink aw-planlink-text', className)} onClick={open} aria-busy={busy || undefined} data-plan-link>
      {children ?? link.label}
    </button>
  );
}

/** The website, in a tab the app's plan link opened: the way back to the app (hostcaster://plan re-reads the plan there). */
export function BackToApp({ changed }: { changed?: boolean }) {
  const scheme = useSession((s) => s.config?.appScheme) || 'hostcaster';
  if (!sellsPlans || !openedFromApp()) return null;
  return (
    <SectionCard
      icon={Smartphone}
      tone={changed ? 'signal' : 'neutral'}
      title="Back to the app"
      status={changed ? 'Your plan is ready in the Host-Caster app.' : 'Your plan works in the Host-Caster app as soon as it shows here.'}
    >
      <Actions>
        <a className={cx('aw-btn', changed ? 'aw-btn--primary' : 'aw-btn--secondary')} href={`${scheme}://plan`} data-back-to-app>
          <ArrowLeft aria-hidden />
          <span className="aw-btn__label">Back to the app</span>
        </a>
      </Actions>
    </SectionCard>
  );
}
