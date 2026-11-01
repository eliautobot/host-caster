// "What your hosts can see" (Settings, linked from Connections): every source the hosts talk from, in plain words.
// Connected or not, which stations use it, what it holds right now (exactly what the hosts get), when it was fetched,
// what went wrong last, and what the next break would bring up.
import { useState } from 'react';
import { AlertTriangle, BellRing, Bot, CalendarDays, CloudSun, Heart, Mail, Newspaper, NotebookPen, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react';
import { hostsView, type SourceId, type SourceView } from '@/core/radio/hostsView';
import { navigate } from '@/state/router';
import { Badge, Button, Card, SkeletonText } from '../../components';
import { Hint, SectionCard, errorText, timeAgo, useLoad } from './account/parts';
import './account/account.css';
import './hostsSee.css';

const ICONS: Record<SourceId, LucideIcon> = {
  calendar: CalendarDays,
  email: Mail,
  news: Newspaper,
  weather: CloudSun,
  reminders: BellRing,
  life: Heart,
  notion: NotebookPen,
  aiApps: Bot,
};

const SHOWN = 6;

function stationsLine(s: SourceView): string {
  if (!s.on.length) return s.off.length ? 'Off on every station' : 'No stations yet';
  const on = !s.off.length ? (s.on.length === 1 ? s.on[0]! : `all ${s.on.length} stations`) : s.on.join(', ');
  const off = s.off.length ? `. Off for ${s.off.join(', ')}` : '';
  return s.connected ? `On for ${on}${off}` : `On for ${on} once it is connected${off}`;
}

function SourceCard({ s }: { s: SourceView }) {
  const [all, setAll] = useState(false);
  const items = all ? s.preview : s.preview.slice(0, SHOWN);
  const count = s.preview.length;
  return (
    <SectionCard
      icon={ICONS[s.id]}
      tone={s.connected ? 'ok' : 'neutral'}
      title={s.title}
      status={s.how}
      badge={s.connected ? { label: 'Connected', tone: 'ok', dot: true } : { label: 'Not connected', tone: 'neutral' }}
    >
      <div className="aw-hostsee__facts">
        <span>{stationsLine(s)}</span>
        {s.connected && (
          <span>
            {count ? `${count} item${count === 1 ? '' : 's'} right now` : 'Nothing right now'}
            {s.fetchedAt !== undefined && ` · checked ${timeAgo(s.fetchedAt)}`}
          </span>
        )}
      </div>
      {s.error && (
        <p className="aw-hostsee__error" role="status">
          <AlertTriangle aria-hidden />
          <span>Last try failed. {s.error}</span>
        </p>
      )}
      {count > 0 && (
        <div className="aw-hostsee__preview">
          <p className="aw-hostsee__label">What the hosts get</p>
          <ul className="aw-hostsee__list">
            {items.map((p, i) => (
              <li key={i} className="aw-hostsee__item">
                <span className="aw-hostsee__text">{p.text}</span>
                {p.detail && <span className="aw-hostsee__detail">{p.detail}</span>}
              </li>
            ))}
          </ul>
          {count > SHOWN && (
            <Button size="sm" variant="ghost" onClick={() => setAll((x) => !x)}>
              {all ? 'Show fewer' : `Show all ${count}`}
            </Button>
          )}
        </div>
      )}
      {s.note && <Hint>{s.note}</Hint>}
      <div className="aw-acct-actions">
        <Button size="sm" variant={s.connected ? 'ghost' : 'secondary'} onClick={() => navigate(s.setup.to)}>
          {s.setup.label}
        </Button>
      </div>
    </SectionCard>
  );
}

export default function HostsSee() {
  const [fresh, setFresh] = useState(0);
  const view = useLoad(() => hostsView({ fresh: fresh > 0 }), [fresh]);
  const data = view.data;
  return (
    <div className="aw-acct-stack aw-hostsee">
      <div className="aw-hostsee__intro">
        <p className="aw-acct-desc">This is everything your hosts can use when they talk between songs. Nothing else about you reaches them.</p>
        <Button size="sm" icon={RefreshCw} loading={view.loading && Boolean(data)} onClick={() => setFresh((n) => n + 1)}>
          Check now
        </Button>
      </div>

      {!data && view.loading && (
        <Card>
          <SkeletonText lines={4} />
        </Card>
      )}
      {view.error !== undefined && !data && <Hint icon={AlertTriangle}>{errorText(view.error)}</Hint>}

      {data?.next && (
        <Card className="aw-hostsee__next">
          <div className="aw-hostsee__nexthead">
            <Sparkles aria-hidden />
            <h3>Next break on {data.next.station}</h3>
            {data.next.rundown && <Badge tone="warm">Rundown of your day</Badge>}
          </div>
          {data.next.items.length ? (
            <ol className="aw-hostsee__nextlist">
              {data.next.items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
          ) : (
            <p className="aw-acct-desc">Just the next song: nothing new from your day right now.</p>
          )}
          <p className="aw-hostsee__nextnote">Every break also introduces the next song.</p>
        </Card>
      )}

      {data?.sources.map((s) => <SourceCard key={s.id} s={s} />)}
    </div>
  );
}
