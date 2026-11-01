import { useState } from 'react';
import { ArrowLeft, Mail, Server, TriangleAlert } from 'lucide-react';
import { api, auth, signInErrorText, usesBearer } from '@/core/api';
import { getSettings } from '@/core/db';
import { isDesktop, isNative } from '@/core/native';
import type { ApiSession } from '@/core/types';
import { back, navigate } from '@/state/router';
import { useSession, waitForFirstSync } from '@/state/session';
import { runAction } from '../actions';
import { Button, LogoMark, TextField, toast } from '../components';
import { GoogleMark, XMark } from './settings/account/marks';
import { serverLabel, setServerUrl } from './settings/account/server';
import { BareBackdrop } from './parts/BareBackdrop';
import { OnlineSignIn } from './signin/OnlineSignIn';
import type { ScreenProps } from '.';
import './Bare.css';
import './SignIn.css';

/** Where to go once signed in: back to onboarding (if it sent us) or the page before. */
async function afterSignIn(session: ApiSession | undefined, then?: string) {
  if (!session) return;
  toast.success(`Signed in as ${session.user.name || session.user.email || 'you'}`);
  // the account may have finished onboarding on another device: let its settings come down first
  if (then === 'welcome') await waitForFirstSync();
  const { onboarded } = await getSettings();
  if (then === 'welcome' && !onboarded) navigate('/welcome?step=1', { replace: true });
  else back('/');
}

function LocalForm({ then, signupsOpen }: { then?: string; signupsOpen: boolean }) {
  const [create, setCreate] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const session = await auth.signIn('local', { email, password, name, create });
      await afterSignIn(session, then);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="aw-signin__form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {create && <TextField label="Your name" value={name} onChange={setName} autoComplete="name" placeholder="What the hosts call you" />}
      <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required autoCapitalize="off" spellCheck={false} />
      <TextField
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete={create ? 'new-password' : 'current-password'}
        required
        minLength={create ? 8 : undefined}
        hint={create ? 'At least 8 characters.' : undefined}
        error={error}
      />
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        {create ? 'Create account' : 'Sign in'}
      </Button>
      {signupsOpen && (
        <button type="button" className="aw-signin__switch" onClick={() => setCreate((c) => !c)}>
          {create ? 'I already have an account' : 'New here? Create an account'}
        </button>
      )}
    </form>
  );
}

function ServerField({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState(api.baseUrl);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="aw-signin__form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await runAction(async () => {
          const cfg = await setServerUrl(url);
          if (!cfg) throw new Error('No Host-Caster server answered at that address.');
          onDone();
        });
        setBusy(false);
      }}
    >
      <TextField
        label="Host-Caster server"
        placeholder="https://radio.example.com"
        value={url}
        onChange={setUrl}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        icon={Server}
        hint={isNative || isDesktop ? 'Your own server, or the one a friend runs for you. Leave empty for Host-Caster.' : 'Leave empty for the server this page came from.'}
      />
      <Button type="submit" size="lg" block loading={busy}>
        Connect
      </Button>
    </form>
  );
}

