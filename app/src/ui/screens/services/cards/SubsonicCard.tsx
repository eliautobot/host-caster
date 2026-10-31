import { useState } from 'react';
import { KeyRound, Library, LogIn, Unplug } from 'lucide-react';
import { db } from '@/core/db';
import { connectSubsonic, disconnectSubsonic, subsonicStatus } from '@/core/services/subsonic';
import { navigate } from '@/state/router';
import { useSettings } from '@/state/settings';
import { Button, TextField, toast } from '../../../components';
import { BusyButton, errorText, formatCount, useAsync } from '../parts';
import { CardText, Caps, ServiceCard } from './CardFrame';

function hostOf(url?: string) {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return url ?? '';
  }
}

export function SubsonicCard() {
  const conn = useSettings((s) => s.settings.connections.subsonic);
  const status = useAsync(async () => {
    const [s, count] = await Promise.all([subsonicStatus(), db.tracks.where('source').equals('subsonic').count()]);
    return { ...s, count };
  }, [conn?.url, conn?.username]);
  const [url, setUrl] = useState(conn?.url ?? '');
  const [user, setUser] = useState(conn?.username ?? '');
  const [pass, setPass] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [useKey, setUseKey] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const s = status.data;
  const connected = Boolean(s?.connected);
  const server = s?.server;
  const serverName = server?.type ? server.type[0]!.toUpperCase() + server.type.slice(1) : 'Subsonic server';

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const info = await connectSubsonic(useKey ? { url, username: user, apiKey } : { url, username: user, password: pass });
      setPass('');
      setApiKey('');
      toast.success('Music server connected', `${info.type ?? 'Subsonic'} ${info.serverVersion ?? info.version}`.trim());
      status.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ServiceCard
      kind="subsonic"
      id="svc-subsonic"
      title="Your music server"
      status={connected ? 'connected' : 'off'}
      statusLine={
        connected
          ? `${serverName}${server?.serverVersion ? ` ${server.serverVersion.split(' ')[0]}` : ''} · ${s?.username ?? ''} @ ${hostOf(s?.url)}`
          : 'Navidrome, Airsonic, Gonic, Ampache, Jellyfin (Subsonic plugin)'
      }
    >
      <CardText>
        Play your own collection from a self-hosted server that speaks the Subsonic API. Songs stream straight from your
        server; Host-Caster keeps only the song list and covers.
      </CardText>
      <Caps items={[['Plays inside Host-Caster'], ['Playlists, albums, artists, starred'], ['Search'], ['Works on your home network']]} />

      {connected ? (
        <>
          <p className="aw-svc-card__desc">
            {formatCount(s?.count ?? 0, 'song')} imported so far.
          </p>
          <div className="aw-svc-actions">
            <Button variant="primary" icon={Library} onClick={() => navigate('/services/subsonic')}>
              Browse your server
            </Button>
            <BusyButton
              variant="ghost"
              icon={Unplug}
              onRun={async () => {
                await disconnectSubsonic();
                status.reload();
              }}
              success="Music server disconnected"
            >
              Disconnect
            </BusyButton>
          </div>
        </>
      ) : (
        <form
          className="aw-svc-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <TextField
            label="Server address"
            placeholder="https://music.example.com or 192.168.1.20:4533"
            value={url}
            onChange={setUrl}
            autoComplete="url"
            inputMode="url"
            spellCheck={false}
            required
          />
          {useKey ? (
            <TextField
              label="API key"
              type="password"
              value={apiKey}
              onChange={setApiKey}
              autoComplete="off"
              hint="OpenSubsonic API key (Navidrome 0.56+: Settings > Personal > API keys)"
              required
            />
          ) : (
            <div className="aw-svc-form__row aw-svc-form__row--2">
              <TextField label="Username" value={user} onChange={setUser} autoComplete="username" spellCheck={false} required />
              <TextField label="Password" type="password" value={pass} onChange={setPass} autoComplete="current-password" required />
            </div>
          )}
          {error && (
            <p className="aw-field__error" role="alert">
              {error}
            </p>
          )}
          <div className="aw-svc-actions">
            <Button type="submit" variant="primary" icon={LogIn} loading={busy}>
              Connect
            </Button>
            <Button variant="ghost" icon={KeyRound} onClick={() => setUseKey((v) => !v)}>
              {useKey ? 'Use username and password' : 'Use an API key'}
            </Button>
          </div>
          <p className="aw-field__hint">
            Your password is not stored: Host-Caster keeps a salted token, as the Subsonic API intends.
          </p>
        </form>
      )}
    </ServiceCard>
  );
}
