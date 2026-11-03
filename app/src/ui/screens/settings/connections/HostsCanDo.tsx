// Connections > What your hosts can do: the same tool registry the hosts get every turn (core/agent/kit), as a plain
// list. Each thing they can change has the listener's choice: allowed without asking, ask me first, or off. What is
// off says why and where to turn it on; what never exists is said plainly.
import { useEffect, useState } from 'react';
import { Wand2 } from 'lucide-react';
import { hostsCanDo, type CanDo, type CanDoTool } from '@/core/agent/kit/catalog';
import { POLICY_WORDS, withPolicy } from '@/core/agent/kit/policy';
import { NEVER } from '@/core/agent/kit/selfknow';
import type { Policy } from '@/core/agent/kit/types';
import { radio } from '@/core/radio';
import { useSettings } from '@/state/settings';
import { Link, Select } from '../../../components';
import { SectionCard } from '../account/parts';
import './hostsCanDo.css';

function statusOf(t: CanDoTool): string {
  if (t.policy === 'off') return 'Off. Your hosts will not do this.';
  if (t.reason === 'signed-out') return 'Needs you signed in.';
  if (!t.ok) return t.fix ? `${t.fix}.` : 'Not available right now.';
  if (t.kind === 'app-write') return 'Done right away. You can undo it.';
  const others = t.level === 3 ? ' Other people will see it.' : '';
  return t.policy === 'auto' ? `Done without asking.${others}` : `Your hosts ask you first.${others}`;
}

function ToolRow({ t, onPolicy }: { t: CanDoTool; onPolicy: (p: Policy) => void }) {
  return (
    <div className="aw-acct-row aw-cando__row" data-tool={t.name} data-ok={t.ok && t.policy !== 'off' ? '1' : '0'}>
      <span className="aw-acct-row__text">
        <span className="aw-acct-row__title aw-cando__title">{t.title}</span>
        <span className="aw-acct-row__sub aw-cando__sub">{statusOf(t)}</span>
      </span>
      {t.choices.length > 1 && (
        <Select
          className="aw-cando__select"
          aria-label={`${t.title}: when your hosts may do it`}
          value={t.policy}
          options={t.choices.map((p) => ({ value: p, label: POLICY_WORDS[p] }))}
          onChange={onPolicy}
        />
      )}
    </div>
  );
}

/** Why a group's look-ups are off (once; signed out is said once at the top). */
function offFix(reads: CanDoTool[]): string {
  const off = reads.find((t) => !t.ok && t.reason !== 'signed-out');
  return off?.fix ? `. ${off.fix}.` : '';
}

export function HostsCanDoSection() {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const [can, setCan] = useState<CanDo>();
  useEffect(() => {
    let live = true;
    void hostsCanDo(radio.musicHooks()).then(
      (c) => live && setCan(c),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [connections]);

  const setPolicy = (t: CanDoTool, p: Policy) => void update({ connections: withPolicy(connections, t, p) });
  const writes = (can?.groups ?? []).map((g) => ({ ...g, writes: g.tools.filter((t) => t.kind !== 'read'), reads: g.tools.filter((t) => t.kind === 'read') }));
  const ready = (can?.groups ?? []).flatMap((g) => g.tools).filter((t) => t.kind !== 'read' && t.ok && t.policy !== 'off').length;

  return (
    <SectionCard id="hosts-can-do" icon={Wand2} title="What your hosts can do" status={can ? `${ready} things they can do for you right now` : 'Checking…'}>
      <div className="aw-cando">
        <p className="aw-cando__intro">
          Ask on a call, in the chat or in a call-in, in your own words. Your hosts pick the right tool. Anything in another account waits for your yes, and
          they only say it is done when it is.
        </p>
        {can?.groups.some((g) => g.tools.some((t) => t.reason === 'signed-out')) && (
          <p className="aw-cando__warn">
            Sign in to let your hosts use Google, your email and Notion. <Link to="/settings/account">Account</Link>
          </p>
        )}
        {can && !can.brain && (
          <p className="aw-cando__warn">
            Your hosts need an AI brain to do these by themselves. Without one they still take plain requests like "add milk to my list".{' '}
            <Link to="/settings/brains">Brains</Link>
          </p>
        )}
        {writes.map((g) => (
          <section key={g.group} className="aw-cando__group" aria-label={g.group}>
            <p className="aw-cando__head">{g.group}</p>
            {g.reads.length > 0 && (
              <p className="aw-cando__reads">
                Can look up: {g.reads.map((t) => t.title.charAt(0).toLowerCase() + t.title.slice(1)).join(', ')}
                {offFix(g.reads)}
              </p>
            )}
            {g.writes.length > 0 && (
              <div className="aw-acct-rows">
                {g.writes.map((t) => (
                  <ToolRow key={t.name} t={t} onPolicy={(p) => setPolicy(t, p)} />
                ))}
              </div>
            )}
          </section>
        ))}
        <p className="aw-cando__never">Never, whatever anyone asks: {NEVER.join('; ')}.</p>
      </div>
    </SectionCard>
  );
}