/** Sign in (owner: server agent). Buttons follow GET /api/config. */
export default function SignIn({ query }: ScreenProps) {
  const config = useSession((s) => s.config);
  const available = useSession((s) => s.available);
  const session = useSession((s) => s.session);
  const [mode, setMode] = useState<'buttons' | 'local' | 'server'>(available || api.baseUrl || !(isNative || isDesktop) ? 'buttons' : 'server');
  const [busy, setBusy] = useState<string>();
  // the hosted Host-Caster service: email codes, Google, Apple, X; an account is required
  if (config?.edition === 'online') return <OnlineSignIn error={query.error} />;
  const then = query.then;
  const error = query.error ? signInErrorText(query.error) : undefined;
  // OAuth needs a redirect back to this origin (or the app's hostcaster:// link: phones and the desktop app); a web page
  // pointed at another server can only use passwords there.
  const oauthHere = isNative || isDesktop || !usesBearer();
  const google = available && config?.signIn.google && oauthHere;
  const x = available && config?.signIn.x && oauthHere;
  const local = available && config?.signIn.local;
  const none = available && !google && !x && !local;

  const oauth = async (provider: 'google' | 'x') => {
    setBusy(provider);
    await runAction(async () => afterSignIn(await auth.signIn(provider, undefined, { returnTo: then === 'welcome' ? '/welcome?step=1' : '/' }), then));
    setBusy(undefined);
  };

  const leave = () => (then === 'welcome' ? navigate('/welcome?step=1', { replace: true }) : back('/'));

  return (
    <div className="aw-bare">
      <div className="aw-bare__inner">
        <div className="aw-bare__mark">
          <BareBackdrop />
          <LogoMark size={52} />
        </div>
        {session ? (
          <>
            <h1 className="aw-bare__title">You are signed in</h1>
            <p className="aw-bare__lead">
              {session.user.name || session.user.email}. Your hosts and stations sync to {serverLabel() || 'your server'}.
            </p>
            <div className="aw-bare__actions">
              <Button variant="primary" size="lg" block onClick={leave}>
                Continue
              </Button>
              <Button variant="ghost" size="lg" block onClick={() => navigate('/settings/account')}>
                Account settings
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="aw-bare__title">{mode === 'server' ? 'Find your server' : 'Sign in to sync'}</h1>
            <p className="aw-bare__lead">
              {mode === 'server'
                ? 'Host-Caster signs in through a Host-Caster server. Enter its address.'
                : 'Keep your hosts and stations on every device and let them read your calendar.'}
            </p>
            {error && mode !== 'server' && (
              <p className="aw-signin__error" role="alert">
                <TriangleAlert aria-hidden />
                {error}
              </p>
            )}
            <div className="aw-bare__actions">
              {mode === 'buttons' && (
                <>
                  {google && (
                    <Button size="lg" block loading={busy === 'google'} onClick={() => void oauth('google')} className="aw-signin__provider">
                      <GoogleMark />
                      Continue with Google
                    </Button>
                  )}
                  {x && (
                    <Button size="lg" block loading={busy === 'x'} onClick={() => void oauth('x')} className="aw-signin__provider">
                      <XMark />
                      Continue with X
                    </Button>
                  )}
                  {local && (
                    <Button size="lg" block icon={Mail} variant={google || x ? 'ghost' : 'secondary'} onClick={() => setMode('local')}>
                      {google || x ? 'Use email and password' : 'Sign in with email'}
                    </Button>
                  )}
                  {!available && (
                    <p className="aw-signin__note">
                      {api.baseUrl || !(isNative || isDesktop) ? `${serverLabel() || 'The server'} is not answering right now.` : 'No server set yet.'}
                    </p>
                  )}
                  {none && <p className="aw-signin__note">This server has no sign-in set up yet. Its owner can add Google, X or local accounts.</p>}
                </>
              )}
              {mode === 'local' && <LocalForm then={then} signupsOpen={config?.signups !== false} />}
              {mode === 'server' && <ServerField onDone={() => setMode('buttons')} />}
              {mode !== 'buttons' && (available || mode === 'local') && (
                <Button variant="ghost" icon={ArrowLeft} block onClick={() => setMode('buttons')}>
                  Other ways to sign in
                </Button>
              )}
              <div className="aw-bare__divider">or</div>
              <Button variant="ghost" size="lg" block onClick={leave}>
                Use on this device only
              </Button>
            </div>
            <p className="aw-bare__fine">
              {available ? `Server: ${serverLabel() || 'this one'} · Host-Caster ${config?.version ?? ''}` : 'Local mode works offline, with no account.'}
              {mode !== 'server' && (
                <>
                  {' · '}
                  <button type="button" className="aw-signin__link" onClick={() => setMode('server')}>
                    Change server
                  </button>
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
