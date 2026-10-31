import { Plus, RadioTower } from 'lucide-react';
import { useSettings } from '@/state/settings';
import { useStations } from '@/state/stations';
import { navigate } from '@/state/router';
import { Button, EmptyState } from '../components';
import { Page } from '../layout/Page';
import { NewCard } from './parts/HostCard';
import { StationCard } from './parts/StationCard';
import type { ScreenProps } from '.';
import './parts/cards.css';

export default function Stations(_: ScreenProps) {
  const { stations, ready } = useStations();
  const activeId = useSettings((s) => s.settings.activeStationId);
  return (
    <Page
      title="Stations"
      subtitle="Each station mixes your music with its own hosts and show."
      actions={
        <Button variant="primary" icon={Plus} onClick={() => navigate('/stations/new')}>
          New station
        </Button>
      }
    >
      {ready && stations.length === 0 ? (
        <EmptyState icon={RadioTower} title="No stations yet" description="Create a station to pick its music and hosts." />
      ) : (
        <div className="aw-grid aw-grid--stations">
          {stations.map((s) => (
            <StationCard key={s.id} station={s} tunedIn={s.id === activeId} />
          ))}
          <NewCard title="New station" description="Pick music, hosts and a vibe" onClick={() => navigate('/stations/new')} />
        </div>
      )}
    </Page>
  );
}
