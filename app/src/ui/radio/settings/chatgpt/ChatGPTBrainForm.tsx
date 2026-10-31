import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { isNative } from '@/core/native';
import type { Brain, Draft } from '@/core/types';
import { navigate } from '@/state/router';
import { Button, Select, TextField } from '../../../components';
import { StatusLine } from '../../form';
import { ChatGPTMark } from './ChatGPTMark';
import { ContinueWithChatGPT, UsageLimit, UsingPlan } from './ChatGPTParts';
import type { ChatGPTState } from './useChatGPT';

type BrainDraft = Draft<Brain>;

function SignInFirst() {
  return (
    <div className="aw-cgpt-intro">
      <p className="aw-cgpt-intro__title">Sign in to your Host-Caster server first</p>
      <p className="aw-cgpt-intro__text">
        Your ChatGPT plan runs through your Host-Caster server, which keeps the ChatGPT sign-in safe for you. It works on
        every device you sign in to.
      </p>
      <div className="aw-cgpt-intro__actions">
        <Button variant="primary" onClick={() => navigate('/sign-in')}>
          Sign in
        </Button>
      </div>
    </div>
  );
}

function Waiting({ cg }: { cg: ChatGPTState }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const p = cg.pending!;
  // the server's own 127.0.0.1 catches the answer only when this browser runs on that computer (not a phone)
  const sameMachine = p.start.listening && !isNative && !window.matchMedia('(pointer: coarse)').matches;
  const submit = async () => {
    setBusy(true);
    await cg.paste(url);
    setBusy(false);
  };
  return (
    <div className="aw-cgpt-wait" aria-live="polite">
      <p className="aw-cgpt-wait__head">
        <Loader2 className="aw-cgpt-spin" size={18} aria-hidden /> Finish signing in in the ChatGPT tab
      </p>
      {p.blocked && (
        <p className="aw-cgpt-intro__text">
          Your browser blocked the new tab.{' '}
          <a className="aw-textlink" href={p.start.authorizeUrl} target="_blank" rel="noopener noreferrer">
            Open the ChatGPT sign-in
          </a>
        </p>
      )}
      <ol className="aw-cgpt-wait__steps">
        <li>Sign in to ChatGPT and allow Host-Caster to use your plan.</li>
        <li>
          {p.local
            ? 'Host-Caster comes back by itself. '
            : sameMachine
              ? 'On the computer that runs Host-Caster this finishes by itself. '
              : ''}
          If the tab then shows a page that cannot be reached, copy its address (it starts with{' '}
          <code>http://127.0.0.1</code>) and paste it here.
        </li>
      </ol>
      <div className="aw-cgpt-paste">
        <TextField
          label="Address from the ChatGPT tab"
          value={url}
          placeholder="http://127.0.0.1:1455/auth/callback?code=..."
          spellCheck={false}
          autoComplete="off"
          onChange={setUrl}
        />
        <Button variant="primary" loading={busy} disabled={!url.trim()} onClick={submit}>
          Connect
        </Button>
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={cg.cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Connect({ cg }: { cg: ChatGPTState }) {
  const s = cg.status;
  const email = s?.account?.email;
  const [title, text, opts] =
    s?.status === 'not_enabled'
      ? [
          'ChatGPT plan use is off for Host-Caster',
          `You signed in${email ? ` as ${email}` : ''} but did not allow Host-Caster to use your plan. Turn it on, or use an API key brain instead.`,
          { reconsent: true },
        ]
      : s?.status === 'expired'
        ? ['Your ChatGPT sign-in expired', 'ChatGPT ended the sign-in, or Host-Caster was removed in ChatGPT settings. Continue with ChatGPT to connect again.', {}]
        : [
            'Use your ChatGPT plan',
            'Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance. Works with eligible paid plans such as Plus and Pro. Host-Caster itself never charges you.',
            {},
          ];
  return (
    <div className="aw-cgpt-intro">
      <p className="aw-cgpt-intro__title">{title}</p>
      <p className="aw-cgpt-intro__text">{text}</p>
      <div className="aw-cgpt-intro__actions">
        <ContinueWithChatGPT onClick={() => void cg.begin(opts)} />
        {s?.account && s.status !== 'not_enabled' && (
          <Button variant="ghost" size="sm" onClick={() => void cg.begin({ fresh: true })}>
            Use a different ChatGPT account
          </Button>
        )}
      </div>
      {s?.account && s.status === 'signed_out' && <p className="aw-field__hint">Last connected: {email ?? s.account.name}.</p>}
    </div>
  );
}

function Account({ cg }: { cg: ChatGPTState }) {
  const a = cg.status?.account;
  const [busy, setBusy] = useState(false);
  return (
    <div className="aw-cgpt-account">
      <span className="aw-cgpt-tile">
        <ChatGPTMark />
      </span>
      <div className="aw-cgpt-account__text">
        <p className="aw-cgpt-account__name">{a?.name || a?.email || 'ChatGPT account'}</p>
        <p className="aw-cgpt-account__meta">
          <span className={`aw-cgpt-dot${cg.status?.limitedUntil ? ' aw-cgpt-dot--warn' : ''}`} aria-hidden />
          {cg.status?.limitedUntil ? 'Connected · usage limit reached' : 'Connected'}
          {a?.name && a.email ? ` · ${a.email}` : ''}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await cg.disconnect();
          setBusy(false);
        }}
      >
        Disconnect
      </Button>
    </div>
  );
}

/** The ChatGPT plan brain: connect, connected account, model, usage. */
export function ChatGPTBrainForm({ cg, draft, set }: { cg: ChatGPTState; draft: BrainDraft; set: (patch: Partial<BrainDraft>) => void }) {
  const connected = Boolean(cg.status?.connected);
  const { models, loadModels } = cg;

  useEffect(() => {
    if (!connected || models) return;
    void loadModels().then((list) => {
      if (list[0] && !list.some((m) => m.slug === draft.model)) set({ model: list[0].slug });
    });
    // only when the connection or catalog changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, models]);

  if (!cg.signedIn) return <SignInFirst />;
  if (!cg.serverOn || cg.status?.enabled === false) {
    return <StatusLine tone="muted">This Host-Caster server has ChatGPT plan brains turned off.</StatusLine>;
  }
  if (cg.loading && !cg.status) return <StatusLine tone="muted">Checking your ChatGPT connection...</StatusLine>;

  const options = (models ?? []).map((m) => ({ value: m.slug, label: m.displayName }));
  if (draft.model && !options.some((o) => o.value === draft.model)) options.unshift({ value: draft.model, label: draft.model });

  return (
    <div className="aw-cgpt">
      {cg.pending ? <Waiting cg={cg} /> : connected ? <Account cg={cg} /> : <Connect cg={cg} />}
      {cg.error && <StatusLine tone="error">{cg.error}</StatusLine>}
      {connected && !cg.pending && (
        <>
          {cg.status?.limitedUntil && <UsageLimit />}
          <TextField label="Name" value={draft.name} onChange={(name) => set({ name })} />
          {options.length ? (
            <Select label="Model" value={draft.model} onChange={(model) => set({ model })} options={options} />
          ) : (
            <StatusLine tone="muted">Loading the models on your plan...</StatusLine>
          )}
          <UsingPlan />
        </>
      )}
    </div>
  );
}
