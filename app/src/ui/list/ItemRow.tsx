// One Your list item: what, kind, when, who, where it came from (with a button that opens it), safety flags, the
// hosts' "looks done" hint, and Done / Snooze / Dismiss.
import { useState } from 'react';
import { Bot, CalendarDays, Check, Clock, ExternalLink, ListChecks, Mail, Mic, NotebookPen, RotateCcw, ShieldAlert, UserRound, X, type LucideIcon } from 'lucide-react';
import { dismiss, markDone, reopen, snooze, updateItem } from '@/core/tracker';
import { openExternal } from '@/core/native';
import { offerGoogleDone } from '@/core/actions';
import type { TrackedItem, TrackedSourceType } from '@/core/types';
import { runAction } from '../actions';
import { Badge, Button, Chip, IconButton, cx, toast } from '../components';
import { KIND_LABEL, dueLabel, openLabel, plain, snoozeChoices, untilWords, whoLine } from './format';

const SOURCE_ICON: Record<TrackedSourceType, LucideIcon> = {
  email: Mail,
  event: CalendarDays,
  notion: NotebookPen,
  gtask: ListChecks,
  you: Mic,
  'ai-app': Bot,
};

function GoogleTasksIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden className="aw-li__gtask-icon">
      <circle cx="12" cy="12" r="11" fill="#4285F4" />
      <path d="M7 12.4l3.2 3.1L17 8.8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The small Google Tasks mark next to items mirrored from Google Tasks. */
export function GoogleTasksMark() {
  return (
    <span className="aw-li__gtask" title="In Google Tasks">
      <GoogleTasksIcon />
      <span>Google Tasks</span>
    </span>
  );
}

export function ItemRow({ item, now = Date.now() }: { item: TrackedItem; now?: number }) {
  const [snoozing, setSnoozing] = useState(false);
  const done = item.status === 'done';
  const snoozed = item.status === 'snoozed' && (item.snoozedUntil ?? 0) > now;
  const due = dueLabel(item, now);
  const who = whoLine(item);
  const SourceIcon = item.source.type === 'you' && /typed|added/i.test(item.source.label) ? UserRound : SOURCE_ICON[item.source.type] ?? UserRound;
  const isGtask = Boolean(item.gtask) || item.source.type === 'gtask';

  const tick = () =>
    runAction(async () => {
      if (done) {
        await reopen(item.id);
        return;
      }
      const closed = (await markDone(item.id, 'you')) ?? item;
      toast({ title: 'Ticked off', description: item.what, action: { label: 'Undo', onClick: () => void reopen(item.id) } });
      // a Google task: done here now; the card at the top asks before it is marked complete in Google Tasks too
      if (closed.gtask && (await offerGoogleDone(closed).catch(() => undefined))) toast({ title: 'Also in Google Tasks?', description: 'Tap Yes on the card at the top to mark it complete there too.' });
    });
  const drop = () =>
    runAction(async () => {
      await dismiss(item.id);
      toast({ title: 'Removed from Your list', description: item.what, action: { label: 'Undo', onClick: () => void reopen(item.id) } });
    });
  const later = (until: number) =>
    runAction(async () => {
      await snooze(item.id, until);
      setSnoozing(false);
      toast({ title: `Snoozed until ${untilWords(until, now)}`, description: item.what });
    });

  return (
    <div className={cx('aw-li', done && 'is-done', snoozed && 'is-snoozed', item.flags?.careful && 'is-careful')} data-item={item.id}>
      <button type="button" className={cx('aw-li__check', done && 'is-on')} onClick={() => void tick()} aria-label={done ? `Undo done: ${item.what}` : `Done: ${item.what}`} title={done ? 'Undo done' : 'Done'}>
        <Check aria-hidden />
      </button>

      <div className="aw-li__body">
        <p className="aw-li__what">{item.what}</p>
        <p className="aw-li__meta">
          <span className="aw-li__kind">{KIND_LABEL[item.kind]}</span>
          {snoozed ? (
            <span>Snoozed until {untilWords(item.snoozedUntil!, now)}</span>
          ) : done ? (
            <span>Done{item.doneBy === 'google' ? ' in Google Tasks' : item.doneBy === 'call-in' ? ' on a call-in' : ''}</span>
          ) : (
            due && <span className={cx('aw-li__due', due.overdue && 'is-overdue')}>{due.text}</span>
          )}
          {who && <span>{who}</span>}
          {isGtask && item.source.type !== 'gtask' && <GoogleTasksMark />}
        </p>
        <p className="aw-li__source">
          {item.source.type === 'gtask' ? <GoogleTasksIcon /> : <SourceIcon aria-hidden />}
          <span className="aw-li__label">{plain(item.source.label)}</span>
          {item.source.link && (
            <button type="button" className="aw-li__open" onClick={() => void openExternal(item.source.link!)}>
              {openLabel(item)}
              <ExternalLink aria-hidden />
            </button>
          )}
          {item.flags?.newSender && <Badge tone="warm">New sender</Badge>}
        </p>

        {item.flags?.careful && (
          <p className="aw-li__careful" role="note">
            <ShieldAlert aria-hidden />
            <span>
              <strong>Be careful, check it's real.</strong>
              {item.flags.why ? ` ${plain(item.flags.why)}` : ' Do not pay, sign in or share a code from this message until you have checked it another way.'}
            </span>
          </p>
        )}

        {item.suggestDone && !done && (
          <div className="aw-li__suggest" role="status">
            <span>
              Looks done: {plain(item.suggestDone.why).replace(/\.$/, '')}. Tick it off?
            </span>
            <span className="aw-li__suggest-actions">
              <Button size="sm" variant="primary" icon={Check} onClick={() => void tick()}>
                Tick it off
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void runAction(() => updateItem(item.id, { suggestDone: undefined }))}>
                Not yet
              </Button>
            </span>
          </div>
        )}

        {snoozing && (
          <div className="aw-li__snooze" role="group" aria-label="Snooze until">
            {snoozeChoices(now).map((c) => (
              <Chip key={c.label} size="sm" icon={Clock} onClick={() => void later(c.until)}>
                {c.label}
              </Chip>
            ))}
            <Chip size="sm" onClick={() => setSnoozing(false)}>
              Cancel
            </Chip>
          </div>
        )}
      </div>

      <div className="aw-li__end">
        {done ? (
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void tick()}>
            Undo done
          </Button>
        ) : snoozed ? (
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void runAction(() => reopen(item.id))}>
            Bring back
          </Button>
        ) : (
          <IconButton size="sm" icon={Clock} label="Snooze" active={snoozing} onClick={() => setSnoozing((s) => !s)} />
        )}
        {!done && <IconButton size="sm" icon={X} label="Dismiss" onClick={() => void drop()} />}
      </div>
    </div>
  );
}
