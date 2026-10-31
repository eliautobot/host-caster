// Settings > This device (owner: native agent): background play, permissions, any music app access.
// Shown in the Android and iOS apps only (see pages.ts).
import { useEffect, type ReactNode } from 'react';
import { AudioLines, BatteryCharging, Bell, Mic, Music2, RadioTower, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import {
  anyApp,
  deviceStatus,
  ensureSpeechPermission,
  nativeTts,
  onAppResume,
  openDeviceSettings,
  platform,
  requestNotificationPermission,
  speechPermission,
  type AnyAppNowPlaying,
  type DeviceStatus,
  type SpeechPermission,
} from '@/core/native';
import { navigate } from '@/state/router';
import { runAction } from '../../actions';
import { Badge, Button } from '../../components';
import { openAnyAppStation } from '../services/cards/OtherAppsCard';
import { Actions, Hint, SectionCard, useLoad } from './account/parts';
import './account/account.css';
import './device.css';

interface DeviceInfo {
  status?: DeviceStatus;
  mic: SpeechPermission;
  voices?: { total: number; offline: number };
  playing?: AnyAppNowPlaying;
}

async function readDevice(): Promise<DeviceInfo> {
  const [status, mic, voices] = await Promise.all([
    deviceStatus(),
    speechPermission(),
    nativeTts.voices().catch(() => undefined),
  ]);
  const playing = status?.anyAppAccess ? await anyApp.nowPlaying().catch(() => undefined) : undefined;
  return {
    status,
    mic,
    voices: voices && { total: voices.length, offline: voices.filter((v) => v.local).length },
    playing,
  };
}

function Row({ icon: Icon, title, sub, end }: { icon: LucideIcon; title: ReactNode; sub: ReactNode; end: ReactNode }) {
  return (
    <div className="aw-acct-row">
      <span className="aw-acct-row__icon" aria-hidden>
        <Icon />
      </span>
      <span className="aw-acct-row__text">
        <span className="aw-acct-row__title">{title}</span>
        <span className="aw-acct-row__sub">{sub}</span>
      </span>
      <span className="aw-acct-row__end">{end}</span>
    </div>
  );
}

const On = ({ children = 'On' }: { children?: ReactNode }) => (
  <Badge tone="ok" dot>
    {children}
  </Badge>
);

function deviceName(s: DeviceStatus | undefined): string {
  if (!s) return platform === 'ios' ? 'iPhone' : 'This phone';
  const maker = s.manufacturer && !s.model?.toLowerCase().startsWith(s.manufacturer.toLowerCase()) ? `${s.manufacturer} ` : '';
  return `${maker}${s.model ?? ''}`.trim() || 'This phone';
}

export default function Device() {
  const info = useLoad(readDevice, []);
  const { reload } = info;
  // coming back from a system settings screen: show the new state
  useEffect(() => onAppResume(reload), [reload]);

  const d = info.data;
  const s = d?.status;
  const android = platform === 'android';
  const os = s ? `${android ? 'Android' : 'iOS'} ${s.release ?? ''}`.trim() : android ? 'Android' : 'iOS';

  const notifications = (
    <Row
      icon={Bell}
      title="Playback controls"
      sub={
        s?.notifications === 'granted' || !android
          ? 'Notification, lock screen, headset'
          : 'Media player only; allow to add a notification'
      }
      end={
        s?.notifications === 'granted' || !android ? (
          <On />
        ) : s?.notifications === 'denied' ? (
          <Button size="sm" onClick={() => void openDeviceSettings('notifications')}>
            Settings
          </Button>
        ) : (
          <Button size="sm" onClick={() => void runAction(async () => { await requestNotificationPermission(); reload(); })}>
            Allow
          </Button>
        )
      }
    />
  );

  const battery = android && (
    <Row
      icon={BatteryCharging}
      title="Battery"
      sub={s?.batteryUnrestricted ? 'Unrestricted: plays all night' : 'Optimized: long sessions may stop'}
      end={
        s?.batteryUnrestricted ? (
          <On>Unrestricted</On>
        ) : (
          <Button size="sm" onClick={() => void openDeviceSettings('app')}>
            Change
          </Button>
        )
      }
    />
  );

  const mic = (
    <Row
      icon={Mic}
      title="Microphone"
      sub={d?.mic === 'unsupported' ? 'Speech recognition is not available on this device' : 'Call in and talk to your hosts'}
      end={
        d?.mic === 'granted' ? (
          <On />
        ) : d?.mic === 'denied' ? (
          <Button size="sm" onClick={() => void openDeviceSettings('app')}>
            Settings
          </Button>
        ) : d?.mic === 'prompt' ? (
          <Button size="sm" onClick={() => void runAction(async () => { await ensureSpeechPermission(); reload(); })}>
            Allow
          </Button>
        ) : (
          <Badge>Off</Badge>
        )
      }
    />
  );

  const voices = (
    <Row
      icon={AudioLines}
      title="Device voices"
      sub={d?.voices ? `${d.voices.total} voices, ${d.voices.offline} work offline` : 'The phone’s own text to speech'}
      end={
        <Button size="sm" variant="ghost" onClick={() => navigate('/settings/voices')}>
          Voices
        </Button>
      }
    />
  );

  const access = Boolean(s?.anyAppAccess);
  return (
    <div className="aw-acct-stack aw-dev">
      <SectionCard icon={Smartphone} title={deviceName(s)} status={info.loading && !d ? 'Checking…' : `${os} · Host-Caster ${__APP_VERSION__}`}>
        <div className="aw-acct-rows">
          {notifications}
          {battery}
          {mic}
          {voices}
        </div>
        {android && !s?.batteryUnrestricted && (
          <Hint icon={BatteryCharging}>
            For hours of radio with the screen off, open <b>Change › Battery</b> and pick <b>Unrestricted</b>.
          </Hint>
        )}
      </SectionCard>

      <SectionCard
        icon={RadioTower}
        tone={access ? 'signal' : 'neutral'}
        title="Any music app"
        status={android ? 'Your hosts talk between songs of the app you already use' : 'Android only'}
        badge={android ? (access ? { label: 'On', tone: 'ok', dot: true } : { label: 'Off', tone: 'neutral' }) : undefined}
      >
        {!android ? (
          <Hint>iOS does not let apps see what other apps are playing, so this mode is only in the Android app.</Hint>
        ) : access ? (
          <>
            <div className="aw-acct-rows">
              <Row
                icon={Music2}
                title={d?.playing ? d.playing.title || 'Something is playing' : 'Nothing playing right now'}
                sub={
                  d?.playing
                    ? [d.playing.artist, d.playing.appName].filter(Boolean).join(' · ')
                    : 'Start a song in YouTube Music, Spotify or any player'
                }
                end={d?.playing?.playing ? <Badge tone="accent" dot="live">Playing</Badge> : null}
              />
            </div>
            <Actions>
              <Button variant="primary" icon={RadioTower} onClick={() => void runAction(openAnyAppStation)}>
                Open the station
              </Button>
              <Button onClick={() => void openDeviceSettings('anyapp')}>Manage access</Button>
            </Actions>
          </>
        ) : (
          <>
            <Hint icon={ShieldCheck}>
              Host-Caster needs <b>notification access</b> to see which song another app is playing. It only reads the song,
              artist and cover, and keeps nothing.
            </Hint>
            <Hint>
              Switch greyed out? Installed outside the Play Store on Android 13 or later: open <b>App info</b>, tap <b>⋮</b>,
              then <b>Allow restricted settings</b>, and try again.
            </Hint>
            <Actions>
              <Button
                variant="primary"
                onClick={() =>
                  void runAction(async () => {
                    await anyApp.requestPermission();
                    reload();
                  })
                }
              >
                Turn on access
              </Button>
              <Button onClick={() => void openDeviceSettings('app')}>App info</Button>
            </Actions>
          </>
        )}
      </SectionCard>
    </div>
  );
}
