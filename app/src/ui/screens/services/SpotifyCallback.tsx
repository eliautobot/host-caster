// #/services/spotify/callback?code=&state= : finishes the Spotify PKCE sign-in, then goes to Music services.
import { useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { completeSpotifyLogin, spotifyProfile } from '@/core/services/spotify';
import { navigate } from '@/state/router';
import { Button, EmptyState, toast } from '../../components';
import { Page } from '../../layout/Page';
import type { ScreenProps } from '..';
import { ServiceTile, errorText } from './parts';
import './services.css';

export default function SpotifyCallback({ query }: ScreenProps) {
  const [error, setError] = useState<string>();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; // StrictMode runs effects twice; the code is single-use
    ran.current = true;
    void (async () => {
      try {
        await completeSpotifyLogin({ code: query.code, state: query.state, error: query.error });
        const me = await spotifyProfile().catch(() => undefined);
        toast.success('Spotify connected', me?.display_name ? `Signed in as ${me.display_name}` : undefined);
        navigate('/settings/music-services', { replace: true });
      } catch (err) {
        setError(errorText(err));
      }
    })();
  }, [query.code, query.state, query.error]);

  return (
    <Page width="narrow">
      <div className="aw-svc-callback">
        {error ? (
          <EmptyState
            icon={CircleAlert}
            title="Spotify is not connected"
            description={error}
            actions={
              <Button variant="primary" onClick={() => navigate('/settings/music-services', { replace: true })}>
                Back to Music services
              </Button>
            }
          />
        ) : (
          <div style={{ display: 'grid', justifyItems: 'center', gap: 16 }} aria-live="polite">
            <ServiceTile kind="spotify" size={56} />
            <p className="aw-svc-card__desc">Connecting Spotify…</p>
            <span className="aw-spinner" aria-hidden />
          </div>
        )}
      </div>
    </Page>
  );
}
