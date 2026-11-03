// The confirmation card (Rule 2: the AI proposes, the listener confirms, the APP acts). Shows the server's summary
// exactly, who else will see it, a live countdown, Yes / No, then the honest result. Yes = confirmByTap, No = cancel.
import { useEffect, useState } from 'react';
import { ArrowRightLeft, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, Check, CircleCheck, ExternalLink, ListPlus, ListX, Lock, NotebookPen, PencilLine, Undo2, UsersRound, X, type LucideIcon } from 'lucide-react';
import { actionEvents, cancelAction, confirmByTap, doneLine, failedLine, googleZone, undoAction, zoneNote, type ActionRecord, type ServerActionType } from '@/core/actions';
import { openExternal } from '@/core/native';
import { useTracker } from '@/state/tracker';
import { Button, cx } from '../components';
import { canUndo, countdown, plain } from '../list/format';
import './actions.css';

const ICON: Record<ServerActionType, LucideIcon> = {
  'calendar.add': CalendarPlus,
  'task.add': ListPlus,
  'task.complete': CircleCheck,
  'task.edit': PencilLine,
  'task.delete': ListX,
  'task.move': ArrowRightLeft,
  'calendar.update': CalendarClock,
  'calendar.delete': CalendarX,
  'invite.respond': CalendarCheck,
  'notion.add': NotebookPen,
};

/** "Open in Google Calendar" / "Open in Google Tasks" */
export const resultLinkLabel = (a: Pick<ActionRecord, 'type'>) => (a.type.startsWith('task.') ? 'Open in Google Tasks' : a.type.startsWith('notion.') ? 'Open in Notion' : 'Open in Google Calendar');

/** Keeps a record current with every change the engine announces for it. */
export function useLiveAction(initial: ActionRecord): [ActionRecord, (a: ActionRecord) => void] {
  const [a, setA] = useState(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setA(initial), [initial.id]);
  useEffect(() => actionEvents.on('change', ({ action }) => action.id === initial.id && setA(action)), [initial.id]);
  return [a, setA];
}

/** The Google Calendar's own zone, for a new event (its time is said in both zones when the device differs). */
function useCalendarZone(a: Pick<ActionRecord, 'type'>): string | undefined {
  const [tz, setTz] = useState<string>();
  useEffect(() => {
    if (a.type === 'calendar.add') void googleZone().then(setTz, () => undefined);
  }, [a.type]);
  return tz;
}

