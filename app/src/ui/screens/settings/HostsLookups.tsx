// The lookups parts of "What your hosts can see": the "Hosts can look things up" switches with the privacy words,
// what the hosts found out about each upcoming item (the research desk's dossiers), and the Lookups list.
import { useEffect, useId, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  Clock,
  CloudSun,
  ExternalLink,
  FileSearch,
  Globe,
  History,
  Link2,
  Loader2,
  Mail,
  Newspaper,
  NotebookPen,
  Search,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { isOnline } from '@/core/api';
import type { ResearchItem } from '@/core/agent/brief';
import { clearLookups, listLookups, type Lookup } from '@/core/agent/lookups';
import { allDossiers, leadWithBrain, researchDesk } from '@/core/agent/research';
import { serverStatus } from '@/core/agent/tools';
import { isDesktop, isNative, openExternal } from '@/core/native';
import type { DeskView } from '@/core/radio/hostsView';
import type { Dossier, Station } from '@/core/types';
import { navigate } from '@/state/router';
import { useHosts } from '@/state/hosts';
import { useBrains } from '@/state/brains';
import { useSettings } from '@/state/settings';
import { useActiveStation } from '@/state/stations';
import { Badge, Button, EmptyState, Toggle, cx, toast } from '../../components';
import { ConfirmSheet, Hint, SectionCard, errorText, timeAgo, useLoad } from './account/parts';
import { byLine, deskLine, linkLabel, lookupMeta, lookupSwitch, lookupWhat, pickDossier, sortLookups, webDescription, webSwitch } from './lookupsView';
import './lookups.css';

const KIND_ICON: Record<Dossier['kind'], LucideIcon> = { calendar: CalendarDays, email: Mail, news: Newspaper };

function toolIcon(tool: string): LucideIcon {
  if (tool.startsWith('calendar')) return CalendarDays;
  if (tool.startsWith('email')) return Mail;
  if (tool.startsWith('notion')) return NotebookPen;
  if (tool === 'web_search') return Globe;
  if (tool === 'news_article') return Newspaper;
  if (tool === 'open_link') return Link2;
  if (tool === 'weather') return CloudSun;
  return Search;
}

/** Opens in a new tab on the web, in the system browser in the apps. */
function openOut(e: { preventDefault: () => void }, url: string) {
  if (!isNative && !isDesktop) return;
  e.preventDefault();
  void openExternal(url);
}

/** Does a host on the station have a real AI brain (so it can look things up)? */
function useHasBrain(station: Station | undefined): boolean | undefined {
  const hosts = useHosts((s) => s.hosts);
  const brains = useBrains((s) => s.brains);
  const key = station ? `${station.id}|${station.hostIds.join(',')}` : '';
  const sig = `${key}|${hosts.map((h) => `${h.id}:${h.brainId ?? ''}`).join(',')}|${brains.map((b) => `${b.id}:${b.kind}`).join(',')}`;
  const r = useLoad(async () => (station ? Boolean(await leadWithBrain(station)) : false), [sig]);
  return r.data;
}

// ---- the switches ---------------------------------------------------------------------------------------------------

function LookupsSwitchCard({ hasBrain, web }: { hasBrain: boolean | undefined; web: boolean }) {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const sw = lookupSwitch(connections.lookups, hasBrain !== false);
  const webSw = webSwitch(connections.lookups, sw);
  const save = (patch: { enabled?: boolean; web?: boolean }) => void update({ connections: { ...connections, lookups: { ...connections.lookups, ...patch } } });
  return (
    <SectionCard
      id="lookups"
      icon={Search}
      tone={sw.checked ? 'ok' : 'neutral'}
      title="Looking things up"
      status="Hosts read up on what is coming up in your day"
      badge={hasBrain === undefined ? undefined : sw.checked ? { label: 'On', tone: 'ok', dot: true } : { label: 'Off', tone: 'neutral' }}
    >
      <div className="aw-lookups__switches">
        <Toggle
          label="Hosts can look things up"
          description={sw.reason ?? 'Calendar details, related emails, your Notion pages and the links in them.'}
          checked={sw.checked}
          disabled={sw.disabled || hasBrain === undefined}
          onChange={(on) => save({ enabled: on })}
        />
        {sw.reason && (
          <div className="aw-acct-actions">
            <Button size="sm" variant="secondary" onClick={() => navigate('/hosts')}>
              Open Hosts
            </Button>
          </div>
        )}
        {web && (
          <Toggle label="Search the web" description={webDescription(isOnline())} checked={webSw.checked} disabled={webSw.disabled} onChange={(on) => save({ web: on })} />
        )}
      </div>
      <Hint icon={ShieldCheck}>
        Your hosts read only what you connected, and only to talk about your day and answer your questions. Every lookup is listed below.
        {web ? ' Web searches send only the search words.' : ''}
      </Hint>
    </SectionCard>
  );
}

// ---- what the hosts found out ---------------------------------------------------------------------------------------

function Section({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="aw-found__part">
      <p className="aw-found__label">{title}</p>
      <ul className="aw-found__bullets">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function FoundRow({ item, d, canLook, busy, onLook }: { item: ResearchItem; d: Dossier; canLook: boolean; busy: boolean; onLook: () => void }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const Icon = KIND_ICON[d.kind];
  const links = (d.links ?? []).filter((l) => /^https?:\/\//i.test(l.url));
  return (
    <div className={cx('aw-found', open && 'aw-found--open')}>
      <button type="button" className="aw-found__head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="aw-acct-row__icon" aria-hidden>
          <Icon />
        </span>
        <span className="aw-found__titles">
          <span className="aw-found__title">{d.title || item.title}</span>
          {!open && <span className="aw-found__about">{busy ? 'Looking into it now...' : d.about}</span>}
        </span>
        {d.by === 'ai' && (
          <span className="aw-found__ai" title={byLine(d)}>
            <Sparkles aria-hidden />
            <span className="aw-found__ai-text">Looked into</span>
          </span>
        )}
        <ChevronDown className="aw-found__chev" aria-hidden />
      </button>
      {open && (
        <div className="aw-found__body" id={bodyId}>
          <p className="aw-found__aboutfull">{d.about}</p>
          <Section title="Who" items={d.who} />
          <Section title="To prepare" items={d.prepare} />
          {links.length > 0 && (
            <div className="aw-found__part">
              <p className="aw-found__label">Links</p>
              <div className="aw-found__links">
                {links.map((l) => (
                  <a key={l.url} className="aw-found__link" href={l.url} target="_blank" rel="noopener noreferrer" onClick={(e) => openOut(e, l.url)}>
                    <ExternalLink aria-hidden />
                    <span>{linkLabel(l)}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          <Section title="Open questions" items={d.questions} />
          {d.sources.length > 0 && (
            <div className="aw-found__part">
              <p className="aw-found__label">Sources</p>
              <p className="aw-found__sources">{d.sources.join(', ')}</p>
            </div>
          )}
          <div className="aw-found__foot">
            <span className="aw-found__by">
              {byLine(d)}
              {d.by === 'ai' ? ` · ${timeAgo(d.at)}` : ''}
            </span>
            {canLook && (
              <Button size="sm" icon={Search} loading={busy} onClick={onLook}>
                {busy ? 'Looking into it' : 'Look into it now'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FoundOutCard({ desk, canLook, fresh }: { desk: DeskView; canLook: boolean; fresh: number }) {
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState(researchDesk.status());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const dossiers = useLoad(() => allDossiers(), [tick, fresh]);
  useEffect(
    () =>
      researchDesk.onChange(() => {
        const s = researchDesk.status();
        setStatus(s);
        if (!s.running) setTick((t) => t + 1);
      }),
    [],
  );
  const items = desk.items;
  const line = deskLine(status, items);
  const shown = items.map((item) => ({ item, d: pickDossier(item, dossiers.data ?? []) }));
  const researched = shown.filter((x) => x.d.by === 'ai').length;

  const look = async (item: ResearchItem) => {
    const id = `${item.key}@${item.version}`;
    setBusy((b) => new Set(b).add(id));
    try {
      const d = await researchDesk.research(item, desk.station);
      if (d) toast.success(`${d.hostName ?? 'Your host'} looked into ${item.title}`);
      else toast({ title: "Your hosts can't look things up right now", description: 'Check that a host on this station has an AI brain.' });
    } catch (err) {
      toast.error('That did not work', errorText(err));
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(id);
        return n;
      });
      setTick((t) => t + 1);
    }
  };

  return (
    <SectionCard
      id="found-out"
      icon={FileSearch}
      tone={researched ? 'ok' : 'neutral'}
      title="What your hosts found out"
      status={
        items.length
          ? `${items.length} thing${items.length === 1 ? '' : 's'} coming up${researched ? `, ${researched} looked into` : ''}`
          : 'About what is coming up in your day'
      }
    >
      {line && (
        <p className="aw-found__desk" role="status">
          {status.running ? <Loader2 className="aw-found__spin" aria-hidden /> : <Clock aria-hidden />}
          <span>{line}</span>
        </p>
      )}
      {items.length ? (
        <div className="aw-found__list">
          {shown.map(({ item, d }) => {
            const id = `${item.key}@${item.version}`;
            return <FoundRow key={id} item={item} d={d} canLook={canLook} busy={busy.has(id) || status.running === id} onLook={() => void look(item)} />;
          })}
        </div>
      ) : (
        <p className="aw-lookups__empty">Nothing coming up to look into right now. Events in the next 36 hours, important emails and top headlines show here.</p>
      )}
    </SectionCard>
  );
}

// ---- the Lookups list -----------------------------------------------------------------------------------------------

const SHOWN = 8;

function LookupRow({ l }: { l: Lookup }) {
  const Icon = toolIcon(l.tool);
  const what = lookupWhat(l);
  return (
    <div className={cx('aw-acct-row', 'aw-lookup', !l.ok && 'aw-lookup--failed')}>
      <span className="aw-acct-row__icon" aria-hidden>
        <Icon />
      </span>
      <span className="aw-acct-row__text">
        <span className="aw-lookup__what">{what.title}</span>
        {what.reason && <span className="aw-lookup__reason">{what.reason}</span>}
        <span className="aw-acct-row__sub">{lookupMeta(l, timeAgo(l.at))}</span>
      </span>
      {!l.ok && (
        <Badge tone="danger" className="aw-lookup__badge">
          Didn&rsquo;t work
        </Badge>
      )}
    </div>
  );
}

function LookupsLogCard({ fresh }: { fresh: number }) {
  const [tick, setTick] = useState(0);
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const log = useLoad(() => listLookups(100), [tick, fresh]);
  useEffect(() => researchDesk.onChange(() => !researchDesk.status().running && setTick((t) => t + 1)), []);
  const list = sortLookups(log.data?.lookups ?? []);
  const items = all ? list : list.slice(0, SHOWN);
  const device = log.data?.from === 'device';
  return (
    <SectionCard
      id="lookups-log"
      icon={History}
      title="Lookups"
      status={device ? 'What your hosts read on this device, newest first' : 'What your hosts read, newest first'}
    >
      {log.error !== undefined && !log.data ? (
        <p className="aw-lookups__empty">{errorText(log.error)}</p>
      ) : !log.data ? (
        <p className="aw-lookups__empty">Loading...</p>
      ) : list.length ? (
        <>
          <div className="aw-acct-rows">
            {items.map((l, i) => (
              <LookupRow key={`${l.id ?? ''}-${l.at}-${i}`} l={l} />
            ))}
          </div>
          <div className="aw-acct-actions">
            {list.length > SHOWN && (
              <Button size="sm" variant="ghost" onClick={() => setAll((x) => !x)}>
                {all ? 'Show fewer' : `Show all ${list.length}`}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Clear
            </Button>
          </div>
        </>
      ) : (
        <EmptyState icon={History} size="compact" title="Nothing looked up yet." description="When a host reads something for you, it shows here." className="aw-lookups__none" />
      )}
      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Clear the Lookups list?"
        description={device ? 'This empties the list on this device.' : 'This empties the list on every device signed in to your account. What your hosts found out stays.'}
        confirmLabel="Clear"
        danger
        onConfirm={async () => {
          await clearLookups();
          setConfirm(false);
          setTick((t) => t + 1);
        }}
      />
    </SectionCard>
  );
}

// ---- together ---------------------------------------------------------------------------------------------------------

export default function HostsLookups({ desk, fresh }: { desk?: DeskView; fresh: number }) {
  const station = useActiveStation();
  const hasBrain = useHasBrain(desk?.station ?? station);
  const connections = useSettings((s) => s.settings.connections);
  const st = useLoad(() => serverStatus(fresh > 0), [fresh]);
  const canLook = Boolean(hasBrain) && lookupSwitch(connections.lookups, true).checked;
  return (
    <>
      <LookupsSwitchCard hasBrain={hasBrain} web={Boolean(st.data?.tools.web)} />
      {desk && <FoundOutCard desk={desk} canLook={canLook} fresh={fresh} />}
      <LookupsLogCard fresh={fresh} />
    </>
  );
}
