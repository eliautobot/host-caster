import { useState } from 'react';
import { Server } from 'lucide-react';
import { api } from '@/core/api';
import { isNative } from '@/core/native';
import { useSession } from '@/state/session';
import { runAction } from '../../../actions';
import { Button, TextField, toast } from '../../../components';
import { Actions, Hint, SectionCard } from './parts';
import { serverLabel, setServerUrl } from './server';

/** The Host-Caster server this device uses: status, version, change address. */
export function ServerCard() {
  const available = useSession((s) => s.available);
  const config = useSession((s) => s.config);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(api.baseUrl);
  const [busy, setBusy] = useState(false);
  const label = serverLabel();

  const save = async () => {
    setBusy(true);
    await runAction(async () => {
      const cfg = await setServerUrl(url);
      if (cfg) {
        toast.success('Server connected', `Host-Caster ${cfg.version}`);
        setEditing(false);
      } else {
        toast.error('No Host-Caster server there', 'Check the address. It should open the Host-Caster web app in a browser.');
      }
    });
    setBusy(false);
  };

  return (
    <SectionCard
      icon={Server}
      title="Your Host-Caster server"
      status={available ? `${label || 'This server'} · Host-Caster ${config?.version ?? ''}` : label ? `${label} is not answering` : 'No server set'}
      badge={available ? { label: 'Online', tone: 'ok', dot: true } : { label: 'Offline', tone: 'neutral' }}
    >
      <p className="aw-acct-desc">
        The server keeps your account, syncs your hosts and stations, and reads your calendar and mail for the hosts.
        {available && config ? ` Sign-in here: ${[config.signIn.google && 'Google', config.signIn.x && 'X', config.signIn.local && 'email and password'].filter(Boolean).join(', ') || 'none set up yet'}.` : ''}
      </p>
      {editing ? (
        <div className="aw-acct-form">
          <TextField
            label="Server address"
            placeholder="https://radio.example.com"
            value={url}
            onChange={setUrl}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            hint={isNative ? 'The address you open Host-Caster at in a browser. Leave empty for Host-Caster.' : 'Leave empty to use the server this page came from.'}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
          <Actions>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Connect
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </Actions>
        </div>
      ) : (
        <Actions>
          <Button onClick={() => setEditing(true)}>{label ? 'Change server' : 'Set server'}</Button>
          {!available && (
            <Button variant="ghost" onClick={() => void api.probe()}>
              Try again
            </Button>
          )}
        </Actions>
      )}
      {!available && !editing && (
        <Hint>Everything keeps working on this device. Sync, calendar and email come back when the server does.</Hint>
      )}
    </SectionCard>
  );
}