/** The waiting question for a screen: stays shown after it settles (so the result is seen) until closed. */
export function useShownAction(active = true): [ActionRecord | undefined, () => void] {
  const pending = useTracker((s) => s.pending);
  const [shown, setShown] = useState<ActionRecord>();
  useEffect(() => {
    if (pending && active) setShown(pending);
  }, [pending, active]);
  return [shown, () => setShown(undefined)];
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function ActionCard({
  action,
  className,
  onSettled,
  onDismiss,
}: {
  action: ActionRecord;
  className?: string;
  onSettled?: (a: ActionRecord) => void;
  /** once it is settled, a Close button takes the card away */
  onDismiss?: () => void;
}) {
  const [a, setA] = useLiveAction(action);
  const calendarTz = useCalendarZone(a);
  const zone = a.type === 'calendar.add' ? zoneNote(a.payload, calendarTz) : '';
  const [busy, setBusy] = useState<'yes' | 'no' | 'undo'>();
  const [problem, setProblem] = useState<string>();
  const waiting = a.status === 'proposed';
  const now = useNow(waiting);
  const left = a.expiresAt - now;
  const expired = waiting && left <= 0;
  const status = expired ? 'expired' : a.status;
  const working = busy === 'yes' || status === 'confirmed' || status === 'executing';
  const Icon = ICON[a.type] ?? Check;
  const settled = ['done', 'failed', 'cancelled', 'expired', 'undone', 'undo_failed'].includes(status);

  useEffect(() => {
    if (settled) onSettled?.({ ...a, status });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const yes = async () => {
    setBusy('yes');
    setProblem(undefined);
    try {
      const final = await confirmByTap(a);
      if (final) setA(final);
      else setProblem(failedLine(undefined).replace('You can tap the card', 'Tap Yes again'));
    } catch (err) {
      setProblem(`Nothing was done: ${plain(err instanceof Error ? err.message : String(err))}`);
    } finally {
      setBusy(undefined);
    }
  };
  const no = async () => {
    setBusy('no');
    try {
      setA(await cancelAction(a));
    } finally {
      setBusy(undefined);
    }
  };
  const undo = async () => {
    setBusy('undo');
    setProblem(undefined);
    try {
      setA(await undoAction(a.id));
    } catch (err) {
      setProblem(`Could not undo: ${plain(err instanceof Error ? err.message : String(err))}`);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className={cx('aw-action', `aw-action--${status}`, className)} aria-label="The hosts want to check with you" data-action={a.id}>
      <div className="aw-action__head">
        <span className="aw-action__icon" aria-hidden>
          <Icon />
        </span>
        <div className="aw-action__titles">
          <p className="aw-action__eyebrow">{waiting && !expired ? 'Should I go ahead?' : working ? 'Working on it' : 'You asked your hosts'}</p>
          <p className="aw-action__summary">{plain(a.summary)}</p>
          {zone && <p className="aw-action__zone">{zone}</p>}
        </div>
      </div>

      {a.level === 3 && a.others && (
        <p className="aw-action__others">
          <UsersRound aria-hidden />
          <span>{plain(a.others)}</span>
        </p>
      )}
      <p className="aw-action__level">
        {a.level === 3 ? <UsersRound aria-hidden /> : <Lock aria-hidden />}
        <span>{a.level === 3 ? 'Others will see this' : 'Only you will see this'}</span>
      </p>

      {(waiting || working) && !expired && (
        <div className="aw-action__bar">
          <span className="aw-action__timer" aria-live="off">
            {working ? 'One moment...' : `Expires in ${countdown(left)}`}
          </span>
          <div className="aw-action__buttons">
            <Button variant="secondary" icon={X} onClick={() => void no()} disabled={Boolean(busy) || working} loading={busy === 'no'}>
              No
            </Button>
            <Button variant="primary" icon={Check} onClick={() => void yes()} disabled={Boolean(busy) && busy !== 'yes'} loading={working} data-autofocus>
              Yes
            </Button>
          </div>
        </div>
      )}

      {status === 'done' && (
        <p className="aw-action__result aw-action__result--ok" role="status">
          <CircleCheck aria-hidden />
          <span>{plain(doneLine(a, calendarTz))}</span>
        </p>
      )}
      {(status === 'failed' || status === 'undo_failed') && (
        <p className="aw-action__result aw-action__result--danger" role="status">
          <X aria-hidden />
          <span>{status === 'undo_failed' ? `It is done, but undo did not work: ${plain(a.error?.message ?? 'try again later')}` : plain(failedLine(a))}</span>
        </p>
      )}
      {status === 'cancelled' && <p className="aw-action__result">Okay, nothing changed.</p>}
      {status === 'expired' && <p className="aw-action__result">This question timed out, so nothing changed. Ask your hosts again any time.</p>}
      {status === 'undone' && <p className="aw-action__result">Undone. It is back the way it was.</p>}
      {problem && (
        <p className="aw-action__result aw-action__result--danger" role="status">
          {problem}
        </p>
      )}

      {((status === 'done' || status === 'undo_failed') && (a.result?.link || canUndo(a))) || (settled && onDismiss) ? (
        <div className="aw-action__after">
          {(status === 'done' || status === 'undo_failed') && a.result?.link && (
            <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void openExternal(a.result!.link!)}>
              {resultLinkLabel(a)}
            </Button>
          )}
          {canUndo(a) && (
            <Button size="sm" variant="secondary" icon={Undo2} loading={busy === 'undo'} onClick={() => void undo()}>
              Undo
            </Button>
          )}
          {settled && onDismiss && (
            <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy === 'undo'}>
              Close
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
