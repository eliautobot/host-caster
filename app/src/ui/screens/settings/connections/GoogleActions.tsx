// Connections > Google: what the hosts may DO on Google, only after the listener says yes (core/actions).
// Turning a switch on asks Google for that one permission (incremental; everyone else keeps read-only); the switch
// only turns on once Google granted it. Turning it off stops the hosts; the permission itself stays until the
// listener disconnects Google or removes it in their Google Account.
import { useEffect, useState } from 'react';
import { CalendarPlus, ListChecks, RefreshCw } from 'lucide-react';
import { actionsApi, actionsStatus } from '@/core/actions';
import { auth, type GoogleService } from '@/core/api';
import type { Connections } from '@/core/types';
import { useRoute } from '@/state/router';
import { useSettings } from '@/state/settings';
import { runAction } from '../../../actions';
import { Button, Chip, Link, Toggle, toast } from '../../../components';
import { errorText, useLoad } from '../account/parts';
import './googleActions.css';

type Kind = 'calendar' | 'tasks';
const SCOPE: Record<Kind, GoogleService> = { calendar: 'calendarEvents', tasks: 'tasks' };
const OFF_NOTE = 'To remove the permission completely, disconnect Google or visit your Google Account permissions.';

const ROWS: { kind: Kind; icon: typeof CalendarPlus; label: string; on: string; off: string }[] = [
  {
    kind: 'calendar',
    icon: CalendarPlus,
    label: 'Hosts can add to my calendar',
    on: 'Adds events and answers invitations on Google Calendar, only after you say yes or tap Yes. Events never invite anyone. An invitation from someone new stays in Gmail until you answer it there.',
    off: 'Asks Google to let Host-Caster add events to your calendar.',
  },
  {
    kind: 'tasks',
    icon: ListChecks,
    label: 'Hosts can use my Google Tasks',
    on: 'Your open tasks show up in Your list. Adding, ticking off or changing a task happens only after you say yes or tap Yes.',
    off: 'Asks Google to let Host-Caster read and change your Google Tasks.',
  },
];

