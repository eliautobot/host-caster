import { useEffect, useState } from 'react';
import { AtSign, LogIn } from 'lucide-react';
import { integrations, type ImapSettings } from '@/core/api';
import { navigate } from '@/state/router';
import { useSession } from '@/state/session';
import { useSettings } from '@/state/settings';
import { runAction } from '../../../actions';
import { Button, Select, TextField, Toggle, toast } from '../../../components';
import { Actions, ConfirmSheet, Hint, SectionCard, errorText, useLoad } from '../account/parts';
import { emailOnForStations } from './emailOn';

const PRESETS: { value: string; label: string; host: string; port: number; note?: string }[] = [
  { value: 'custom', label: 'Other (enter the server)', host: '', port: 993 },
  { value: 'fastmail', label: 'Fastmail', host: 'imap.fastmail.com', port: 993, note: 'Use an app password from Settings, Privacy & Security.' },
  { value: 'icloud', label: 'iCloud Mail', host: 'imap.mail.me.com', port: 993, note: 'Use an app-specific password from account.apple.com.' },
  { value: 'outlook', label: 'Outlook / Microsoft 365', host: 'outlook.office365.com', port: 993, note: 'Needs IMAP turned on and an app password.' },
  { value: 'yahoo', label: 'Yahoo Mail', host: 'imap.mail.yahoo.com', port: 993, note: 'Use an app password from Account security.' },
  { value: 'gmail', label: 'Gmail (prefer Google above)', host: 'imap.gmail.com', port: 993, note: 'Needs 2-step verification and an app password.' },
];

export function ImapSection() {
  const session = useSession((s) => s.session);
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const saved = useLoad(() => (session ? integrations.imap.get() : Promise.resolve({ configured: false as const })), [session?.user.id]);
  const [preset, setPreset] = useState('custom');
  const [form, setForm] = useState<ImapSettings & { password: string }>({ host: '', port: 993, secure: true, user: '', password: '' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save'>();
  const [result, setResult] = useState<string>();
  const [remove, setRemove] = useState(false);
  const cfg = saved.data?.configured ? saved.data : undefined;
  const enabled = Boolean(connections.email?.imap);

  useEffect(() => {
    if (cfg) setForm((f) => ({ ...f, host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user }));
  }, [cfg?.host, cfg?.user]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) {
    return (
      <SectionCard icon={AtSign} title="Other email (IMAP)" status="Sign in to connect a mailbox">
        <Actions>
          <Button icon={LogIn} onClick={() => navigate('/sign-in')}>
            Sign in
          </Button>
        </Actions>
      </SectionCard>
    );
  }

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const pick = (v: string) => {
    setPreset(v);
    const p = PRESETS.find((x) => x.value === v);
    if (p && p.host) set({ host: p.host, port: p.port, secure: true });
  };
  const body = () => ({ ...form, password: form.password || undefined });
  const test = async () => {
    setBusy('test');
    setResult(undefined);
    try {
      const r = await integrations.imap.test(body());
      setResult(`It works: ${r.unread} unread in the inbox.`);
    } catch (err) {
      setResult(errorText(err));
    } finally {
      setBusy(undefined);
    }
  };
  const save = async () => {
    setBusy('save');
    const ok = await runAction(async () => {
      const r = await integrations.imap.save(body());
      await update({ connections: { ...connections, email: { gmail: connections.email?.gmail ?? false, imap: true } } });
      toast.success('Mailbox connected', `${r.unread} unread`);
      await emailOnForStations();
    });
    setBusy(undefined);
    if (ok) {
      setEditing(false);
      set({ password: '' });
      saved.reload();
    }
  };
  const note = PRESETS.find((p) => p.value === preset)?.note;

  return (
    <SectionCard
      icon={AtSign}
      title="Other email (IMAP)"
      status={cfg ? `${cfg.user} on ${cfg.host}` : 'Fastmail, iCloud, Outlook, your own mail server'}
      badge={cfg ? { label: enabled ? 'On' : 'Paused', tone: enabled ? 'ok' : 'neutral', dot: enabled } : undefined}
    >
      {cfg && !editing ? (
        <>
          <Toggle
            label="Hosts mention new mail"
            description="Unread mail in the inbox: who wrote and the subject. Flagged mail first."
            checked={enabled}
            onChange={(on) =>
              void update({ connections: { ...connections, email: { gmail: connections.email?.gmail ?? false, imap: on } } }).then(() => (on ? emailOnForStations() : undefined))
            }
          />
          <Actions>
            <Button onClick={() => void test()} loading={busy === 'test'}>
              Check
            </Button>
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="ghost" onClick={() => setRemove(true)}>
              Remove
            </Button>
          </Actions>
          {result && <Hint>{result}</Hint>}
        </>
      ) : (
        <form
          className="aw-acct-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Select label="Provider" value={preset} options={PRESETS.map(({ value, label }) => ({ value, label }))} onChange={pick} />
          <div className="aw-acct-form__row aw-acct-form__row--split">
            <TextField label="IMAP server" value={form.host} onChange={(v) => set({ host: v })} placeholder="imap.example.com" autoCapitalize="off" spellCheck={false} required />
            <TextField label="Port" value={String(form.port)} onChange={(v) => set({ port: Number(v.replace(/\D/g, '')) || 0 })} inputMode="numeric" />
          </div>
          <div className="aw-acct-form__row aw-acct-form__row--two">
            <TextField label="User name" value={form.user} onChange={(v) => set({ user: v })} autoComplete="username" autoCapitalize="off" spellCheck={false} required />
            <TextField
              label="Password"
              type="password"
              value={form.password}
              onChange={(v) => set({ password: v })}
              autoComplete="off"
              placeholder={cfg ? 'Unchanged' : ''}
              required={!cfg}
            />
          </div>
          <Toggle label="Secure connection (TLS)" checked={form.secure} onChange={(on) => set({ secure: on, port: on ? 993 : 143 })} />
          {note && <Hint>{note}</Hint>}
          {result && <Hint>{result}</Hint>}
          <Actions>
            <Button type="submit" variant="primary" loading={busy === 'save'}>
              Save
            </Button>
            <Button onClick={() => void test()} loading={busy === 'test'}>
              Test
            </Button>
            {cfg && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </Actions>
          <Hint>The password is stored encrypted on your Host-Caster server and never shown again. Read-only: Host-Caster never sends or deletes mail.</Hint>
        </form>
      )}
      <ConfirmSheet
        open={remove}
        onClose={() => setRemove(false)}
        title="Remove this mailbox?"
        description="The server forgets the address and password."
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          if (
            await runAction(async () => {
              await integrations.imap.remove();
              await update({ connections: { ...connections, email: { gmail: connections.email?.gmail ?? false, imap: false } } });
            })
          ) {
            setRemove(false);
            setResult(undefined);
            saved.reload();
          }
        }}
      />
    </SectionCard>
  );
}
