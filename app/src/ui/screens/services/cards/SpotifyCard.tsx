import { useEffect, useState } from 'react';
import { Copy, Library, LogIn, RefreshCw, Unplug } from 'lucide-react';
import { api } from '@/core/api';
import { isNative } from '@/core/native';
import {
  beginSpotifyLogin,
  disconnectSpotify,
  getSpotifyPrefs,
  listSpotifyDevices,
  setSpotifyClientId,
  setSpotifyPrefs,
  spotifyProfile,
  spotifyRedirectProblem,
  spotifyRedirectUri,
  webPlaybackSupported,
  type SpotifyDevice,
  type SpotifyPlayMode,
} from '@/core/services/spotify';
import { navigate } from '@/state/router';
import { useSettings } from '@/state/settings';
import { Button, IconButton, Select, TextField, toast } from '../../../components';
import { runAction } from '../../../actions';
import { BusyButton, errorText, useAsync } from '../parts';
import { CardText, Caps, Note, ServiceCard } from './CardFrame';

const DASHBOARD = 'https://developer.spotify.com/dashboard';

function CopyBox({ value }: { value: string }) {
  return (
    <div className="aw-svc-copy">
      <code title={value}>{value}</code>
      <IconButton
        icon={Copy}
        size="sm"
        label="Copy"
        onClick={() =>
          void runAction(async () => {
            await navigator.clipboard.writeText(value);
            toast.success('Copied');
          })
        }
      />
    </div>
  );
}

function PlaybackPrefs() {
  const prefs = useAsync(getSpotifyPrefs, []);
  const [devices, setDevices] = useState<SpotifyDevice[]>();
  const [devErr, setDevErr] = useState<string>();
  const mode = prefs.data?.mode ?? 'auto';
  const browserOk = webPlaybackSupported();

  const loadDevices = async () => {
    setDevErr(undefined);
    try {
      setDevices(await listSpotifyDevices());
    } catch (err) {
      setDevErr(errorText(err));
    }
  };
  useEffect(() => {
    if (mode === 'connect' || !browserOk) void loadDevices();
  }, [mode, browserOk]);

  const options: { value: SpotifyPlayMode; label: string; disabled?: boolean }[] = [
    { value: 'auto', label: browserOk ? 'Automatic (this browser, else my Spotify app)' : 'Automatic (my Spotify app)' },
    { value: 'browser', label: browserOk ? 'This browser' : 'This browser (not supported here)', disabled: !browserOk },
    { value: 'connect', label: 'My Spotify app or speaker (Spotify Connect)' },
  ];
  return (
    <div className="aw-svc-form">
      <Select
        label="Play Spotify on"
        value={mode}
        options={options}
        onChange={(m) => void setSpotifyPrefs({ mode: m }).then(prefs.reload)}
      />
      {(mode === 'connect' || !browserOk) && (
        <div className="aw-svc-form__row">
          <div className="aw-svc-toolbar__row">
            <Select
              label="Device"
              className="aw-grow"
              value={prefs.data?.deviceId ?? ''}
              options={[
                { value: '', label: 'Whichever is active' },
                ...(devices ?? []).map((d) => ({ value: d.id!, label: `${d.name} (${d.type}${d.is_active ? ', active' : ''})` })),
              ]}
              onChange={(id) =>
                void setSpotifyPrefs({ deviceId: id || undefined, deviceName: devices?.find((d) => d.id === id)?.name }).then(prefs.reload)
              }
            />
            <IconButton icon={RefreshCw} label="Refresh devices" variant="solid" onClick={() => void loadDevices()} />
          </div>
          {(devErr || (devices && !devices.length)) && (
            <p className="aw-field__hint">{devErr ?? 'No device is online. Open Spotify on your phone or computer.'}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function SpotifyCard() {
  const sp = useSettings((s) => s.settings.connections.spotify);
  const serverId = (api.config as { spotifyClientId?: string } | undefined)?.spotifyClientId;
  const [clientId, setClientId] = useState(sp?.clientId ?? '');
  const [idError, setIdError] = useState<string>();
  useEffect(() => setClientId(sp?.clientId ?? ''), [sp?.clientId]);
  const connected = Boolean(sp?.connected);
  const redirect = spotifyRedirectUri();
  const redirectProblem = spotifyRedirectProblem();
  const haveId = Boolean(sp?.clientId || serverId);

  useEffect(() => {
    if (connected && !sp?.displayName) void spotifyProfile().catch(() => undefined);
  }, [connected, sp?.displayName]);

  const saveId = async () => {
    setIdError(undefined);
    try {
      await setSpotifyClientId(clientId);
      return true;
    } catch (err) {
      setIdError(errorText(err));
      return false;
    }
  };

  return (
    <ServiceCard
      kind="spotify"
      id="svc-spotify"
      title="Spotify"
      status={connected ? 'connected' : haveId ? 'off' : 'attention'}
      statusLine={connected ? `Connected${sp?.displayName ? ` as ${sp.displayName}` : ''}` : 'Uses your own free Spotify developer app'}
    >
      <CardText>
        Import your playlists and Liked Songs. In a desktop browser Host-Caster plays Spotify itself; on phones it remote-controls
        your Spotify app and the hosts talk between songs.
      </CardText>
      <Caps items={[['Your playlists + Liked Songs'], ['Search'], ['Plays with Premium'], ['Free accounts', false]]} />
      <Note>
        <b>Spotify Premium is required</b> to play from Host-Caster (Spotify&apos;s rule for all apps). New Spotify developer apps
        also need a Premium owner and allow up to 5 listeners you add by email.
      </Note>

      {connected ? (
        <>
          <PlaybackPrefs />
          <div className="aw-svc-actions">
            <Button variant="primary" icon={Library} onClick={() => navigate('/services/spotify')}>
              Browse Spotify
            </Button>
            <BusyButton variant="ghost" icon={Unplug} onRun={() => disconnectSpotify()} success="Spotify disconnected">
              Disconnect
            </BusyButton>
          </div>
        </>
      ) : (
        <div className="aw-svc-form">
          {!serverId && (
            <>
              <ol className="aw-svc-steps">
                <li>
                  Open the{' '}
                  <a href={DASHBOARD} target="_blank" rel="noreferrer">
                    Spotify developer dashboard
                  </a>{' '}
                  and create an app (choose Web API and Web Playback SDK).
                </li>
                <li>Add this Redirect URI{isNative ? '' : ' (and hostcaster://spotify for the phone app)'}:</li>
              </ol>
              <CopyBox value={redirect} />
              <ol className="aw-svc-steps" start={3}>
                <li>Under User management, add the email of each Spotify account that will listen.</li>
                <li>Paste the app&apos;s Client ID here.</li>
              </ol>
              <TextField
                label="Client ID"
                value={clientId}
                onChange={setClientId}
                onBlur={() => clientId !== (sp?.clientId ?? '') && void saveId()}
                placeholder="32 characters, from your Spotify app"
                spellCheck={false}
                autoComplete="off"
                error={idError}
              />
            </>
          )}
          {redirectProblem && <Note>{redirectProblem}</Note>}
          <div className="aw-svc-actions">
            <Button
              variant="primary"
              icon={LogIn}
              disabled={Boolean(redirectProblem) || (!clientId.trim() && !serverId)}
              onClick={() =>
                void runAction(async () => {
                  if (!serverId && !(await saveId())) return;
                  await beginSpotifyLogin();
                })
              }
            >
              Connect Spotify
            </Button>
          </div>
        </div>
      )}
    </ServiceCard>
  );
}
