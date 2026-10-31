import { useMemo } from 'react';
import type { Station } from '@/core/types';
import { useHosts } from '@/state/hosts';
import { useRadio } from '@/state/radio';
import { navigate } from '@/state/router';
import { AvatarStack, Badge, Card, OnAirBadge, StationArt } from '../../components';
import './cards.css';

export function StationCard({ station, tunedIn }: { station: Station; tunedIn?: boolean }) {
  const all = useHosts((s) => s.hosts);
  const hosts = useMemo(() => lineup(all, station.hostIds), [all, station.hostIds]);
  const radio = useRadio();
  const live = radio.onAir && radio.stationId === station.id;
  return (
    <Card onClick={() => navigate(`/stations/${station.id}`)} className="aw-stationcard">
      <StationArt color={station.color} frequency={station.frequency} size={88} radius={14} />
      <div className="aw-stationcard__text">
        <h3 className="aw-stationcard__name aw-truncate">{station.name}</h3>
        <p className="aw-stationcard__desc aw-truncate">{station.description ?? `${station.frequency} FM`}</p>
        <div className="aw-stationcard__foot">
          <AvatarStack people={hosts} size={22} />
          <span>{station.talkEvery === 1 ? 'Talks after every song' : `Talks every ${station.talkEvery} songs`}</span>
          {live ? <OnAirBadge onAir /> : tunedIn ? <Badge>Tuned in</Badge> : null}
        </div>
      </div>
    </Card>
  );
}

/** Hosts in line-up order (lead first). */
export function lineup<T extends { id: string }>(hosts: T[], ids: string[]): T[] {
  return ids.map((id) => hosts.find((h) => h.id === id)).filter((h): h is T => Boolean(h));
}
