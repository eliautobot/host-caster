// Home: the question waiting for a yes, and the next few things on Your list (phones reach Your list from here).
import { useEffect } from 'react';
import { ChevronRight, Circle, ShieldAlert } from 'lucide-react';
import { byDue, visible } from '@/core/tracker';
import { navigate } from '@/state/router';
import { useSettings } from '@/state/settings';
import { useTracker } from '@/state/tracker';
import { ActionCard, useShownAction } from '../actions/ActionCard';
import { Button, SectionHeader, cx } from '../components';
import { applyFilter, dueLabel } from './format';
import './list.css';

const SHOWN = 3;

export function HomeList() {
  const items = useTracker((s) => s.items);
  const ready = useTracker((s) => s.ready);
  const [shown, closeShown] = useShownAction();
  const refreshPending = useTracker((s) => s.refreshPending);
  const enabled = useSettings((s) => s.settings.connections.tracker?.enabled !== false);
  useEffect(() => void refreshPending(), [refreshPending]);
  const now = Date.now();
  const open = applyFilter(visible(items, now), 'all')
    .filter((i) => i.status === 'open' || (i.snoozedUntil ?? 0) <= now)
    .sort(byDue);
  if (!ready || (!shown && (!enabled || !open.length))) return null;
  return (
    <section className="aw-home__section aw-homelist" aria-label="Your list">
      <SectionHeader
        title="Your list"
        subtitle={open.length ? `${open.length} thing${open.length === 1 ? '' : 's'} your hosts keep track of.` : 'What your hosts keep track of for you.'}
        action={
          <Button variant="ghost" size="sm" onClick={() => navigate('/list')}>
            Show all
          </Button>
        }
      />
      {shown && <ActionCard key={shown.id} action={shown} onDismiss={closeShown} />}
      {open.length > 0 && (
        <div className="aw-homelist__items">
          {open.slice(0, SHOWN).map((i) => {
            const due = dueLabel(i, now);
            return (
              <button key={i.id} type="button" className="aw-homelist__row" onClick={() => navigate('/list')}>
                <Circle aria-hidden />
                <span className="aw-homelist__what">{i.what}</span>
                {i.flags?.careful && <ShieldAlert className="aw-homelist__careful" aria-label="Be careful, check it's real" />}
                {due && <span className={cx('aw-homelist__due', due.overdue && 'is-overdue')}>{due.text.replace(/^Overdue: .*/, 'Overdue')}</span>}
              </button>
            );
          })}
          {open.length > SHOWN && (
            <button type="button" className="aw-homelist__row" onClick={() => navigate('/list')}>
              <span className="aw-homelist__what">{`${open.length - SHOWN} more`}</span>
              <ChevronRight aria-hidden />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
