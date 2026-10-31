import { Compass } from 'lucide-react';
import { listSavedRadios } from '@/core/services/radiobrowser';
import { navigate } from '@/state/router';
import { Button } from '../../../components';
import { formatCount, useAsync } from '../parts';
import { CardText, Caps, ServiceCard } from './CardFrame';

export function RadioCard() {
  const saved = useAsync(listSavedRadios, []);
  const n = saved.data?.length ?? 0;
  return (
    <ServiceCard
      kind="radio"
      id="svc-radio"
      title="Internet radio"
      status="available"
      statusLine={n ? `${formatCount(n, 'station')} saved` : 'Free, no account needed'}
    >
      <CardText>
        Tens of thousands of live stations from radio-browser.info, a free community directory. Search by name, genre or
        country, save the ones you like, or turn one into a Host-Caster station with your hosts.
      </CardText>
      <Caps items={[['Plays inside Host-Caster'], ['Search by name, genre, country'], ['Make a station']]} />
      <div className="aw-svc-actions">
        <Button variant="primary" icon={Compass} onClick={() => navigate('/services/radio')}>
          Browse stations
        </Button>
      </div>
    </ServiceCard>
  );
}
