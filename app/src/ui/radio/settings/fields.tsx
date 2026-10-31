import { useState } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { api } from '@/core/api';
import type { Transport } from '@/core/types';
import { IconButton, Tabs, TextField } from '../../components';

export function KeyField({ value, onChange, keyUrl, required }: { value: string; onChange: (v: string) => void; keyUrl?: string; required?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <TextField
      label={required ? 'API key' : 'API key (optional)'}
      type={show ? 'text' : 'password'}
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={onChange}
      placeholder={required ? 'Paste your key' : 'Only if your server needs one'}
      trailing={<IconButton icon={show ? EyeOff : Eye} label={show ? 'Hide key' : 'Show key'} size="sm" onClick={() => setShow(!show)} />}
      hint={
        keyUrl ? (
          <a href={keyUrl} target="_blank" rel="noreferrer" className="aw-textlink">
            Get a key <ExternalLink size={11} style={{ display: 'inline', verticalAlign: '-1px' }} aria-hidden />
          </a>
        ) : (
          'Stays on this device unless it runs through your Host-Caster server.'
        )
      }
    />
  );
}

export function TransportField({ value, onChange, deviceOnly }: { value: Transport; onChange: (t: Transport) => void; deviceOnly?: boolean }) {
  const signedIn = api.available && Boolean(api.session);
  if (deviceOnly) {
    // online edition: the service never dials home networks, so a model on your computer connects from here
    return (
      <div className="aw-field" data-device-only>
        <span className="aw-field__label">Connect from</span>
        <p className="aw-field__hint">
          This device. The Host-Caster service cannot reach your computer or home network, so local models and voice servers connect straight from this device
          (on a phone, keep it on the same Wi-Fi).
        </p>
      </div>
    );
  }
  return (
    <div className="aw-field">
      <span className="aw-field__label">Connect from</span>
      <Tabs
        variant="segmented"
        label="Connect from"
        value={value}
        onChange={onChange}
        items={[
          { value: 'device', label: 'This device' },
          { value: 'server', label: 'Host-Caster server' },
        ]}
      />
      <p className="aw-field__hint">
        {value === 'device'
          ? 'Calls go straight from this device. Best for models on your own network.'
          : signedIn
            ? 'Your server keeps the key and makes the calls. Works on every device you sign in to.'
            : 'Sign in to your Host-Caster server first (Settings > Account).'}
      </p>
    </div>
  );
}