function TaskLists({ connections }: { connections: Connections }) {
  const update = useSettings((s) => s.update);
  const lists = useLoad(() => actionsApi.tasks().then((r) => r.lists), []);
  const chosen = new Set(connections.actions?.taskLists ?? []);
  const set = (ids: string[]) => void update({ connections: { ...connections, actions: { ...connections.actions, taskLists: ids.length ? ids : undefined } } });
  const toggle = (id: string) => set(chosen.has(id) ? [...chosen].filter((x) => x !== id) : [...chosen, id]);
  return (
    <div className="aw-gactions__lists">
      <p className="aw-gactions__label">Task lists to read into Your list</p>
      {lists.data ? (
        lists.data.length ? (
          <div className="aw-gactions__chips">
            <Chip size="sm" selected={chosen.size === 0} onClick={() => set([])}>
              All lists
            </Chip>
            {lists.data.map((l) => (
              <Chip key={l.id} size="sm" selected={chosen.has(l.id)} onClick={() => toggle(l.id)}>
                {l.title}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="aw-acct-row__sub">No task lists yet.</p>
        )
      ) : (
        <p className="aw-acct-row__sub">{lists.error ? `Could not load your lists: ${errorText(lists.error)}` : 'Loading your lists...'}</p>
      )}
    </div>
  );
}

export function GoogleActions({ scopes }: { scopes: string[] }) {
  const connections = useSettings((s) => s.settings.connections);
  const ready = useSettings((s) => s.ready);
  const update = useSettings((s) => s.update);
  const query = useRoute((r) => r.query);
  const [status, setStatus] = useState<{ calendar: boolean; tasks: boolean }>();
  const granted = (k: Kind) => scopes.includes(SCOPE[k]) || Boolean(status?.[k]);
  const on = (k: Kind) => Boolean(connections.actions?.[k]);
  const save = (k: Kind, v: boolean) => update({ connections: { ...connections, actions: { ...connections.actions, [k]: v } } });

  // what the server can really do (the scopes Google granted)
  useEffect(() => {
    void actionsStatus(true).then((s) => s && setStatus({ calendar: s.calendarWrite, tasks: s.tasks }));
  }, [scopes.join()]);

  // back from Google's consent screen with ?enable=calendarEvents|tasks: switch it on once Google granted it
  useEffect(() => {
    const k = (Object.keys(SCOPE) as Kind[]).find((x) => SCOPE[x] === query.enable);
    if (!ready || !k) return;
    void (async () => {
      // the session on this device may still be the one from before the consent screen: ask the server
      const st = scopes.includes(SCOPE[k]) ? undefined : await actionsStatus(true);
      const ok = scopes.includes(SCOPE[k]) || Boolean(k === 'calendar' ? st?.calendarWrite : st?.tasks);
      if (!ok) toast('Google did not allow it, so nothing changed.');
      else if (!on(k)) {
        await save(k, true);
        toast.success(k === 'calendar' ? 'Your hosts can add to your calendar' : 'Your hosts can use your Google Tasks', 'Only after you say yes.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, query.enable]);

  const ask = (k: Kind) =>
    runAction(async () => {
      // web: the page goes to Google and comes back with ?enable=...; apps: resolves with the new session
      const session = await auth.linkGoogle([SCOPE[k]], `/settings/connections?enable=${SCOPE[k]}`);
      if (!session) return;
      const now = session.user.identities?.find((i) => i.provider === 'google')?.scopes ?? [];
      const st = now.includes(SCOPE[k]) ? undefined : await actionsStatus(true);
      if (now.includes(SCOPE[k]) || (k === 'calendar' ? st?.calendarWrite : st?.tasks)) await save(k, true);
      else toast('Google did not allow it, so nothing changed.');
    });

  const flip = async (k: Kind, v: boolean) => {
    if (!v) {
      await save(k, false);
      toast({ title: k === 'calendar' ? 'Your hosts stopped adding to your calendar' : 'Your hosts stopped using your Google Tasks', description: OFF_NOTE });
      return;
    }
    if (granted(k)) await save(k, true);
    else await ask(k);
  };

  return (
    <div className="aw-gactions">
      <p className="aw-gactions__head">What your hosts can do</p>
      <div className="aw-acct-rows">
        {ROWS.map((r) => {
          const missing = on(r.kind) && !granted(r.kind);
          return (
            <div key={r.kind} className="aw-acct-row aw-gactions__row" data-switch={r.kind}>
              <span className="aw-acct-row__icon">
                <r.icon aria-hidden />
              </span>
              <span className="aw-acct-row__text">
                <span className="aw-acct-row__title">{r.label}</span>
                <span className="aw-acct-row__sub aw-gactions__sub">{on(r.kind) ? r.on : granted(r.kind) ? `Off, so your hosts will not. ${OFF_NOTE}` : r.off}</span>
              </span>
              <span className="aw-acct-row__end">
                <Toggle checked={on(r.kind)} onChange={(v) => void flip(r.kind, v)} aria-label={r.label} />
              </span>
              {missing && (
                <div className="aw-gactions__fix">
                  <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void ask(r.kind)}>
                    Reconnect Google to allow this
                  </Button>
                </div>
              )}
              {r.kind === 'tasks' && on('tasks') && granted('tasks') && <TaskLists connections={connections} />}
            </div>
          );
        })}
      </div>
      <p className="aw-gactions__note">
        Nothing is written to Google until you say yes on a call-in or tap Yes. Your hosts never send mail, pay, delete or invite anyone.{' '}
        {(on('calendar') || on('tasks')) && (
          <Link to="/list?view=done" className="aw-gactions__link">
            See what they did
          </Link>
        )}
      </p>
    </div>
  );
}
