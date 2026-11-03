import { useState, type ReactNode } from 'react';
import { Cloud, CloudOff, CreditCard, KeyRound, LogOut, MonitorSmartphone, RefreshCw, UserRound } from 'lucide-react';
import { isDesktop, isNative, sellsPlans } from '@/core/native';
import { usePlan } from '@/state/plan';
import { dateText, planName } from '../../online/parts';
import { auth, request, sync } from '@/core/api';
import type { ApiIdentity, SignInProvider } from '@/core/types';
import { navigate } from '@/state/router';
import { useSession } from '@/state/session';
import { runAction } from '../../actions';
import { useJoinPrompt } from '../../account/JoinQuestion';
import { signOutAndRestart } from '../../account/signOut';
import { Button, TextField, toast } from '../../components';
import { AccountAvatar } from './account/AccountAvatar';
import { DeleteAccountButton } from './account/DeleteAccount';
import { GoogleMark, XMark } from './account/marks';
import { Actions, ConfirmSheet, Hint, SectionCard, timeAgo } from './account/parts';
import { ServerCard } from './account/ServerCard';
import './account/account.css';

const SCOPE_NAME: Record<string, string> = { calendar: 'Calendar', gmail: 'Gmail', youtube: 'YouTube' };

function SyncLine() {
  const s = useSession((x) => x.sync);
  switch (s.status) {
    case 'syncing':
      return <>Syncing…</>;
    case 'offline':
      return <>Offline. Changes sync when the server is back.</>;
    case 'error':
      return <>Sync problem: {s.error}</>;
    case 'idle':
      return s.songsRefused ? (
        <>
          Synced {timeAgo(s.lastSyncedAt)}. {s.songsRefused.toLocaleString()} songs stay on this device only: your account holds{' '}
          {(s.songsMax ?? 0).toLocaleString()} synced songs and lists.
        </>
      ) : (
        <>Synced {timeAgo(s.lastSyncedAt)}</>
      );
    case 'choice':
      return <>Waiting for your answer: add the stations and hosts on this device to your account?</>;
    default:
      return <>Not syncing</>;
  }
}

function PasswordSheet({ open, onClose, hasPassword, needEmail }: { open: boolean; onClose: () => void; hasPassword: boolean; needEmail: boolean }) {
  const [email, setEmail] = useState('');
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={hasPassword ? 'Change password' : 'Add a password'}
      description="Sign in with your email and this password too, for example on a device without Google or X."
      confirmLabel="Save password"
      onConfirm={async () => {
        const ok = await runAction(() => auth.setPassword(password, { email: needEmail ? email : undefined, current: hasPassword ? current : undefined }));
        if (ok) {
          toast.success('Password saved');
          onClose();
        }
      }}
    >
      <div className="aw-acct-form">
        {needEmail && <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />}
        {hasPassword && <TextField label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />}
        <TextField label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters." />
      </div>
    </ConfirmSheet>
  );
}

