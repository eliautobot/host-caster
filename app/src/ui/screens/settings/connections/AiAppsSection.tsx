import { useState, type ReactNode } from 'react';
import { Bot, ChevronRight, LogIn, Plus, Trash2 } from 'lucide-react';
import { connectors, type Connector } from '@/core/api';
import { navigate } from '@/state/router';
import { useSession } from '@/state/session';
import { useSettings } from '@/state/settings';
import { runAction } from '../../../actions';
import { Button, IconButton, TextField, Toggle } from '../../../components';
import { Actions, ConfirmSheet, CopyButton, Hint, SectionCard, timeAgo, useLoad } from '../account/parts';

const HOW_TO: { app: string; steps: ReactNode[] }[] = [
  {
    app: 'ChatGPT',
    steps: [
      <>
        Open <b>Settings</b>, then <b>Apps &amp; Connectors</b>, then <b>Advanced settings</b>, and turn on <b>Developer mode</b>.
      </>,
      <>
        Choose <b>Create</b>, name it Host-Caster, paste the URL as the <b>MCP server URL</b> and pick <b>No authentication</b>.
      </>,
      <>In a chat, turn on Host-Caster from the tools menu and ask, for example, &ldquo;tell my radio hosts I passed my exam&rdquo;.</>,
    ],
  },
  {
    app: 'Claude',
    steps: [
      <>
        Open <b>Settings</b>, then <b>Connectors</b>, and choose <b>Add custom connector</b>.
      </>,
      <>Name it Host-Caster and paste the URL. Leave the advanced (OAuth) fields empty.</>,
      <>In a chat, enable Host-Caster in the tools menu, then ask Claude to send a note or queue a segment.</>,
    ],
  },
  {
    app: 'Grok',
    steps: [
      <>
        Where Grok offers <b>connectors</b> or <b>custom MCP servers</b>, add a remote server with this URL (no authentication).
      </>,
      <>
        Developers can use it from the xAI API as a <b>remote MCP tool</b> with the same URL.
      </>,
    ],
  },
  {
    app: 'Meta AI and others',
    steps: [
      <>Any assistant that connects to remote MCP servers (Streamable HTTP) works: give it this URL with no authentication.</>,
      <>If an app does not support custom connectors yet, its developer tools (for example the Llama API with MCP) can still use it.</>,
    ],
  },
];

const TOOLS = 'now playing, list hosts, send a note, queue a segment, request a song, add a birthday or date';

export function AiAppsSection() {
  const session = useSession((s) => s.session);
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const list = useLoad(() => (session ? connectors.list() : Promise.resolve({ connectors: [] as Connector[] })), [session?.user.id]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string>();
  const [remove, setRemove] = useState<Connector>();
  const items = list.data?.connectors ?? [];
  const enabled = connections.aiApps?.enabled !== false;

  if (!session) {
    return (
      <SectionCard icon={Bot} title="AI apps" status="ChatGPT, Claude, Grok and other assistants">
        <p className="aw-acct-desc">Let your AI assistant send notes and segments to your hosts. Needs an account on your Host-Caster server.</p>
        <Actions>
          <Button icon={LogIn} onClick={() => navigate('/sign-in')}>
            Sign in
          </Button>
        </Actions>
      </SectionCard>
    );
  }

  const create = async () => {
    setBusy(true);
    await runAction(async () => {
      const c = await connectors.create(name.trim() || 'AI app');
      setFresh(c.id);
      setName('');
      list.reload();
    });
    setBusy(false);
  };

  return (
    <SectionCard
      icon={Bot}
      tone={items.length ? 'ok' : 'neutral'}
      title="AI apps"
      status={items.length ? `${items.length} connection${items.length === 1 ? '' : 's'}` : 'ChatGPT, Claude, Grok and other assistants'}
    >
      <p className="aw-acct-desc">
        Your assistant can see what is playing and talk to your hosts: {TOOLS}. The hosts use it in the next break.
      </p>
      <Toggle
        label="Use notes from AI apps on air"
        description="Off = the hosts ignore the inbox; connections stay."
        checked={enabled}
        onChange={(on) => void update({ connections: { ...connections, aiApps: { enabled: on } } })}
      />
      {items.length > 0 && (
        <div className="aw-acct-rows">
          {items.map((c) => (
            <div key={c.id} className="aw-acct-row">
              <span className="aw-acct-row__icon">
                <Bot aria-hidden />
              </span>
              <span className="aw-acct-row__text">
                <span className="aw-acct-row__title">
                  {c.name}
                  {fresh === c.id ? ' · new' : ''}
                </span>
                <span className="aw-acct-row__sub aw-acct-url" title={c.url}>
                  {c.url}
                </span>
                <span className="aw-acct-row__sub">{c.lastUsedAt ? `Last used ${timeAgo(c.lastUsedAt)}` : 'Not used yet'}</span>
              </span>
              <span className="aw-acct-row__end">
                {c.url && <CopyButton text={c.url} label="Copy URL" />}
                <IconButton icon={Trash2} label={`Delete ${c.name}`} size="sm" onClick={() => setRemove(c)} />
              </span>
            </div>
          ))}
        </div>
      )}
      <form
        className="aw-acct-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <TextField aria-label="Connection name" placeholder="Name it (ChatGPT, Claude ...)" value={name} onChange={setName} maxLength={60} />
        <Button type="submit" icon={Plus} loading={busy} variant={items.length ? 'secondary' : 'primary'}>
          New connection
        </Button>
      </form>
      <div className="aw-acct-howto">
        {HOW_TO.map((h) => (
          <details key={h.app}>
            <summary>
              <ChevronRight aria-hidden />
              Connect {h.app}
            </summary>
            <ol>
              {h.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
        ))}
      </div>
      <Hint>
        The URL is the key: anyone who has it can send notes to your hosts, so share it only with your assistant. These apps connect from the
        internet, so your server needs a public <b>https</b> address. Delete a connection to cut it off.
      </Hint>
      <ConfirmSheet
        open={Boolean(remove)}
        onClose={() => setRemove(undefined)}
        title={`Delete ${remove?.name ?? 'connection'}?`}
        description="The app loses access right away. Make a new connection to add it back."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (remove && (await runAction(() => connectors.remove(remove.id)))) {
            setRemove(undefined);
            list.reload();
          }
        }}
      />
    </SectionCard>
  );
}
