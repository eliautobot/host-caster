// Plan and usage (online edition): the plan, renewal date, usage meters as listening hours, change plan (Checkout or
// the Stripe Portal), cancel (Portal, at the end of the period), use the included AI for every host, delete account.
import { useEffect, useState } from 'react';
import { CreditCard, Gauge, Sparkles, Trash2, WandSparkles } from 'lucide-react';
import { auth, online, type PlanId } from '@/core/api';
import { sellsPlans } from '@/core/native';
import { navigate } from '@/state/router';
import { usePlan, waitForPlan } from '@/state/plan';
import { useSession } from '@/state/session';
import { useRoute } from '@/state/router';
import { runAction } from '../../actions';
import { Button, TextField, toast } from '../../components';
import { Meters, PlanCards, dateText, planName } from '../../online/parts';
import { BackToApp, PlanLinkButton, usePlanLink } from '../../online/PlanLink';
import { applyIncluded } from '../../online/setupIncluded';
import { Actions, ConfirmSheet, Hint, SectionCard } from './account/parts';
import './account/account.css';
import '../../online/online.css';

type Status = ReturnType<typeof usePlan.getState>['status'];

/** One short line under the plan name (it is cut to one line on phones); the details go in the card. */
function statusLine(s: Status): string {
  if (!s?.plan) return s?.freePlan === false ? 'No plan yet' : 'Free: bring your own AI and voices';
  if (s.status === 'canceling') return `Works until ${dateText(s.renewsAt)}`;
  if (s.status === 'past_due') return sellsPlans ? `Update your card by ${dateText(s.graceUntil)}` : `Works until ${dateText(s.graceUntil)}`;
  return `Renews on ${dateText(s.renewsAt)}`;
}

/** linked = the phone apps' plan link is there: changes are made on the website. */
function statusDetail(s: Status, linked = false): string | undefined {
  if (s?.status === 'canceling') {
    return `You cancelled this plan. It keeps working until ${dateText(s.renewsAt)}, then your account ${s.freePlan ? 'is free (bring your own AI and voices)' : 'has no plan'}.${sellsPlans ? ' Changed your mind? Keep my plan.' : linked ? ' Changed your mind? Keep it on the website.' : ''}`;
  }
  if (s?.status === 'past_due') {
    return sellsPlans
      ? `Your last payment did not go through. The plan keeps working until ${dateText(s.graceUntil)} while we retry; update your card in Manage billing to keep it.`
      : `Your last payment did not go through. The plan keeps working until ${dateText(s.graceUntil)} while it is retried.${linked ? ' Update your card on the website.' : ''}`;
  }
  return undefined;
}

function DeleteOnline() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const hasPlan = Boolean(usePlan((s) => s.status?.plan));
  return (
    <>
      <Button variant="danger" icon={Trash2} onClick={() => setOpen(true)}>
        Delete account
      </Button>
      <ConfirmSheet
        open={open}
        onClose={() => {
          setOpen(false);
          setTyped('');
        }}
        title="Delete your Host-Caster account?"
        description={`${hasPlan ? 'Your plan is cancelled right away (no more charges), then ' : ''}your account and everything stored for it are deleted: synced hosts and stations, saved keys, usage and linked sign-ins. Songs and hosts on this device stay.`}
        confirmLabel="Delete account"
        danger
        onConfirm={async () => {
          if (typed.trim().toUpperCase() !== 'DELETE') {
            toast.error('Type DELETE to confirm');
            return;
          }
          const ok = await runAction(() => auth.deleteAccount());
          if (ok) {
            setOpen(false);
            await online.forgetPlanChosen();
            toast.success('Account deleted');
            navigate('/sign-in', { replace: true });
          }
        }}
      >
        <TextField label='Type "DELETE" to confirm' value={typed} onChange={setTyped} autoCapitalize="characters" autoComplete="off" />
      </ConfirmSheet>
    </>
  );
}