function SignInMethods() {
  const session = useSession((s) => s.session)!;
  const config = useSession((s) => s.config);
  const [pw, setPw] = useState(false);
  const user = session.user;
  const ids = user.identities ?? [];
  const byProvider = (p: 'google' | 'x'): ApiIdentity | undefined => ids.find((i) => i.provider === p);
  const ways = ids.length + (user.hasPassword ? 1 : 0);

  const unlink = (p: SignInProvider, label: string) =>
    runAction(() => auth.unlink(p), { success: `${label} removed` });

  const rows: { key: string; icon: ReactNode; title: string; sub: string; action: ReactNode }[] = [];
  for (const p of ['google', 'x'] as const) {
    const on = p === 'google' ? config?.signIn.google : config?.signIn.x;
    const id = byProvider(p);
    if (!on && !id) continue;
    const label = p === 'google' ? 'Google' : 'X';
    rows.push({
      key: p,
      icon: p === 'google' ? <GoogleMark size={16} /> : <XMark size={14} />,
      title: label,
      sub: id ? [id.label, id.scopes.map((s) => SCOPE_NAME[s]).filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'Linked' : 'Not linked',
      action: id ? (
        <Button size="sm" variant="ghost" disabled={ways <= 1} title={ways <= 1 ? 'Your only way to sign in' : undefined} onClick={() => void unlink(p, label)}>
          Unlink
        </Button>
      ) : (
        <Button size="sm" onClick={() => void runAction(() => auth.link(p))}>
          Link
        </Button>
      ),
    });
  }
  if (config?.signIn.local || user.hasPassword) {
    rows.push({
      key: 'local',
      icon: <KeyRound aria-hidden />,
      title: 'Password',
      sub: user.hasPassword ? (user.email ?? 'Set') : 'Not set',
      action: (
        <span className="aw-acct-row__end">
          {config?.signIn.local && (
            <Button size="sm" variant={user.hasPassword ? 'ghost' : 'secondary'} onClick={() => setPw(true)}>
              {user.hasPassword ? 'Change' : 'Add'}
            </Button>
          )}
          {user.hasPassword && (
            <Button size="sm" variant="ghost" disabled={ways <= 1} onClick={() => void unlink('local', 'Password')}>
              Remove
            </Button>
          )}
        </span>
      ),
    });
  }
  return (
    <SectionCard icon={KeyRound} title="Ways to sign in" status="Link more than one so you never get locked out.">
      <div className="aw-acct-rows">
        {rows.map((r) => (
          <div key={r.key} className="aw-acct-row">
            <span className="aw-acct-row__icon">{r.icon}</span>
            <span className="aw-acct-row__text">
              <span className="aw-acct-row__title">{r.title}</span>
              <span className="aw-acct-row__sub">{r.sub}</span>
            </span>
            {r.action}
          </div>
        ))}
      </div>
      <PasswordSheet open={pw} onClose={() => setPw(false)} hasPassword={Boolean(user.hasPassword)} needEmail={!user.email} />
    </SectionCard>
  );
}

function Profile() {
  const session = useSession((s) => s.session)!;
  const syncState = useSession((s) => s.sync);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.user.name);
  const [syncing, setSyncing] = useState(false);
  const u = session.user;
  return (
    <SectionCard
      icon={syncState.status === 'offline' || syncState.status === 'error' ? CloudOff : Cloud}
      tone="signal"
      title="Account"
      status={<SyncLine />}
      badge={syncState.status === 'idle' ? { label: 'Synced', tone: 'ok', dot: true } : syncState.status === 'error' ? { label: 'Problem', tone: 'warm' } : undefined}
    >
      <div className="aw-acct-me">
        <AccountAvatar name={u.name || u.email || '?'} url={u.avatarUrl} size={64} />
        <div className="aw-acct-me__text">
          <p className="aw-acct-me__name">{u.name || 'Your account'}</p>
          <p className="aw-acct-me__meta">{u.email ?? u.identities?.find((i) => i.label)?.label ?? ''}</p>
        </div>
      </div>
      {editing && (
        <div className="aw-acct-inline">
          <TextField label="Account name" value={name} onChange={setName} maxLength={80} />
          <Button
            variant="primary"
            onClick={async () => {
              if (await runAction(() => auth.rename(name.trim()), { success: 'Name saved' })) setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      )}
      <p className="aw-acct-desc">Hosts, stations, brains, voices, your profile and settings sync to every device you sign in on. Songs stay on each device.</p>
      <Actions>
        {syncState.status === 'choice' ? (
          <Button onClick={() => useJoinPrompt.setState({ hidden: false })}>Answer now</Button>
        ) : (
          <Button
            icon={RefreshCw}
            loading={syncing}
            onClick={async () => {
              setSyncing(true);
              await sync.syncNow();
              setSyncing(false);
            }}
          >
            Sync now
          </Button>
        )}
        {!editing && (
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Rename
          </Button>
        )}
      </Actions>
    </SectionCard>
  );
}

function Devices() {
  const [confirm, setConfirm] = useState(false);
  const [unsynced, setUnsynced] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const signOut = async (checked: boolean) => {
    setLeaving(true);
    try {
      // what waits goes to the account first; if it cannot, say so before anything leaves this device
      if (!checked && !(await sync.flush().catch(() => false))) return setUnsynced(true);
      await runAction(() => signOutAndRestart());
    } finally {
      setLeaving(false);
    }
  };
  return (
    <SectionCard
      icon={MonitorSmartphone}
      title="Sign out"
      status="Your account keeps your hosts, stations and settings. Signing out removes them from this device; song files and music folders stay."
    >
      <Actions>
        <Button icon={LogOut} loading={leaving} onClick={() => void signOut(false)}>
          Sign out
        </Button>
        <Button variant="ghost" onClick={() => setConfirm(true)}>
          Sign out other devices
        </Button>
        <DeleteAccountButton />
      </Actions>
      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Sign out everywhere else?"
        description="Every other phone, tablet and browser signed in to this account has to sign in again."
        confirmLabel="Sign out others"
        onConfirm={async () => {
          if (await runAction(() => request('DELETE', '/api/me/sessions', { keepThis: true }), { success: 'Other devices signed out' })) setConfirm(false);
        }}
      />
      <ConfirmSheet
        open={unsynced}
        onClose={() => setUnsynced(false)}
        title="Some changes are not in your account yet"
        description="Host-Caster could not reach your account just now. Signing out removes those changes from this device. Try again when you are back online to keep them."
        confirmLabel="Sign out anyway"
        danger
        onConfirm={() => signOut(true)}
      />
    </SectionCard>
  );
}

/** Online edition: the plan at a glance, with the way to the plan page. */
function PlanCard() {
  const status = usePlan((s) => s.status);
  return (
    <SectionCard
      icon={CreditCard}
      tone={status?.plan ? 'signal' : 'neutral'}
      title={`Plan: ${planName(status, status?.plan)}`}
      status={status?.plan ? (status.status === 'canceling' ? `Ends on ${dateText(status.renewsAt)}` : `Renews on ${dateText(status.renewsAt)}`) : 'Bring your own AI and voices'}
    >
      <Actions>
        <Button variant={status?.plan || !sellsPlans ? 'secondary' : 'primary'} onClick={() => navigate('/settings/plan')}>
          {status?.plan || !sellsPlans ? 'Plan and usage' : 'See plans'}
        </Button>
      </Actions>
    </SectionCard>
  );
}

/** Account (owner: server agent): sign-in, sync, server URL, delete account. */
export default function Account() {
  const session = useSession((s) => s.session);
  const ready = useSession((s) => s.ready);
  const available = useSession((s) => s.available);
  const onlineEd = useSession((s) => s.config?.edition === 'online');
  if (!ready) return null;
  return (
    <div className="aw-acct-stack">
      {session ? (
        <>
          <Profile />
          {onlineEd && <PlanCard />}
          <SignInMethods />
          <Devices />
        </>
      ) : (
        <SectionCard icon={UserRound} title="You are in local mode" status="Everything stays on this device.">
          <p className="aw-acct-desc">
            Sign in to sync hosts and stations across devices, keep your AI keys on your server, and let the hosts read your calendar and email.
          </p>
          <Actions>
            <Button variant="primary" onClick={() => navigate('/sign-in')} disabled={!available}>
              Sign in
            </Button>
          </Actions>
          {!available && <Hint>Set a Host-Caster server below to sign in.</Hint>}
        </SectionCard>
      )}
      {/* the hosted web app always talks to its own service */}
      {(!onlineEd || isNative || isDesktop) && <ServerCard />}
    </div>
  );
}
