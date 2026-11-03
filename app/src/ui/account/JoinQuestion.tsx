// The first sign-in on a device with its own data, into an account that already has data: asked once whether this
// device's stations and hosts join the account. Nothing of this device reaches the account before the answer.
import { useState } from 'react';
import { create } from 'zustand';
import { sync, type JoinAdds } from '@/core/api';
import { useSession } from '@/state/session';
import { Button, Sheet } from '../components';
import { runAction } from '../actions';
import './account.css';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const names = (list: string[]) => (list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', '));

/** Plain lines for what would be added. */
export function joinLines(adds: JoinAdds): string[] {
  const lines: string[] = [];
  if (adds.stations.length) lines.push(`${plural(adds.stations.length, 'station', 'stations')}: ${names(adds.stations)}`);
  if (adds.hosts.length) lines.push(`${plural(adds.hosts.length, 'host', 'hosts')}: ${names(adds.hosts)}`);
  if (adds.songs) lines.push(plural(adds.songs, 'song', 'songs'));
  if (adds.playlists) lines.push(plural(adds.playlists, 'playlist', 'playlists'));
  if (adds.brains) lines.push(plural(adds.brains, 'AI brain', 'AI brains'));
  if (adds.voices) lines.push(plural(adds.voices, 'voice service', 'voice services'));
  if (adds.memories) lines.push(plural(adds.memories, 'thing your hosts remember', 'things your hosts remember'));
  if (adds.tracker) lines.push(plural(adds.tracker, 'item in Your list', 'items in Your list'));
  if (adds.profile) lines.push('Your profile (name, about you)');
  return lines;
}

/** "Not now" hides the question (nothing of this device goes to the account meanwhile); Settings, Account brings it back. */
export const useJoinPrompt = create<{ hidden: boolean }>(() => ({ hidden: false }));

export function JoinQuestion() {
  const join = useSession((s) => (s.sync.status === 'choice' ? s.sync.join : undefined));
  const hidden = useJoinPrompt((s) => s.hidden);
  const [busy, setBusy] = useState<'add' | 'account'>();
  if (!join) return null;
  const answer = (choice: 'add' | 'account') => async () => {
    setBusy(choice);
    try {
      await runAction(() => sync.chooseJoin(choice));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Sheet
      open={!hidden}
      onClose={() => !busy && useJoinPrompt.setState({ hidden: true })}
      size="sm"
      title="Add the stations and hosts on this device to your account?"
      description="Your account already has its own. Nothing from this device has been added yet."
      footer={
        <div className="aw-join__actions">
          <Button variant="ghost" loading={busy === 'account'} disabled={Boolean(busy)} onClick={answer('account')}>
            Keep only my account
          </Button>
          <Button variant="primary" loading={busy === 'add'} disabled={Boolean(busy)} data-autofocus onClick={answer('add')}>
            Add them
          </Button>
        </div>
      }
    >
      <div className="aw-join" data-testid="join-question">
        <p className="aw-join__label">This device would add</p>
        <ul className="aw-join__list">
          {joinLines(join).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="aw-join__note">
          Where your account has its own version of something, your account's version stays. Keep only my account
          removes these from this device instead.
        </p>
      </div>
    </Sheet>
  );
}
