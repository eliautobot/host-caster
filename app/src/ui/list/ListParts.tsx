// Your list: add your own item, and the settings sheet (what the hosts may keep track of).
import { useState } from 'react';
import { addItem } from '@/core/tracker';
import { navigate } from '@/state/router';
import { useSettings } from '@/state/settings';
import { Button, Sheet, TextField, Toggle, toast } from '../components';
import { errorText } from '../screens/settings/account/parts';

export function AddItem({ onDone }: { onDone: () => void }) {
  const [what, setWhat] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!what.trim()) return;
    setBusy(true);
    try {
      const { op } = await addItem({ what, kind: 'todo', due: due || undefined, dueAllDay: due ? true : undefined, source: { type: 'you', label: 'You added it' } });
      if (op === 'skipped') toast('That one is already on Your list.');
      setWhat('');
      setDue('');
      onDone();
    } catch (err) {
      toast(errorText(err) === 'empty item' ? 'Write a few words first.' : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="aw-list-add"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <TextField label="Something to keep track of" value={what} onChange={setWhat} maxLength={160} placeholder="Send the quotes to Dana" autoFocus />
      <div className="aw-list-add__row">
        <TextField label="Due (optional)" type="date" value={due} onChange={setDue} className="aw-list-add__date" />
        <div className="aw-list-add__buttons">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!what.trim()}>
            Add
          </Button>
        </div>
      </div>
    </form>
  );
}

/** What Your list may be built from (settings.connections.tracker; everything defaults to on). */
export function ListSettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const cfg = connections.tracker ?? {};
  const on = cfg.enabled !== false;
  const save = (patch: NonNullable<typeof connections.tracker>) => void update({ connections: { ...connections, tracker: { ...cfg, ...patch } } });
  return (
    <Sheet open={open} onClose={onClose} size="sm" title="Your list settings" description="What your hosts may keep track of for you.">
      <div className="aw-list-settings">
        <Toggle
          checked={on}
          onChange={(v) => save({ enabled: v })}
          label="Keep Your list"
          description='Your hosts note what you ask ("remind me to...") and bring it up when it matters.'
        />
        <Toggle
          checked={on && cfg.fromMail !== false}
          disabled={!on}
          onChange={(v) => save({ fromMail: v })}
          label="From my email"
          description="Bills, deadlines and things people are waiting on. Never newsletters or promotions."
        />
        <Toggle
          checked={on && cfg.fromEvents !== false}
          disabled={!on}
          onChange={(v) => save({ fromEvents: v })}
          label="From my calendar"
          description="Invitations to answer and meetings to get ready for."
        />
        <Toggle
          checked={on && cfg.fromNotion !== false}
          disabled={!on}
          onChange={(v) => save({ fromNotion: v })}
          label="From Notion"
          description="To-dos on the Notion pages you picked."
        />
        <p className="aw-list-settings__note">
          Email, invitations and pages only ever add items here, labeled with where they came from. They never make your hosts do anything.
        </p>
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            navigate('/settings/connections');
          }}
        >
          Google Calendar and Tasks permissions
        </Button>
      </div>
    </Sheet>
  );
}
