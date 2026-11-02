// Your list: what the hosts keep track of for the listener (core/tracker), the question waiting for a yes at the
// top (core/actions), and "Done for you": what the hosts did after a yes, with Undo.
import { useEffect, useMemo, useState } from 'react';
import { ListChecks, Plus, Settings2 } from 'lucide-react';
import { byDue, visible } from '@/core/tracker';
import type { TrackedItem } from '@/core/types';
import { navigate } from '@/state/router';
import { useSession } from '@/state/session';
import { useSettings } from '@/state/settings';
import { useTracker } from '@/state/tracker';
import { ActionCard, useShownAction } from '../actions/ActionCard';
import { ActionsHistory } from '../actions/History';
import { Button, EmptyState, IconButton, Link, Skeleton, Tabs } from '../components';
import { Page } from '../layout/Page';
import { ItemRow } from '../list/ItemRow';
import { AddItem, ListSettingsSheet } from '../list/ListParts';
import { FILTERS, applyFilter, dueLabel, type ListFilter } from '../list/format';
import './settings/account/account.css';
import '../list/list.css';
import type { ScreenProps } from '.';

type View = 'list' | 'done';

const EMPTY: Record<ListFilter, string> = {
  all: '',
  todo: 'No to-dos right now.',
  waiting: 'Nobody owes you anything right now.',
  deadline: 'No deadlines coming up.',
  bill: 'No bills to pay right now.',
  invite: 'No invitations waiting for an answer.',
  done: 'Things you tick off this week show up here.',
};

function groups(items: TrackedItem[], f: ListFilter, now: number): { title: string; items: TrackedItem[] }[] {
  if (f === 'done') return [{ title: 'Done this week', items }];
  const snoozed = (i: TrackedItem) => i.status === 'snoozed' && (i.snoozedUntil ?? 0) > now;
  const live = items.filter((i) => !snoozed(i));
  const today = live.filter((i) => {
    const d = dueLabel(i, now);
    return d && (d.overdue || /^(Today|Reminder today)/.test(d.text));
  });
  const later = live.filter((i) => !today.includes(i) && (i.due || i.remindAt));
  const anytime = live.filter((i) => !i.due && !i.remindAt);
  return [
    { title: 'Today', items: today },
    { title: 'Coming up', items: later },
    { title: 'Anytime', items: anytime },
    { title: 'Snoozed', items: items.filter(snoozed) },
  ].filter((g) => g.items.length);
}

export default function YourList({ query }: ScreenProps) {
  const view: View = query.view === 'done' ? 'done' : 'list';
  const filter = (FILTERS.find((f) => f.value === query.filter)?.value ?? 'all') as ListFilter;
  const items = useTracker((s) => s.items);
  const ready = useTracker((s) => s.ready);
  const [asked, closeAsked] = useShownAction();
  const refreshPending = useTracker((s) => s.refreshPending);
  const signedIn = useSession((s) => Boolean(s.session));
  const enabled = useSettings((s) => s.settings.connections.tracker?.enabled !== false);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void refreshPending();
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [refreshPending, signedIn]);

  const shown = useMemo(() => visible(items, now), [items, now]);
  const rows = useMemo(() => {
    const f = applyFilter(shown, filter);
    return filter === 'done' ? f : [...f].sort(byDue);
  }, [shown, filter]);
  const open = applyFilter(shown, 'all').length;
  const go = (q: { view?: View; filter?: ListFilter }) => {
    const v = q.view ?? view;
    const f = q.filter ?? filter;
    const params = new URLSearchParams();
    if (v === 'done') params.set('view', 'done');
    else if (f !== 'all') params.set('filter', f);
    const s = params.toString();
    navigate(s ? `/list?${s}` : '/list', { replace: true });
  };

  return (
    <Page
      title="Your list"
      subtitle={view === 'done' ? 'What your hosts did after you said yes. Undo works for a week.' : 'What your hosts keep track of for you. Only you and your hosts see it.'}
      width="narrow"
      actions={
        <>
          <IconButton icon={Settings2} label="Your list settings" onClick={() => setSettings(true)} />
          {view === 'list' && (
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Add
            </Button>
          )}
        </>
      }
    >
      <div className="aw-list">
        {asked && <ActionCard key={asked.id} action={asked} onDismiss={closeAsked} />}

        <Tabs
          variant="segmented"
          label="Your list or what your hosts did"
          value={view}
          onChange={(v) => go({ view: v })}
          items={[
            { value: 'list', label: open ? `Your list (${open})` : 'Your list' },
            { value: 'done', label: 'Done for you' },
          ]}
          className="aw-list__views"
        />

        {view === 'done' ? (
          <section className="aw-list__section" aria-label="Done for you">
            <ActionsHistory />
            <p className="aw-list__foot">
              Your hosts can only add to your calendar, answer invitations and use your Google Tasks, and only after you say yes. Turn that on or off in{' '}
              <Link to="/settings/connections" className="aw-textlink">
                Settings, Connections
              </Link>
              .
            </p>
          </section>
        ) : (
          <>
            {!enabled && (
              <p className="aw-list__off">
                Your list is off, so your hosts are not adding anything new.{' '}
                <button type="button" className="aw-textlink" onClick={() => setSettings(true)}>
                  Turn it on
                </button>
              </p>
            )}
            <Tabs label="Show" value={filter} onChange={(f) => go({ filter: f })} items={FILTERS} className="aw-list__filters" />
            {adding && <AddItem onDone={() => setAdding(false)} />}
            {!ready ? (
              <Skeleton height={180} />
            ) : rows.length === 0 ? (
              filter === 'all' ? (
                <EmptyState
                  icon={ListChecks}
                  title="Nothing on your list"
                  description='Say "remind me to call the dentist tomorrow" on a call-in, or add something yourself. Bills, deadlines and invitations from your mail and calendar show up here too.'
                  actions={
                    !adding && (
                      <Button icon={Plus} onClick={() => setAdding(true)}>
                        Add something
                      </Button>
                    )
                  }
                />
              ) : (
                <EmptyState size="compact" icon={ListChecks} title={EMPTY[filter]} />
              )
            ) : (
              groups(rows, filter, now).map((g) => (
                <section key={g.title} className="aw-list__section" aria-label={g.title}>
                  <h2 className="aw-list__group">
                    {g.title}
                    <span>{g.items.length}</span>
                  </h2>
                  <div className="aw-list__items">
                    {g.items.map((i) => (
                      <ItemRow key={i.id} item={i} now={now} />
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </div>
      <ListSettingsSheet open={settings} onClose={() => setSettings(false)} />
    </Page>
  );
}
