// The "Heads-ups" card of "What your hosts can see": how urgent changes reach the listener (right away over the
// music, after the song, or in the next break), meeting reminders, and the recent heads-ups (what, when, why).
import { useEffect, useState } from 'react';
import { BellRing, CalendarClock, CalendarPlus, CalendarX2, Mail, MailWarning, Users, type LucideIcon } from 'lucide-react';
import { headsUpWatch, listHeadsUps } from '@/core/agent/headsup';
import type { HeadsUp } from '@/core/types';
import { useSettings } from '@/state/settings';
import { Badge, Select } from '../../components';
import { SectionCard, timeAgo, useLoad } from './account/parts';
import './headsups.css';

type BreakIn = 'now' | 'after' | 'off';
type RemindMin = 0 | 5 | 10 | 15;

const BREAK_IN: { value: BreakIn; label: string }[] = [
  { value: 'now', label: 'Right away' },
  { value: 'after', label: 'After the song' },
  { value: 'off', label: 'Off' },
];
const BREAK_IN_HINT: Record<BreakIn, string> = {
  now: 'A quick word over the music, like real radio, then the song goes on. At most 3 an hour.',
  after: 'At the end of the song that is playing.',
  off: 'Urgent things wait for the next break, like everything else.',
};
const REMIND: { value: string; label: string }[] = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5 minutes before' },
  { value: '10', label: '10 minutes before' },
  { value: '15', label: '15 minutes before' },
];

const KIND: Record<HeadsUp['kind'], { icon: LucideIcon; label: string }> = {
  cancelled: { icon: CalendarX2, label: 'Cancelled' },
  moved: { icon: CalendarClock, label: 'Moved' },
  new: { icon: CalendarPlus, label: 'New' },
  changed: { icon: Users, label: 'Changed' },
  invite: { icon: Mail, label: 'Invitation' },
  urgent: { icon: MailWarning, label: 'Urgent email' },
  reminder: { icon: BellRing, label: 'Reminder' },
};

function stateLine(h: HeadsUp): string {
  if (h.state === 'snoozed') return 'You said got it';
  if (h.state === 'aired') return h.via === 'breakin' ? 'Told over the music' : 'Told in a break';
  return h.major ? 'Coming up' : 'Waiting for the next break';
}

function HeadsUpRow({ h }: { h: HeadsUp }) {
  const k = KIND[h.kind] ?? KIND.changed;
  const Icon = k.icon;
  return (
    <div className="aw-acct-row aw-headsup">
      <span className={`aw-acct-row__icon aw-headsup__icon aw-headsup__icon--${h.major ? 'major' : 'normal'}`} aria-hidden>
        <Icon />
      </span>
      <span className="aw-acct-row__text">
        <span className="aw-headsup__what">{h.said ?? h.fact}</span>
        <span className="aw-headsup__why">{h.why}</span>
        <span className="aw-acct-row__sub">
          {k.label} · {timeAgo(h.airedAt ?? h.at)} · {stateLine(h)}
        </span>
      </span>
    </div>
  );
}

export default function HostsHeadsUps({ fresh }: { fresh: number }) {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const cfg = connections.headsUps ?? {};
  const breakIn: BreakIn = cfg.breakIn ?? 'now';
  const remind = String(cfg.remindMin ?? 10);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const list = useLoad(() => listHeadsUps(), [fresh, tick]);
  const items = [...(list.data ?? [])].sort((a, b) => (b.airedAt ?? b.at) - (a.airedAt ?? a.at)).slice(0, 8);
  const save = (patch: { breakIn?: BreakIn; remindMin?: RemindMin }) => void update({ connections: { ...connections, headsUps: { ...cfg, ...patch } } });
  const watched = Boolean(connections.calendar?.google || connections.calendar?.icsUrls?.length || connections.email?.gmail || connections.email?.imap);
  const status = headsUpWatch.status();
  return (
    <SectionCard
      id="headsups"
      icon={BellRing}
      tone={breakIn === 'off' ? 'neutral' : 'warm'}
      title="Heads-ups"
      status="Your hosts tell you when something important changes"
      badge={{ label: breakIn === 'off' ? 'In breaks only' : 'On', tone: breakIn === 'off' ? 'neutral' : 'ok', dot: breakIn !== 'off' }}
    >
      <div className="aw-headsups__controls">
        <Select label="Break in for urgent things" value={breakIn} options={BREAK_IN} onChange={(v) => save({ breakIn: v })} hint={BREAK_IN_HINT[breakIn]} />
        <Select
          label="Meeting reminders"
          value={remind}
          options={REMIND}
          onChange={(v) => save({ remindMin: Number(v) as RemindMin })}
          hint="For meetings with other people or a video call: who, what to bring, and that the link is there."
        />
      </div>
      <p className="aw-acct-desc aw-headsups__how">
        {watched
          ? `While the radio plays, your hosts check your calendar and email every 2 to 3 minutes${status.lastCheck ? ` (last check ${timeAgo(status.lastCheck)})` : ''}. A meeting cancelled or moved, something new starting soon, and urgent email from a real person count. Newsletters and promotions never do. Each heads-up is told once.`
          : 'Connect your calendar or email below, and your hosts will tell you when something important changes.'}
      </p>
      {items.length ? (
        <div className="aw-acct-rows">
          {items.map((h) => (
            <HeadsUpRow key={h.id} h={h} />
          ))}
        </div>
      ) : (
        <p className="aw-lookups__empty">{list.data ? 'Nothing yet. Recent heads-ups show up here: what was said, when, and why it counted.' : 'Loading...'}</p>
      )}
      {items.some((h) => h.state === 'pending') && (
        <Badge tone="warm" className="aw-headsups__pending">
          {items.filter((h) => h.state === 'pending').length} waiting
        </Badge>
      )}
    </SectionCard>
  );
}