export default function Plan() {
  const session = useSession((s) => s.session);
  const config = useSession((s) => s.config);
  const status = usePlan((s) => s.status);
  const query = useRoute((s) => s.query);
  const [busy, setBusy] = useState<string>();
  const link = usePlanLink();
  // the website, back from Stripe: "Back to the app" becomes the main button
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (query.checkout === 'done' || query.portal) {
      void (async () => {
        const before = usePlan.getState().status?.plan;
        const s = query.checkout === 'done' ? await waitForPlan() : await usePlan.getState().sync();
        setChanged(true);
        if (s?.plan && s.plan !== before) {
          toast.success(`You are on ${planName(s, s.plan)}`);
          await applyIncluded({ brain: s.includes.brain, voices: s.includes.voices, premium: s.includes.premium });
        }
        // drop ?checkout / ?portal, unless the user already went somewhere else while Stripe was read back
        if (useRoute.getState().path === '/settings/plan') navigate('/settings/plan', { replace: true });
      })();
    } else if (!query.returned) {
      // (back from the website through the app's plan link: the deep link is already re-reading it from Stripe)
      void usePlan.getState().refresh();
    }
    if (query.checkout === 'cancelled') toast({ title: 'Checkout cancelled', description: 'Nothing was charged.' });
  }, [query.checkout, query.portal]);

  if (config?.edition !== 'online') return <Hint>Plans are part of the Host-Caster online service.</Hint>;
  if (!session) {
    return (
      <Actions>
        <Button variant="primary" onClick={() => navigate('/sign-in')}>
          Sign in
        </Button>
      </Actions>
    );
  }

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    await runAction(fn);
    setBusy(undefined);
  };
  const pick = (plan: PlanId) =>
    void act(plan, () => (status?.plan ? online.portal({ flow: 'change', plan }) : online.checkout(plan, 'settings')));
  const plans = status?.plans ?? config.online?.plans ?? [];

  return (
    <div className="aw-acct-stack" data-plan-page>
      <BackToApp changed={changed} />
      <SectionCard
        icon={CreditCard}
        tone={status?.plan ? 'signal' : 'neutral'}
        title={status ? planName(status, status.plan) : 'Your plan'}
        status={<span data-plan-status>{statusLine(status)}</span>}
        badge={
          status?.plan
            ? status.status === 'canceling'
              ? { label: 'Cancelled', tone: 'warm' }
              : status.status === 'past_due'
                ? { label: 'Payment problem', tone: 'warm' }
                : { label: 'Active', tone: 'ok', dot: true }
            : undefined
        }
      >
        {statusDetail(status, link.shown) && (
          <p className="aw-acct-desc" data-plan-detail>
            {statusDetail(status, link.shown)}
          </p>
        )}
        {!sellsPlans && link.shown ? (
          // the phone apps: plans are bought and changed on the website (signed in through the hand-off)
          <>
            <p className="aw-acct-desc" data-store-note>
              {link.note}
            </p>
            <Actions>
              <PlanLinkButton />
            </Actions>
          </>
        ) : !sellsPlans ? (
          <p className="aw-acct-desc" data-store-note>
            {status?.plan ? 'Plan changes are not available in this app.' : 'Bring your own AI and voices: your keys, or models on your own computer.'}
          </p>
        ) : status?.plan ? (
          <Actions>
            <Button loading={busy === 'portal'} onClick={() => void act('portal', () => online.portal())}>
              Manage billing
            </Button>
            {status.status === 'canceling' ? (
              <Button variant="primary" loading={busy === 'resume'} onClick={() => void act('resume', () => online.portal())}>
                Keep my plan
              </Button>
            ) : (
              <Button variant="ghost" loading={busy === 'cancel'} onClick={() => void act('cancel', () => online.portal({ flow: 'cancel' }))}>
                Cancel plan
              </Button>
            )}
          </Actions>
        ) : (
          <p className="aw-acct-desc">
            Add Host-Caster AI, Host-Caster Voices or both{plans.some((p) => p.includes.premium) ? ', or go Premium for 21 ElevenLabs voices on top' : ''}. Monthly, cancel anytime.
          </p>
        )}
      </SectionCard>

      {status?.plan && (
        <SectionCard icon={Gauge} title="This month" status={status.paused ? 'Included AI is paused for everyone today. It is back tomorrow.' : `Refills on ${dateText(status.renewsAt)}`}>
          <Meters status={status} />
          <Hint>
            Hours are approximate: they assume the hosts talk after most songs. When something runs out, the scripted fallback and this device’s voice fill in and the music keeps playing.
            {status.includes.premium ? ' When the premium voices run out, your hosts speak with their standard Host-Caster voices until the refill.' : ''}
          </Hint>
        </SectionCard>
      )}

      {status?.plan && (status.includes.brain || status.includes.voices) && (
        <SectionCard
          icon={WandSparkles}
          title="Use what your plan includes"
          status={status.includes.premium ? 'Give every host the included brain and premium voices.' : 'Give every host the included brain and voices.'}
        >
          <Actions>
            <Button
              loading={busy === 'apply'}
              onClick={() =>
                void act('apply', async () => {
                  const changed = await applyIncluded({ brain: status.includes.brain, voices: status.includes.voices, premium: status.includes.premium, force: true });
                  toast.success(changed.length ? `${changed.length} host${changed.length === 1 ? '' : 's'} updated` : 'Your hosts already use it');
                })
              }
            >
              Use for all hosts
            </Button>
            <Button variant="ghost" onClick={() => navigate('/hosts')}>
              Pick per host
            </Button>
          </Actions>
        </SectionCard>
      )}

      {sellsPlans && status?.enabled !== false && (
        <SectionCard icon={Sparkles} title={status?.plan ? 'Change plan' : 'Plans'} status={status?.plan ? 'Switching takes effect now; Stripe settles the difference on your next bill.' : undefined}>
          <PlanCards plans={plans} current={status?.plan} busy={busy as PlanId | undefined} onPick={pick} />
        </SectionCard>
      )}

      <SectionCard icon={Trash2} title="Delete account" status="Cancels your plan first, then deletes your data from Host-Caster.">
        <Actions>
          <DeleteOnline />
        </Actions>
      </SectionCard>
    </div>
  );
}
