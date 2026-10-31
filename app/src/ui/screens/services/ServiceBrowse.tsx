// #/services/:kind  (owner: services builder) - browse a music service and import / play from it.
import { Settings2 } from 'lucide-react';
import { navigate } from '@/state/router';
import { IconButton } from '../../components';
import { Page } from '../../layout/Page';
import type { ScreenProps } from '..';
import NotFound from '../NotFound';
import { RadioBrowse } from './RadioBrowse';
import { SpotifyBrowse } from './SpotifyBrowse';
import { SubsonicBrowse } from './SubsonicBrowse';
import { YouTubeBrowse } from './YouTubeBrowse';
import { SERVICE_META, ServiceTile, type ServiceKind } from './parts';
import './services.css';

const KINDS: ServiceKind[] = ['subsonic', 'radio', 'youtube', 'spotify'];

export default function ServiceBrowse({ params, query }: ScreenProps) {
  const kind = params.kind as ServiceKind;
  if (!KINDS.includes(kind)) return <NotFound params={params} query={query} />;
  const detail = Boolean(query.playlist || query.album || query.artist);
  const meta = SERVICE_META[kind];
  return (
    <Page
      back={detail ? `/services/${kind}` : '/settings/music-services'}
      eyebrow={detail ? meta.name : 'Music services'}
      title={
        detail ? undefined : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            <ServiceTile kind={kind} size={36} />
            {meta.name}
          </span>
        )
      }
      actions={<IconButton icon={Settings2} label="Music services settings" variant="solid" onClick={() => navigate('/settings/music-services')} />}
    >
      {kind === 'subsonic' && <SubsonicBrowse query={query} />}
      {kind === 'radio' && <RadioBrowse />}
      {kind === 'youtube' && <YouTubeBrowse query={query} />}
      {kind === 'spotify' && <SpotifyBrowse query={query} />}
    </Page>
  );
}
