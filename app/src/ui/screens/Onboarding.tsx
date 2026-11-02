import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Cloud,
  HardDrive,
  Laptop,
  Music2,
  RadioReceiver,
  Server,
  Smartphone,
  Sparkles,
  SquarePlay,
  type LucideIcon,
} from 'lucide-react';
import { isOnline, type BillingStatus } from '@/core/api';
import { usePlan } from '@/state/plan';
import { applyIncluded } from '../online/setupIncluded';
import { saveProfile, saveSettings, saveStation } from '@/core/db';
import { linksToPlans, platform, sellsPlans } from '@/core/native';
import type { StationSource } from '@/core/types';
import { useHosts } from '@/state/hosts';
import { useProfile } from '@/state/profile';
import { back, navigate, useRoute } from '@/state/router';
import { useSession } from '@/state/session';
import { useActiveStation } from '@/state/stations';
import { runAction } from '../actions';
import { ChatGPTMark } from '../radio/settings/chatgpt/ChatGPTMark';
import { onNativeBack } from '../nativeBack';
import { Avatar, Button, LogoMark, TextField, cx } from '../components';
import { BareBackdrop } from './parts/BareBackdrop';
import type { ScreenProps } from '.';
import './Bare.css';
import './Onboarding.css';

type Music = 'library' | 'server' | 'services' | 'anyapp';
// No "built-in host" here: hosts always think with an AI. Until one is connected ("Set up later") the scripted
// fallback reads short lines so the music never goes quiet.
type BrainChoice = 'included' | 'chatgpt' | 'local' | 'cloud' | 'later';
type VoiceChoice = 'hostcaster' | 'device' | 'own';

interface Option<V extends string> {
  value: V;
  icon: LucideIcon | ComponentType;
  title: string;
  text: string;
}

function OptionList<V extends string>({ options, value, onChange, label }: { options: Option<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className="aw-onb-options" role="radiogroup" aria-label={label}>
      {options.map(({ value: v, icon: Icon, title, text }) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={cx('aw-onb-option', value === v && 'aw-onb-option--on')} onClick={() => onChange(v)}>
          <span className="aw-onb-option__icon" aria-hidden>
            <Icon />
          </span>
          <span className="aw-onb-option__text">
            <span className="aw-onb-option__title">{title}</span>
            <span className="aw-onb-option__desc">{text}</span>
          </span>
          <span className="aw-onb-option__check" aria-hidden>
            <Check />
          </span>
        </button>
      ))}
    </div>
  );
}

/** The Host-Caster Voices choice, by plan: what is included now, or which plans include it. */
function voicesText(plan: BillingStatus | undefined, plansOffered: boolean): string {
  const premiumPlan = plan?.plans.find((p) => p.includes.premium);
  if (plan?.includes.premium) return 'Included with your plan: 21 premium ElevenLabs voices, plus 36 natural voices in 21 languages.';
  if (plan?.includes.voices) {
    return `Included with your plan. Natural voices in 21 languages.${premiumPlan && plansOffered ? ` Premium ElevenLabs voices come with ${premiumPlan.name}.` : ''}`;
  }
  return `Included with the ${premiumPlan ? 'Voices, Everything and Premium plans' : 'Voices or Everything plan'}. Natural voices in 21 languages.`;
}

const STEPS = ['welcome', 'name', 'hosts', 'music', 'brain', 'done'] as const;

