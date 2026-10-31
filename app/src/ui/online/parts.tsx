// Online edition building blocks: plan cards, usage meters, the "included with your plan" notice for the brain and
// voice sheets, and the Home usage banner.
import { Check, Gauge, Minus, Sparkles, TriangleAlert } from 'lucide-react';
import { hoursText, type BillingStatus, type MeterCategory, type PlanId, type UsageMeter } from '@/core/api';
import { sellsPlans } from '@/core/native';
import type { PlanInfo, VoiceOption } from '@/core/types';
import { navigate } from '@/state/router';
import { usePlan } from '@/state/plan';
import { Badge, Button, Link, cx } from '../components';
import './online.css';

export const METER_NAME: Record<MeterCategory, string> = { brain: 'Host-Caster AI', voice: 'Host-Caster Voices', premium: 'Premium voices' };

export const planName = (status: BillingStatus | undefined, id: PlanId | null | undefined): string =>
  (id && status?.plans.find((p) => p.id === id)?.name) || (id ? id : 'Free');

export const dateText = (ms: number | undefined): string =>
  ms ? new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';

function features(p: PlanInfo, premiumOffered: boolean): { on: boolean; text: string }[] {
  return [
    { on: p.includes.brain, text: p.includes.brain ? 'Host-Caster AI brain included' : 'Bring your own AI brain' },
    { on: p.includes.voices, text: p.includes.voices ? 'Host-Caster Voices: 36 in 21 languages' : 'Bring your own voices' },
    ...(premiumOffered ? [{ on: Boolean(p.includes.premium), text: '21 premium ElevenLabs voices' }] : []),
    { on: true, text: 'Every device: web, Android, iPhone' },
    { on: true, text: 'Cancel anytime' },
  ];
}

