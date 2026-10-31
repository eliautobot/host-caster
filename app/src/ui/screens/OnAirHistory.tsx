import { useMemo } from 'react';
import { History, Trash2 } from 'lucide-react';
import { clearBreaks, groupByDay } from '@/core/radio';
import { useHosts } from '@/state/hosts';
import { navigate } from '@/state/router';
import { useStations } from '@/state/stations';
import { runAction } from '../actions';
import { Button, EmptyState, Skeleton, Tabs } from '../components';
import { Page } from '../layout/Page';
import { BreakCard } from '../radio/history/BreakCard';
import { useBreaks } from '../radio/history/useBreaks';
import '../radio/history/history.css';
import type { ScreenProps } from '.';

/** Everything the hosts said on air, newest first. ?station=<id> filters one station. */
export default function OnAirHistory({ query }: ScreenProps) {
  const stations = useStations((s) => s.stations);
  const hosts = useHosts((s) => s.hosts);
  const stationId = stations.some((s) => s.id === query.station) ? query.station : undefined;
  const breaks = useBreaks(150, stationId);
  const days = useMemo(() => groupByDay(breaks ?? []), [breaks]);
  const byId = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const station = stationId ? byId.get(stationId) : undefined;

  const filter = (id: string) => navigate(id === 'all' ? '/on-air' : `/on-air?station=${id}`, { replace: true });
  const onClear = () =>
    runAction(async () => {
      if (!confirm(station ? `Clear the history of ${station.name}?` : 'Clear the whole on-air history?')) return;
      await clearBreaks(stationId);
    });

  return (
    <Page
      title="On-air history"
      subtitle="Everything your hosts said between songs. Play a break again or clear it."
      tint={station?.color}
      width="narrow"
      actions={
        breaks && breaks.length > 0 ? (
          <Button variant="ghost" icon={Trash2} onClick={onClear}>
            Clear
          </Button>
        ) : undefined
      }
    >
      {stations.length > 1 && (
        <Tabs
          className="aw-history__filters"
          label="Station"
          value={stationId ?? 'all'}
          onChange={filter}
          items={[{ value: 'all', label: 'All stations' }, ...stations.map((s) => ({ value: s.id, label: s.name }))]}
        />
      )}
      {!breaks ? (
        <div className="aw-history__list">
          <Skeleton height={120} />
          <Skeleton height={120} />
        </div>
      ) : breaks.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nothing on air yet"
          description="Go on air and your hosts' breaks show up here, with the songs around them."
          actions={
            <Button variant="primary" onClick={() => navigate('/')}>
              Go to your station
            </Button>
          }
        />
      ) : (
        days.map((d) => (
          <section key={d.key} className="aw-history__day" aria-label={d.label}>
            <h2 className="aw-history__dayname">{d.label}</h2>
            <div className="aw-history__list">
              {d.breaks.map((b) => (
                <BreakCard key={b.id} brk={b} hosts={hosts} station={byId.get(b.stationId)} showStation={!stationId && stations.length > 1} />
              ))}
            </div>
          </section>
        ))
      )}
    </Page>
  );
}
