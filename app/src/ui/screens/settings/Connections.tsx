import { useEffect } from 'react';
import { ChevronRight, CloudSun, Eye } from 'lucide-react';
import { navigate, useRoute } from '@/state/router';
import { useSettings } from '@/state/settings';
import { Card, Toggle } from '../../components';
import { SectionCard } from './account/parts';
import { AiAppsSection } from './connections/AiAppsSection';
import { CalendarFeedsSection, NewsFeedsSection } from './connections/FeedsSection';
import { GoogleSection } from './connections/GoogleSection';
import { ImapSection } from './connections/ImapSection';
import { NotionSection } from './connections/NotionSection';
import './account/account.css';
import './hostsSee.css';

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

/** Opens "What your hosts can see": every source, what it holds right now and which stations use it. */
function HostsSeeLink() {
  return (
    <Card className="aw-hostsee-link" onClick={() => navigate('/settings/hosts-see')}>
      <span className="aw-acct-tile aw-acct-tile--signal" aria-hidden>
        <Eye />
      </span>
      <span className="aw-hostsee-link__text">
        <span className="aw-acct-card__title">What your hosts can see</span>
        <span className="aw-acct-card__status">Everything they know about your day right now, source by source</span>
      </span>
      <ChevronRight className="aw-hostsee-link__chev" aria-hidden />
    </Card>
  );
}

/** Connections (owners: server + context agents): what the hosts can talk about, and AI apps that talk to them. */
export default function Connections() {
  const show = useRoute((r) => r.query.show);
  // after the layout's own scroll reset for the new page
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => document.getElementById(show)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
    return () => clearTimeout(t);
  }, [show]);
  return (
    <div className="aw-acct-stack">
      <HostsSeeLink />
      <GoogleSection />
      <CalendarFeedsSection />
      <ImapSection />
      <NotionSection />
      <NewsFeedsSection />
      <WeatherSection />
      <AiAppsSection />
    </div>
  );
}
