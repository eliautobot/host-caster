// First run on the Host-Caster online service (and "See plans"): pick a plan (Stripe Checkout) or start free.
// Checkout returns here with ?checkout=done; the plan is read back from Stripe, then onboarding continues.
import { useEffect, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { online, type PlanId } from '@/core/api';
import { getSettings } from '@/core/db';
import { sellsPlans } from '@/core/native';
import { navigate } from '@/state/router';
import { usePlan, waitForPlan } from '@/state/plan';
import { useSession } from '@/state/session';
import { runAction } from '../actions';
import { Button, LogoMark, toast } from '../components';
import { PlanCards, planName } from '../online/parts';
import { BareBackdrop } from './parts/BareBackdrop';
import type { ScreenProps } from '.';
import './Bare.css';
import '../online/online.css';

async function continueSetup() {
  await online.markPlanChosen();
  const { onboarded } = await getSettings();
  navigate(onboarded ? '/' : '/welcome?step=1', { replace: true });
}

export default function Plans({ query }: ScreenProps) {
  const config = useSession((s) => s.config);
  const session = useSession((s) => s.session);
  const status = usePlan((s) => s.status);
  const [busy, setBusy] = useState<PlanId>();
  const [finishing, setFinishing] = useState(query.checkout === 'done');
  const plans = status?.plans ?? config?.online?.plans ?? [];
  const billing = config?.online?.billing !== false;
  const freePlan = config?.online?.freePlan !== false;

  useEffect(() => {
    void usePlan.getState().refresh();
  }, [session?.user.id]);

  useEffect(() => {
    if (query.checkout === 'cancelled') toast({ title: 'Checkout cancelled', description: 'Nothing was charged. Pick a plan when you are ready.' });
    if (query.checkout !== 'done') return;
    let live = true;
    void (async () => {
      const s = await waitForPlan();
      if (!live) return;
      setFinishing(false);
      if (s?.plan) {
        toast.success(`Welcome to ${planName(s, s.plan)}`, 'Your included AI is ready for your hosts.');
        await continueSetup();
      } else {
        toast.error('Your plan is not showing yet', 'Stripe can take a minute. It appears in Settings, Plan and usage.');
      }
    })();
    return () => {
      live = false;
    };
  }, [query.checkout]);

  const pick = async (plan: PlanId) => {
    setBusy(plan);
    await runAction(() => online.checkout(plan, 'plans'));
    setBusy(undefined);
  };

  return (
    <div className="aw-bare aw-plans-screen">
      <div className="aw-bare__inner">
        <div className="aw-bare__mark">
          <BareBackdrop />
          <LogoMark size={48} />
        </div>
        {finishing ? (
          <>
            <h1 className="aw-bare__title">Setting up your plan</h1>
            <p className="aw-bare__lead">Thanks! This takes a few seconds.</p>
          </>
        ) : status?.plan ? (
          <>
            <h1 className="aw-bare__title">You are on {planName(status, status.plan)}</h1>
            {sellsPlans && <p className="aw-bare__lead">Change or cancel it any time in Settings, Plan and usage.</p>}
            <div className="aw-bare__actions">
              <Button variant="primary" size="lg" block iconRight={ArrowRight} onClick={() => void continueSetup()}>
                Continue
              </Button>
            </div>
          </>
        ) : !sellsPlans ? (
          // phone apps: nothing is sold here (store payment rules); a plan from the web shows up after sign-in
          <>
            <h1 className="aw-bare__title">{freePlan ? 'Welcome to Host-Caster' : 'No plan on this account'}</h1>
            <p className="aw-bare__lead">
              {freePlan ? 'Bring your own AI and voices: your keys, or models on your own computer.' : 'This account has no active plan, so Host-Caster cannot start here.'}
            </p>
            {freePlan && (
              <div className="aw-bare__actions">
                <Button variant="primary" size="lg" block iconRight={ArrowRight} onClick={() => void continueSetup()} data-start-free>
                  Continue
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <h1 className="aw-bare__title">Pick your plan</h1>
            <p className="aw-bare__lead">Monthly, cancel anytime. One plan covers the web, Android and iPhone.</p>
            {billing ? (
              <PlanCards plans={plans} busy={busy} onPick={(p) => void pick(p)} />
            ) : (
              <p className="aw-signin__note">Plans open soon. Start free and bring your own AI and voices.</p>
            )}
            {freePlan && (
              <div className="aw-plan-free" style={{ marginTop: 'var(--space-4)' }}>
                <span>
                  <strong>Free.</strong> Bring your own AI and voices (your keys, or models on your own computer).
                </span>
                <Button variant="ghost" icon={Check} onClick={() => void continueSetup()} data-start-free>
                  Start free
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
