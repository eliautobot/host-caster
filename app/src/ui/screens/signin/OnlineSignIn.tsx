// Sign in to the Host-Caster online service: a one-time code by email, or Google, Apple, X. One account works on the
// web, Android and iPhone. An account without a confirmed email (X) confirms one here before anything else.
import { useState } from 'react';
import { ArrowLeft, Mail, TriangleAlert } from 'lucide-react';
import { api, auth, online, signInErrorText } from '@/core/api';
import { isDesktop, isNative, sellsPlans } from '@/core/native';
import { navigate } from '@/state/router';
import { useSession } from '@/state/session';
import { runAction } from '../../actions';
import { signOutAndRestart } from '../../account/signOut';
import { Button, LogoMark, TextField, toast } from '../../components';
import { GoogleMark, XMark } from '../settings/account/marks';
import { BareBackdrop } from '../parts/BareBackdrop';
import { AppleMark } from './AppleMark';
import { SignInAgreement } from '../../online/legal';
import '../Bare.css';
import '../SignIn.css';
import '../../online/online.css';

function EmailCode({ confirming, onDone }: { confirming: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<{ minutes: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await online.startEmail(email.trim());
      setSent({ minutes: res.minutes });
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const s = await online.verifyEmail(email.trim(), code.trim());
      toast.success(confirming ? 'Email confirmed' : `Signed in as ${s.user.name || s.user.email}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!sent) {
    return (
      <form
        className="aw-signin__form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
          autoCapitalize="off"
          spellCheck={false}
          placeholder="you@example.com"
          error={error}
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={Mail}>
          {confirming ? 'Send a code' : 'Continue with email'}
        </Button>
      </form>
    );
  }
  return (
    <form
      className="aw-signin__form"
      onSubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
    >
      <p className="aw-signin__note" data-code-sent>
        We sent a 6-digit code to <strong>{email.trim()}</strong>. It works for {sent.minutes} minutes.
      </p>
      <TextField
        label="Code"
        className="aw-code-input"
        value={code}
        onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        required
        placeholder="000000"
        error={error}
      />
      <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={code.length !== 6}>
        {confirming ? 'Confirm email' : 'Sign in'}
      </Button>
      <button type="button" className="aw-signin__switch" onClick={() => setSent(undefined)}>
        Use another email or send a new code
      </button>
    </form>
  );
}

/** Where to go once signed in: plans on the first visit, otherwise onboarding or home (the session store decides). */
function goOn() {
  navigate('/', { replace: true });
}

export function OnlineSignIn({ error: errorCode }: { error?: string }) {
  const config = useSession((s) => s.config);
  const session = useSession((s) => s.session);
  const [busy, setBusy] = useState<string>();
  const [emailMode, setEmailMode] = useState(false);
  const confirming = Boolean(session && !session.user.emailVerified);
  const error = errorCode ? signInErrorText(errorCode) : undefined;
  const google = config?.signIn.google;
  const x = config?.signIn.x;
  const apple = config?.online?.signIn.apple;

  const oauth = async (provider: 'google' | 'x' | 'apple') => {
    setBusy(provider);
    await runAction(async () => {
      const s = await auth.signIn(provider, undefined, { returnTo: '/' });
      if (s) goOn();
    });
    setBusy(undefined);
  };

  return (
    <div className="aw-bare">
      <div className="aw-bare__inner">
        <div className="aw-bare__mark">
          <BareBackdrop />
          <LogoMark size={52} />
        </div>
        {confirming ? (
          <>
            <h1 className="aw-bare__title">Confirm your email</h1>
            <p className="aw-bare__lead">Host-Caster accounts need a confirmed email, for your receipts and to sign in on your other devices.</p>
            <div className="aw-bare__actions">
              <EmailCode confirming onDone={goOn} />
              <Button variant="ghost" block onClick={() => void runAction(() => signOutAndRestart())}>
                Sign out
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="aw-bare__title">Sign in to Host-Caster</h1>
            <p className="aw-bare__lead">
              {isDesktop
                ? 'Your personal AI radio. The same account as on the web and your phone.'
                : 'Your personal AI radio. One account for the web, Android and iPhone.'}
            </p>
            {error && (
              <p className="aw-signin__error" role="alert">
                <TriangleAlert aria-hidden />
                {error}
              </p>
            )}
            <div className="aw-bare__actions">
              {emailMode ? (
                <>
                  <EmailCode confirming={false} onDone={goOn} />
                  <Button variant="ghost" icon={ArrowLeft} block onClick={() => setEmailMode(false)}>
                    Other ways to sign in
                  </Button>
                </>
              ) : (
                <>
                  {google && (
                    <Button size="lg" block loading={busy === 'google'} onClick={() => void oauth('google')} className="aw-signin__provider">
                      <GoogleMark />
                      Continue with Google
                    </Button>
                  )}
                  {apple && (
                    <Button size="lg" block loading={busy === 'apple'} onClick={() => void oauth('apple')} className="aw-signin__provider">
                      <AppleMark />
                      Continue with Apple
                    </Button>
                  )}
                  {x && (
                    <Button size="lg" block loading={busy === 'x'} onClick={() => void oauth('x')} className="aw-signin__provider">
                      <XMark />
                      Continue with X
                    </Button>
                  )}
                  <Button size="lg" block icon={Mail} variant={google || apple || x ? 'secondary' : 'primary'} onClick={() => setEmailMode(true)}>
                    Continue with email
                  </Button>
                </>
              )}
            </div>
            <p className="aw-bare__fine">
              {api.available
                ? `New here? Signing in creates your account.${sellsPlans ? ' Free to start, cancel a plan anytime.' : ''}`
                : 'Host-Caster is not answering right now. Try again in a moment.'}
              {isNative || isDesktop ? ` · ${api.baseUrl}` : ''}
            </p>
            <SignInAgreement />
          </>
        )}
      </div>
    </div>
  );
}
