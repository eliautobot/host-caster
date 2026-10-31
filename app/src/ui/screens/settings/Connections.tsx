import { CloudSun } from 'lucide-react';
import { useSettings } from '@/state/settings';
import { Toggle } from '../../components';
import { SectionCard } from './account/parts';
import { AiAppsSection } from './connections/AiAppsSection';
import { CalendarFeedsSection, NewsFeedsSection } from './connections/FeedsSection';
import { GoogleSection } from './connections/GoogleSection';
import { ImapSection } from './connections/ImapSection';
import './account/account.css';

function WeatherSection() {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  return (
    <SectionCard icon={CloudSun} title="Weather" status="Open-Meteo, no account needed">
      <Toggle
        label="Weather on air"
        description="Uses the place in About me (or this device's location)."
        checked={connections.weather?.enabled !== false}
        onChange={(on) => void update({ connections: { ...connections, weather: { enabled: on } } })}
      />
    </SectionCard>
  );
}

/** Connections (owners: server + context agents): what the hosts can talk about, and AI apps that talk to them. */
export default function Connections() {
  return (
    <div className="aw-acct-stack">
      <GoogleSection />
      <CalendarFeedsSection />
      <ImapSection />
      <NewsFeedsSection />
      <WeatherSection />
      <AiAppsSection />
    </div>
  );
}
