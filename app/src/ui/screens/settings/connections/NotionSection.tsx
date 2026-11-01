// Settings > Connections > Notion: connect with Notion's own consent page, choose what the hosts read and where they
// add notes, the switches, what they added (with Undo), and disconnect.
import { useEffect, useState } from 'react';
import { BookOpenText, CheckSquare, LogIn, NotebookPen, PenLine, StickyNote, Undo2 } from 'lucide-react';
import { notion, notionErrorText, type NotionActivity, type NotionStatus } from '@/core/api/notion';
import { NOTION_CONTEXT_KEY } from '@/core/context/notion';
import { kvDelete } from '@/core/db';
import { navigate, useRoute } from '@/state/router';
import { useSession } from '@/state/session';
import { useSettings } from '@/state/settings';
import { runAction } from '../../../actions';
import { Badge, Button, Toggle, toast } from '../../../components';
import { Actions, ConfirmSheet, Hint, SectionCard, errorText, timeAgo, useLoad } from '../account/parts';
import { NotionPicker, type PickerResult } from './NotionPicker';
import './notion.css';

const SOURCE: Record<NotionActivity['source'], string> = { call: 'You asked on air', app: 'Your AI app asked', recap: 'Daily recap' };

function ActivityRow({ a, onUndo }: { a: NotionActivity; onUndo: (a: NotionActivity) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const Icon = a.kind === 'todo' ? CheckSquare : StickyNote;
  const when = new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sub =
    a.status === 'failed'
      ? `Not added: ${a.error ?? 'something went wrong'}`
      : `${SOURCE[a.source]} · ${timeAgo(a.at) === 'just now' ? 'just now' : when}${a.pageTitle ? ` · ${a.pageTitle}` : ''}`;
  return (
    <div className="aw-acct-row aw-notion-act" data-status={a.status}>
      <span className="aw-acct-row__icon" aria-hidden>
        <Icon />
      </span>
      <span className="aw-acct-row__text">
        <span className="aw-acct-row__title">{a.text}</span>
        <span className="aw-acct-row__sub">{sub}</span>
      </span>
      <span className="aw-acct-row__end">
        {a.status === 'undone' ? (
          <Badge tone="neutral">Undone</Badge>
        ) : a.status === 'failed' ? (
          <Badge tone="danger">Not added</Badge>
        ) : a.canUndo ? (
          <Button
            size="sm"
            variant="ghost"
            icon={Undo2}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onUndo(a);
              setBusy(false);
            }}
          >
            Undo
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export function NotionSection() {
  const session = useSession((s) => s.session);
  const connections = useSettings((s) => s.settings.connections);
  const ready = useSettings((s) => s.ready);
  const update = useSettings((s) => s.update);
  const query = useRoute((r) => r.query);
  const status = useLoad<NotionStatus | undefined>(() => (session ? notion.status() : Promise.resolve(undefined)), [session?.user.id]);
  const s = status.data;
  const connected = Boolean(s?.connected);
  const activity = useLoad(() => (connected ? notion.activity() : Promise.resolve({ items: [] as NotionActivity[] })), [connected]);
  const problems = useLoad(
    () => (connected && s?.settings?.read.length ? notion.context().then((c) => c.problems) : Promise.resolve([])),
    [connected, s?.settings?.read.map((r) => r.id).join()],
  );
  const [picker, setPicker] = useState<'read' | 'write'>();
  const [confirmOff, setConfirmOff] = useState(false);
  const [showAll, setShowAll] = useState(false);
  /** just back from Notion's consent: open the reading picker once the new status is in */
  const [justConnected, setJustConnected] = useState(false);

  // the app's flag (the radio reads Notion only when it is on) follows the server
  useEffect(() => {
    if (!ready || !s) return;
    const flag = Boolean(connections.notion?.connected);
    if (flag !== connected) void update({ connections: { ...connections, notion: { connected } } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, s?.connected]);

  // back from Notion (web): ?notion=connected or an error code
  useEffect(() => {
    const back = query.notion;
    if (!back) return;
    if (back === 'connected') {
      toast.success('Notion connected', 'Now pick what your hosts can read and where they write.');
      setJustConnected(true);
    } else toast.error('Notion was not connected', notionErrorText(back));
    navigate('/settings/connections', { replace: true });
    status.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.notion]);

  // phone: the result arrives through hostcaster://notion
  useEffect(
    () =>
      notion.on('change', (e) => {
        if (e.error) toast.error('Notion was not connected', e.error);
        else if (e.connected) {
          toast.success('Notion connected', 'Now pick what your hosts can read and where they write.');
          setJustConnected(true);
        }
        status.reload();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // a fresh connection with nothing picked yet: open the reading picker once
  useEffect(() => {
    if (!justConnected || !connected) return;
    setJustConnected(false);
    if (!s?.settings?.read.length) setPicker('read');
  }, [justConnected, connected, s?.settings?.read.length]);

  const connect = () => runAction(() => notion.connect('/settings/connections'));

  if (!session) {
    return (
      <SectionCard id="notion" icon={NotebookPen} title="Notion" status="Your notes and to-dos on air">
        <p className="aw-acct-desc">Your hosts can mention your Notion to-dos and add notes when you ask. Needs an account on your Host-Caster server.</p>
        <Actions>
          <Button icon={LogIn} onClick={() => navigate('/sign-in')}>
            Sign in
          </Button>
        </Actions>
      </SectionCard>
    );
  }

  if (s && !s.configured) {
    return (
      <SectionCard id="notion" icon={NotebookPen} title="Notion" status="Not set up on this server">
        <Hint>The server owner can turn on Notion by creating a Notion connection (see the self-hosting guide).</Hint>
      </SectionCard>
    );
  }

  if (!connected) {
    return (
      <SectionCard id="notion" icon={NotebookPen} title="Notion" status={status.loading ? 'Checking…' : 'Not connected'}>
        <p className="aw-acct-desc">
          Your hosts mention open to-dos and notes from the pages you pick, and add things when you ask (&ldquo;add oat milk to my list&rdquo;).
        </p>
        <Actions>
          <Button variant="primary" icon={NotebookPen} onClick={() => void connect()} disabled={status.loading}>
            Connect Notion
          </Button>
        </Actions>
        <Hint>Notion asks which pages Host-Caster may see. Pick the ones your hosts can read and one where they can add notes.</Hint>
      </SectionCard>
    );
  }

  const settings = s!.settings!;
  const save = async (patch: Parameters<typeof notion.saveSettings>[0]) => {
    const { settings: next } = await notion.saveSettings(patch);
    if (patch.read) await kvDelete(NOTION_CONTEXT_KEY);
    status.reload();
    return next;
  };
  const onPick = (r: PickerResult) => (r.mode === 'read' ? save({ read: r.items }) : save({ write: { id: r.id, mode: r.writeMode } }));
  const w = settings.write;
  const items = activity.data?.items ?? [];
  const shown = showAll ? items : items.slice(0, 5);
  const problemText = problems.data?.length ? ` · ${problems.data.map((p) => `${p.title}: ${p.message}`).join('; ')}` : '';

  return (
    <SectionCard
      id="notion"
      icon={NotebookPen}
      tone="ok"
      title="Notion"
      status={`Connected to ${s!.workspace?.icon && !s!.workspace.icon.startsWith('http') ? `${s!.workspace.icon} ` : ''}${s!.workspace?.name ?? 'Notion'}`}
      badge={{ label: 'Connected', tone: 'ok', dot: true }}
    >
      <div className="aw-acct-rows">
        <div className="aw-acct-row">
          <span className="aw-acct-row__icon" aria-hidden>
            <BookOpenText />
          </span>
          <span className="aw-acct-row__text">
            <span className="aw-acct-row__title">Hosts can read</span>
            <span className="aw-acct-row__sub">
              {settings.read.length ? settings.read.map((r) => r.title).join(', ') : 'Nothing picked yet'}
              {problemText}
            </span>
          </span>
          <span className="aw-acct-row__end">
            <Button size="sm" onClick={() => setPicker('read')}>
              Choose
            </Button>
          </span>
        </div>
        <div className="aw-acct-row">
          <span className="aw-acct-row__icon" aria-hidden>
            <PenLine />
          </span>
          <span className="aw-acct-row__text">
            <span className="aw-acct-row__title">Hosts write to</span>
            <span className="aw-acct-row__sub">
              {!w ? 'Not picked yet' : w.mode === 'new' ? `${w.title} page inside ${w.parentTitle ?? 'your page'}` : w.title}
            </span>
          </span>
          <span className="aw-acct-row__end">
            <Button size="sm" variant={w ? 'secondary' : 'primary'} onClick={() => setPicker('write')}>
              Choose
            </Button>
          </span>
        </div>
      </div>
      <Toggle
        label="Hosts may add notes when I ask"
        description="Only when you ask on a call or from your AI app. They say so on air, and you can undo it below."
        checked={settings.writesOn}
        onChange={(on) => void runAction(() => save({ writesOn: on }))}
      />
      <Toggle
        label="Daily recap"
        description="Once each evening, a short note about the day on air."
        checked={settings.recapOn}
        onChange={(on) => void runAction(() => save({ recapOn: on }))}
      />
      <div className="aw-notion-log">
        <h4 className="aw-notion-log__title">What your hosts added</h4>
        {activity.error ? (
          <p className="aw-notion-empty">{errorText(activity.error)}</p>
        ) : items.length ? (
          <div className="aw-acct-rows">
            {shown.map((a) => (
              <ActivityRow
                key={a.id}
                a={a}
                onUndo={(x) => runAction(async () => {
                  await notion.undo(x.id);
                  await kvDelete(NOTION_CONTEXT_KEY);
                  activity.reload();
                }, { success: 'Removed from your Notion' })}
              />
            ))}
          </div>
        ) : (
          <p className="aw-notion-empty">Nothing yet. Try a call: &ldquo;Add oat milk to my list.&rdquo;</p>
        )}
        {items.length > 5 && (
          <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show less' : `Show all ${items.length}`}
          </Button>
        )}
      </div>
      <Actions>
        <Button onClick={() => void connect()}>Change shared pages</Button>
        <Button variant="ghost" className="aw-notion-off" onClick={() => setConfirmOff(true)}>
          Disconnect
        </Button>
      </Actions>
      <Hint>
        Your hosts never change or delete what you wrote. Undo removes only the note they added. Connected {timeAgo(s!.connectedAt)}.
      </Hint>
      <NotionPicker
        open={Boolean(picker)}
        mode={picker ?? 'read'}
        selected={picker === 'write' ? (w ? [w.mode === 'new' ? (w.parentId ?? w.id) : w.id] : []) : settings.read.map((r) => r.id)}
        newPage={!w || w.mode === 'new'}
        onClose={() => setPicker(undefined)}
        onSave={onPick}
        onShareMore={() => void connect()}
      />
      <ConfirmSheet
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Disconnect Notion?"
        description="Your hosts stop reading and writing right away, and Host-Caster forgets the connection and the list of what was added. Notes already in your Notion stay there."
        confirmLabel="Disconnect"
        danger
        onConfirm={async () => {
          if (await runAction(() => notion.disconnect(), { success: 'Notion disconnected' })) {
            setConfirmOff(false);
            await update({ connections: { ...connections, notion: { connected: false } } });
            status.reload();
          }
        }}
      />
    </SectionCard>
  );
}
