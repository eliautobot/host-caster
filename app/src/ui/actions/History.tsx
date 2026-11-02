// "Done for you": what the hosts did (or tried) after the listener said yes, newest first, with Undo.
import { useEffect, useState } from 'react';
import { ExternalLink, History as HistoryIcon, Undo2 } from 'lucide-react';
import { actionEvents, actionHistory, undoAction, type ActionRecord } from '@/core/actions';
import { openExternal } from '@/core/native';
import { useSession } from '@/state/session';
import { Button, EmptyState, IconButton, cx, toast } from '../components';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { errorText, timeAgo, useLoad } from '../screens/settings/account/parts';
import { canUndo, plain, statusLine } from '../list/format';
import { resultLinkLabel } from './ActionCard';
import './actions.css';

function HistoryRow({ a }: { a: ActionRecord }) {
  const [busy, setBusy] = useState(false);
  const desktop = useIsDesktop();
  const st = statusLine(a);
  const undo = async () => {
    setBusy(true);
    try {
      const r = await undoAction(a.id);
      toast(r.status === 'undone' ? 'Undone. It is back the way it was.' : `Could not undo: ${plain(r.error?.message ?? 'try again later')}`);
    } catch (err) {
      toast.error('Could not undo', plain(errorText(err)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="aw-acct-row aw-acthist__row" data-action={a.id}>
      <span className="aw-acct-row__text">
        <span className="aw-acthist__summary">{plain(a.summary)}</span>
        <span className="aw-acct-row__sub">
          <span className={cx('aw-acthist__status', `aw-acthist__status--${st.tone}`)}>{st.text}</span>
          {` · ${timeAgo(a.undoneAt ?? a.executedAt ?? a.createdAt)}`}
        </span>
      </span>
      {(a.result?.link && a.status !== 'undone') || canUndo(a) ? (
        <span className="aw-acct-row__end">
          {a.result?.link &&
            a.status !== 'undone' &&
            (desktop ? (
              <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void openExternal(a.result!.link!)}>
                Open
              </Button>
            ) : (
              <IconButton size="sm" icon={ExternalLink} label={resultLinkLabel(a)} onClick={() => void openExternal(a.result!.link!)} />
            ))}
          {canUndo(a) && (
            <Button size="sm" variant="secondary" icon={Undo2} loading={busy} onClick={() => void undo()}>
              Undo
            </Button>
          )}
        </span>
      ) : null}
    </div>
  );
}

export function ActionsHistory() {
  const signedIn = useSession((s) => Boolean(s.session));
  const [tick, setTick] = useState(0);
  useEffect(() => actionEvents.on('change', () => setTick((n) => n + 1)), []);
  const list = useLoad(() => (signedIn ? actionHistory(50) : Promise.resolve([])), [signedIn, tick]);
  const rows = list.data ?? [];
  if (!signedIn) {
    return <EmptyState size="compact" icon={HistoryIcon} title="Sign in to let your hosts do things for you" description="With Google connected, they can add to your calendar and use your Google Tasks, always after you say yes." />;
  }
  if (!rows.length) {
    return (
      <EmptyState
        size="compact"
        icon={HistoryIcon}
        title={list.error ? 'Could not load this right now' : list.loading ? 'Loading...' : 'Nothing yet'}
        description={list.error ? plain(errorText(list.error)) : list.loading ? undefined : 'When you say yes to something your hosts offer to do, it shows up here, with Undo.'}
      />
    );
  }
  return (
    <div className="aw-acct-rows aw-acthist">
      {rows.map((a) => (
        <HistoryRow key={`${a.id}:${a.status}`} a={a} />
      ))}
    </div>
  );
}
