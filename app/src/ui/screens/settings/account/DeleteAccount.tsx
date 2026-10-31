import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { auth, isOnline } from '@/core/api';
import { navigate } from '@/state/router';
import { runAction } from '../../../actions';
import { Button, TextField, toast } from '../../../components';
import { ConfirmSheet } from './parts';

/** "Delete account" button + confirm (type DELETE). Server data goes; this device keeps its local copy. */
export function DeleteAccountButton() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
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
        description={`${isOnline() ? 'Your Host-Caster plan, if you have one, is cancelled first (no more charges). Then this' : 'This'} removes your account from the server: synced hosts and stations, saved keys, linked Google and X access, AI app connections and the inbox. Hosts and songs on this device stay.`}
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
            toast.success('Account deleted', 'Host-Caster keeps working on this device.');
            navigate('/settings/account', { replace: true });
          }
        }}
      >
        <TextField label='Type "DELETE" to confirm' value={typed} onChange={setTyped} autoCapitalize="characters" autoComplete="off" />
      </ConfirmSheet>
    </>
  );
}