/** First run (owner: server agent): name, hosts, music source, brain. Every step can be skipped. */
export default function Onboarding({ query }: ScreenProps) {
  const profile = useProfile((s) => s.profile);
  const hosts = useHosts((s) => s.hosts);
  const station = useActiveStation();
  const config = useSession((s) => s.config);
  const session = useSession((s) => s.session);
  const [step, setStep] = useState(() => Math.min(STEPS.length - 1, Math.max(0, Number(query.step) || 0)));
  const [name, setName] = useState(profile.name);
  const [picked, setPicked] = useState<string[]>([]);
  const [music, setMusic] = useState<Music>('library');
  const [brain, setBrain] = useState<BrainChoice>('later');
  // online edition: what the plan includes is the first choice
  const plan = usePlan((s) => s.status);
  const onlineEd = isOnline();
  // plans sold here (web, desktop) or by the phone apps' link to the website (Settings, Plan and usage)
  const plansOffered = sellsPlans || (linksToPlans && config?.online?.billing === true);
  const [voice, setVoice] = useState<VoiceChoice>('device');
  useEffect(() => {
    if (plan?.includes.brain) setBrain('included');
    if (plan?.includes.voices) setVoice('hostcaster');
  }, [plan?.includes.brain, plan?.includes.voices]);

  useEffect(() => setName((n) => n || profile.name || session?.user.name?.split(' ')[0] || ''), [profile.name, session]);
  useEffect(() => {
    if (!picked.length && station?.hostIds.length) setPicked(station.hostIds.filter((id) => hosts.some((h) => h.id === id)));
  }, [station, hosts, picked.length]);

  const musicOptions = useMemo(() => {
    const list: Option<Music>[] = [
      { value: 'library', icon: platform === 'web' ? Laptop : Smartphone, title: 'Songs on this device', text: 'MP3, FLAC, M4A and more. They stay on this device.' },
    ];
    if (config?.serverLibrary) list.push({ value: 'server', icon: Server, title: 'Music on my Host-Caster server', text: 'The library on the server you signed in to, streamed.' });
    list.push({ value: 'services', icon: SquarePlay, title: 'A music service', text: 'YouTube Music, Spotify, internet radio or your Navidrome / Subsonic server.' });
    if (platform === 'android') list.push({ value: 'anyapp', icon: RadioReceiver, title: 'Any music app', text: 'Keep your usual app playing; the hosts talk between its songs.' });
    return list;
  }, [config?.serverLibrary]);

  const brainOptions: Option<BrainChoice>[] = [
    // a phone app without the plan link: Host-Caster AI is offered there only when the account has it
    ...(onlineEd && (plansOffered || plan?.includes.brain)
      ? [{
          value: 'included' as const,
          icon: Sparkles,
          title: 'Host-Caster AI',
          text: plan?.includes.brain ? 'Included with your plan. Nothing to set up.' : 'Included with the Brain, Everything and Premium plans. Nothing to set up, no key.',
        }]
      : []),
    { value: 'local', icon: HardDrive, title: 'A model on my network', text: 'Ollama, LM Studio, llama.cpp ... free and private.' },
    { value: 'cloud', icon: Cloud, title: 'A cloud AI (your own key)', text: 'OpenAI, Claude, Grok, Gemini and more.' },
    ...(config?.chatgptPlan ? [{ value: 'chatgpt' as const, icon: ChatGPTMark, title: 'Your ChatGPT plan', text: 'ChatGPT Plus or Pro. Sign in with ChatGPT, no API key.' }] : []),
    { value: 'later', icon: Clock, title: 'Set up later', text: 'Connect an AI any time in Settings.' },
  ];

  const voiceOptions: Option<VoiceChoice>[] = [
    ...(plansOffered || plan?.includes.voices
      ? [{
          value: 'hostcaster' as const,
          icon: Sparkles,
          title: 'Host-Caster Voices',
          text: voicesText(plan, plansOffered),
        }]
      : []),
    { value: 'device', icon: Smartphone, title: 'This device’s voice', text: 'Free, works offline.' },
    { value: 'own', icon: Cloud, title: 'My own voices', text: 'ElevenLabs, OpenAI or Kokoro on your computer.' },
  ];
  // a Host-Caster pick that the plan does not include yet leads to the plan picker
  const needsPlan = onlineEd && plansOffered && ((brain === 'included' && !plan?.includes.brain) || (voice === 'hostcaster' && !plan?.includes.voices));

  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? (p.length > 1 ? p.filter((x) => x !== id) : p) : p.length < 4 ? [...p, id] : p));

  const finish = async (to: string) => {
    await runAction(async () => {
      if (name.trim() && name.trim() !== profile.name) await saveProfile({ name: name.trim(), callMe: profile.callMe || name.trim() });
      if (station && step >= 2) {
        const sources: StationSource[] =
          music === 'server' ? [{ kind: 'server' }] : music === 'anyapp' ? [{ kind: 'anyapp' }] : station.sources.length ? station.sources : [{ kind: 'library' }];
        await saveStation({ ...station, hostIds: picked.length ? picked : station.hostIds, sources });
      }
      const brainNow = brain === 'included' && Boolean(plan?.includes.brain);
      const voicesNow = voice === 'hostcaster' && Boolean(plan?.includes.voices);
      if (onlineEd && (brainNow || voicesNow)) await applyIncluded({ brain: brainNow, voices: voicesNow, premium: voicesNow && Boolean(plan?.includes.premium), hostIds: picked });
      await saveSettings({ onboarded: true });
      navigate(to, { replace: true });
    });
  };

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const prev = () => setStep((s) => Math.max(0, s - 1));
  const id = STEPS[step];

  // Android back: the previous step; on the first screen leave like Home does (app to the background)
  useEffect(
    () =>
      onNativeBack(() => {
        if (step > 0) {
          prev();
          return true;
        }
        if (useRoute.getState().depth > 0) {
          back();
          return true;
        }
        return false;
      }),
    [step],
  );

  const followUps: { label: string; to: string }[] = [];
  if (music === 'library') followUps.push({ label: 'Add songs', to: '/library' });
  if (music === 'services') followUps.push({ label: 'Connect a music service', to: '/settings/music-services' });
  if (needsPlan) followUps.push({ label: 'Choose a plan', to: '/settings/plan' });
  if (brain === 'local' || brain === 'cloud' || brain === 'chatgpt')
    followUps.push({ label: brain === 'local' ? 'Connect your model' : brain === 'cloud' ? 'Add your AI key' : 'Connect your ChatGPT plan', to: '/settings/brains' });
  if (onlineEd && voice === 'own') followUps.push({ label: 'Connect your voices', to: '/settings/voices' });
  // no AI on the way: say what the hosts do meanwhile
  const scriptedForNow = brain === 'later' || (brain === 'included' && !plan?.includes.brain);

  return (
    <div className="aw-bare aw-onb">
      <div className="aw-onb__inner" key={id}>
        {step > 0 && (
          <div className="aw-onb__progress" aria-label={`Step ${step} of ${STEPS.length - 1}`}>
            {STEPS.slice(1).map((s, i) => (
              <span key={s} className={cx('aw-onb__dot', i + 1 <= step && 'aw-onb__dot--on')} />
            ))}
          </div>
        )}

        {id === 'welcome' && (
          <div className="aw-onb__center">
            <div className="aw-bare__mark">
              <BareBackdrop />
              <LogoMark size={52} />
            </div>
            <h1 className="aw-bare__title">Your own radio station</h1>
            <p className="aw-bare__lead">Your music, with AI hosts who talk about the songs, your day and each other.</p>
            <div className="aw-bare__actions">
              <Button variant="primary" size="lg" block iconRight={ArrowRight} onClick={next}>
                Get started
              </Button>
              {!session && !onlineEd && (
                <Button size="lg" block onClick={() => navigate('/sign-in?then=welcome')}>
                  I have an account
                </Button>
              )}
              <Button variant="ghost" size="lg" block onClick={() => void finish('/')}>
                Skip setup
              </Button>
            </div>
            <p className="aw-bare__fine">{onlineEd && session ? `Signed in as ${session.user.email ?? session.user.name}` : 'Works offline. No account needed.'}</p>
          </div>
        )}

        {id === 'name' && (
          <section className="aw-onb__step">
            <h1 className="aw-onb__title">What should your hosts call you?</h1>
            <p className="aw-onb__lead">They say it on air now and then. You can change it in About me.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                next();
              }}
            >
              <TextField label="Your name" value={name} onChange={setName} autoComplete="given-name" placeholder="Alex" autoFocus maxLength={40} />
            </form>
          </section>
        )}

        {id === 'hosts' && (
          <section className="aw-onb__step">
            <h1 className="aw-onb__title">Pick your hosts</h1>
            <p className="aw-onb__lead">Up to four on {station?.name ?? 'your station'}. The first one you pick leads the show.</p>
            <div className="aw-onb-hosts">
              {hosts.map((h) => {
                const at = picked.indexOf(h.id);
                return (
                  <button key={h.id} type="button" aria-pressed={at >= 0} className={cx('aw-onb-host', at >= 0 && 'aw-onb-host--on')} onClick={() => togglePick(h.id)}>
                    <Avatar avatar={h.avatar} name={h.name} size={52} />
                    <span className="aw-onb-host__text">
                      <span className="aw-onb-host__name">
                        {h.name}
                        {at === 0 && <span className="aw-onb-host__lead">Lead</span>}
                      </span>
                      <span className="aw-onb-host__tag">{h.tagline}</span>
                    </span>
                    <span className="aw-onb-option__check" aria-hidden>
                      <Check />
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="aw-onb__fine">Make your own hosts later, with their own voice and personality.</p>
          </section>
        )}

        {id === 'music' && (
          <section className="aw-onb__step">
            <h1 className="aw-onb__title">Where is your music?</h1>
            <p className="aw-onb__lead">Pick where to start. You can mix sources on every station later.</p>
            <OptionList options={musicOptions} value={music} onChange={setMusic} label="Music source" />
          </section>
        )}

        {id === 'brain' && (
          <section className="aw-onb__step">
            <h1 className="aw-onb__title">{onlineEd ? 'How should your hosts think and sound?' : 'How should your hosts think?'}</h1>
            <p className="aw-onb__lead">
              {onlineEd && (plan?.includes.brain || plan?.includes.voices)
                ? 'Your plan is ready to use. You can change this per host any time.'
                : 'Pick the AI your hosts think with. You can change it per host any time.'}
            </p>
            <OptionList options={brainOptions} value={brain} onChange={setBrain} label="Brain" />
            <p className="aw-onb__fine aw-onb__fallback" data-fallback-explainer>
              Until an AI is connected, your hosts read short scripted lines (song, time, weather, your day) so the music never goes quiet. Connect
              one any time in Settings to bring them to life.
            </p>
            {onlineEd && (
              <>
                <p className="aw-onb__lead" style={{ marginTop: 'var(--space-5)' }}>
                  Voices
                </p>
                <OptionList options={voiceOptions} value={voice} onChange={setVoice} label="Voices" />
              </>
            )}
          </section>
        )}

        {id === 'done' && (
          <div className="aw-onb__center">
            <div className="aw-onb__badge" aria-hidden>
              <Music2 />
            </div>
            <h1 className="aw-bare__title">You are on air{name.trim() ? `, ${name.trim()}` : ''}</h1>
            <p className="aw-bare__lead">
              {station?.name ?? 'Your station'} is ready. {followUps.length ? 'One more thing and the show starts.' : 'Press play on Home.'}
            </p>
            {scriptedForNow && (
              <p className="aw-onb__fine" data-fallback-done>
                Until an AI is connected, your hosts read short scripted lines. Connect one any time in Settings.
              </p>
            )}
            <div className="aw-bare__actions">
              {followUps.map((f, i) => (
                <Button key={f.to} variant={i === 0 ? 'primary' : 'secondary'} size="lg" block onClick={() => void finish(f.to)}>
                  {f.label}
                </Button>
              ))}
              <Button variant={followUps.length ? 'ghost' : 'primary'} size="lg" block onClick={() => void finish('/')}>
                {followUps.length ? 'Later, take me home' : 'Start listening'}
              </Button>
            </div>
          </div>
        )}

        {step > 0 && id !== 'done' && (
          <div className="aw-onb__nav">
            <Button variant="ghost" icon={ArrowLeft} onClick={prev}>
              Back
            </Button>
            <span className="aw-onb__spacer" />
            <Button variant="ghost" onClick={next}>
              Skip
            </Button>
            <Button variant="primary" iconRight={ArrowRight} onClick={next}>
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