/** The paid plans. `current` marks the active one; `onPick` runs Checkout or the Portal change. */
export function PlanCards({ plans, current, busy, onPick }: { plans: PlanInfo[]; current?: PlanId | null; busy?: PlanId; onPick: (id: PlanId) => void }) {
  const premiumOffered = plans.some((p) => p.includes.premium);
  return (
    <div className="aw-plans-wrap">
      <div className="aw-plans" data-count={plans.length}>
        {plans.map((p) => {
          const isCurrent = current === p.id;
          return (
            <div key={p.id} className={cx('aw-plan', isCurrent && 'aw-plan--current', p.includes.premium && 'aw-plan--premium')} data-plan={p.id}>
              <span className="aw-plan__flag">
                {isCurrent ? (
                  <Badge tone="ok" dot>
                    Your plan
                  </Badge>
                ) : p.id === 'both' ? (
                  <Badge tone="accent">Best value</Badge>
                ) : p.includes.premium ? (
                  <Badge tone="warm">Best voices</Badge>
                ) : null}
              </span>
              <span className="aw-plan__name">{p.name}</span>
              <span className="aw-plan__price">
                <span className="aw-plan__amount">{p.price}</span>
                <span className="aw-plan__per">a month</span>
              </span>
              <ul className="aw-plan__list">
                {features(p, premiumOffered).map((f) => (
                  <li key={f.text} className={f.on ? undefined : 'aw-plan__no'}>
                    {f.on ? <Check aria-hidden /> : <Minus aria-hidden />}
                    {f.text}
                  </li>
                ))}
              </ul>
              <div className="aw-plan__cta">
                <Button
                  block
                  variant={isCurrent ? 'secondary' : p.id === 'both' ? 'primary' : 'secondary'}
                  disabled={isCurrent}
                  loading={busy === p.id}
                  onClick={() => onPick(p.id)}
                >
                  {isCurrent ? 'Current plan' : current ? `Switch to ${p.short}` : `Choose ${p.short}`}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Meter({ category, meter }: { category: MeterCategory; meter: UsageMeter }) {
  const left =
    meter.state === 'off'
      ? 'Not in your plan'
      : meter.state === 'reached'
        ? category === 'premium'
          ? 'Used up: standard voices stand in'
          : 'Used up until your renewal'
        : `${hoursText(meter.hoursLeft)} left`;
  return (
    <div className={cx('aw-usage', `aw-usage--${meter.state}`)} data-meter={category}>
      <div className="aw-usage__head">
        <span className="aw-usage__name">{METER_NAME[category]}</span>
        <span className="aw-usage__left">{left}</span>
      </div>
      <div className="aw-usage__bar" role="progressbar" aria-label={`${METER_NAME[category]} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.percent}>
        <div className="aw-usage__fill" style={{ width: `${meter.state === 'off' ? 0 : meter.percent}%` }} />
      </div>
      {meter.state !== 'off' && (
        <span className="aw-usage__note">
          {meter.percent}% used{meter.hoursTotal ? ` of ${hoursText(meter.hoursTotal)} this month` : ''}
          {meter.state === 'near' ? '. Almost there.' : ''}
        </span>
      )}
    </div>
  );
}

export function Meters({ status }: { status: BillingStatus }) {
  const order: MeterCategory[] = ['brain', 'voice', 'premium'];
  return (
    <div className="aw-usages">
      {order.map((c) => {
        const m = status.meters[c];
        return m ? <Meter key={c} category={c} meter={m} /> : null;
      })}
    </div>
  );
}

/** Inside the brain / voice sheet for an included preset: what the plan gives, or how to get it. */
export function IncludedNotice({ kind }: { kind: 'brain' | 'voices' }) {
  const status = usePlan((s) => s.status);
  const included = kind === 'brain' ? status?.includes.brain : status?.includes.voices;
  const meter = kind === 'brain' ? status?.meters.brain : status?.meters.voice;
  const premium = kind === 'voices' ? status?.meters.premium : undefined;
  // voices on a plan without the premium ones: say what Premium adds (only when this server sells it)
  const premiumPlan = sellsPlans && kind === 'voices' && !status?.includes.premium ? status?.plans.find((p) => p.includes.premium) : undefined;
  return (
    <div className="aw-included" data-included={included ? 'yes' : 'no'}>
      {included ? (
        <>
          <p className="aw-included__line aw-included__line--ok">
            <Check aria-hidden />
            <span>
              <strong>Included with your {planName(status, status?.plan)} plan.</strong> Nothing to set up, no key.
            </span>
          </p>
          {meter && (
            <p className="aw-included__line aw-included__line--ok">
              <Gauge aria-hidden />
              <span>
                {meter.state === 'reached' ? 'This month is used up. ' : `${hoursText(meter.hoursLeft)} of listening left this month`}
                {premium ? `, premium voices ${hoursText(premium.hoursLeft)}.` : '.'} The scripted fallback and this device's voice fill in when it runs out.
              </span>
            </p>
          )}
          {premiumPlan && (
            <p className="aw-included__line aw-included__line--off" data-premium-upsell>
              <Sparkles aria-hidden />
              <span>
                <strong>Premium voices.</strong> 21 ElevenLabs voices come with the {premiumPlan.name} plan ({premiumPlan.price} a month).{' '}
                <Link to="/settings/plan" className="aw-textlink">
                  See {premiumPlan.name}
                </Link>
              </span>
            </p>
          )}
        </>
      ) : !sellsPlans ? (
        <p className="aw-included__line aw-included__line--off" data-store-note>
          <Sparkles aria-hidden />
          <span>{kind === 'brain' ? 'Host-Caster AI is not included with this account.' : 'Host-Caster Voices are not included with this account.'}</span>
        </p>
      ) : (
        <>
          <p className="aw-included__line aw-included__line--off">
            <Sparkles aria-hidden />
            <span>
              <strong>{kind === 'brain' ? 'Comes with the Brain, Everything and Premium plans.' : 'Come with the Voices, Everything and Premium plans.'}</strong>{' '}
              {kind === 'brain' ? 'Your hosts write their breaks with Host-Caster AI, no key needed.' : 'Studio voices for your hosts, no key needed.'}
            </span>
          </p>
          <div>
            <Button size="sm" variant="primary" onClick={() => navigate('/settings/plan')}>
              See plans
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Home: 80 percent and 100 percent notices, and the platform pause. */
export function UsageBanner() {
  const status = usePlan((s) => s.status);
  if (!status?.plan) return null;
  const meters = (['brain', 'voice', 'premium'] as MeterCategory[]).map((c) => [c, status.meters[c]] as const).filter(([, m]) => m && m.state !== 'off');
  const reached = meters.filter(([, m]) => m!.state === 'reached');
  const near = meters.filter(([, m]) => m!.state === 'near');
  if (!status.paused && !reached.length && !near.length) return null;
  const list = (items: typeof meters) => items.map(([c]) => METER_NAME[c]).join(' and ');
  const until = dateText(status.renewsAt) || 'your renewal';
  // used-up premium voices are not a stop: hosts speak with their standard stand-in voices
  const stopped = reached.filter(([c]) => c !== 'premium');
  const premiumOnly = !stopped.length && reached.length > 0;
  const text = status.paused
    ? 'Host-Caster AI is taking a short break for everyone today. The scripted fallback and this device’s voice fill in; the music keeps playing.'
    : stopped.length
      ? `You used this month’s ${list(reached)}. The scripted fallback and this device’s voice fill in until ${until}.`
      : premiumOnly
        ? `You used this month’s premium voices. Your hosts speak with their standard Host-Caster voice until ${until}.`
        : `You used 80% of this month’s ${list(near)}.`;
  const kind = stopped.length ? 'reached' : status.paused ? 'paused' : premiumOnly ? 'premium-reached' : 'near';
  return (
    <div className={cx('aw-usage-banner', (stopped.length || status.paused) && 'aw-usage-banner--reached')} role="status" data-usage-banner={kind}>
      <TriangleAlert aria-hidden />
      <span className="aw-usage-banner__text">{text}</span>
      <Button size="sm" variant="ghost" onClick={() => navigate('/settings/plan')}>
        See plan
      </Button>
    </div>
  );
}

/**
 * Host-Caster Voices pickers: a premium voice the plan cannot speak right now says who speaks for it (its standard
 * stand-in) and how to get it; otherwise, on a plan without premium voices, a short hint about what "Premium" means.
 */
export function PremiumVoiceNote({ voice, hasPremiumVoices }: { voice?: VoiceOption; hasPremiumVoices: boolean }) {
  const status = usePlan((s) => s.status);
  if (!status) return null;
  const premiumPlan = sellsPlans ? status.plans.find((p) => p.includes.premium) : undefined;
  const usedUp = Boolean(status.includes.premium && status.meters.premium?.state === 'reached');
  const upgrade = premiumPlan ? (
    <Link to="/settings/plan" className="aw-textlink" data-premium-upgrade>
      See {premiumPlan.name}
    </Link>
  ) : null;
  if (voice?.premium && (!status.includes.premium || usedUp)) {
    const standIn = voice.standIn?.name;
    return (
      <p className="aw-included__line aw-included__line--off aw-voice-note" data-stand-in={status.includes.voices && standIn ? voice.standIn!.id : ''}>
        <Sparkles aria-hidden />
        <span>
          {usedUp ? (
            <>
              <strong>This month’s premium voices are used up.</strong> {voice.name} speaks as {standIn ?? 'a standard voice'} until{' '}
              {dateText(status.renewsAt) || 'your renewal'}.
            </>
          ) : status.includes.voices && standIn ? (
            <>
              <strong>{voice.name} is a Premium voice.</strong> On your {planName(status, status.plan)} plan this host speaks as {standIn}, a Host-Caster
              voice like {voice.name}{sellsPlans ? ', until you go Premium' : ''}. {upgrade}
            </>
          ) : (
            <>
              <strong>{voice.name} is a Premium voice.</strong>{' '}
              {sellsPlans ? <>Premium voices come with the {premiumPlan?.name ?? 'Premium'} plan. {upgrade}</> : 'It is not included with this account.'}
            </>
          )}
        </span>
      </p>
    );
  }
  if (hasPremiumVoices && !status.includes.premium && premiumPlan) {
    return (
      <p className="aw-field__hint" data-premium-hint>
        Voices marked Premium (ElevenLabs) come with the{' '}
        <Link to="/settings/plan" className="aw-textlink">
          {premiumPlan.name} plan
        </Link>
        .
      </p>
    );
  }
  return null;
}
