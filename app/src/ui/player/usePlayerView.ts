import { player } from '@/core/player';
import { radio } from '@/core/radio';
import { usePlayer } from '@/state/player';
import { useRadio } from '@/state/radio';
import { useHosts } from '@/state/hosts';
import { useActiveStation } from '@/state/stations';
import { runAction } from '../actions';
import { controlOtherApp, useOtherApp } from './otherApp';

/**
 * What the player chrome shows: the current track, or the tuned station while idle. While an "any music app"
 * station is on air (Android) it shows and controls the other app's song instead (`other`, no `track`).
 */
export function usePlayerView() {
  const p = usePlayer();
  const r = useRadio();
  const station = useActiveStation();
  const hosts = useHosts((s) => s.hosts);
  const other = useOtherApp();
  const speaking = hosts.find((h) => h.id === r.speakingHostId);
  const lineup = station ? hosts.filter((h) => station.hostIds.includes(h.id)) : [];
  const track = other ? undefined : p.track;
  const playing = other ? other.playing : p.status === 'playing';

  const title = other ? other.title : (track?.title ?? station?.name ?? 'Host-Caster');
  const subtitle = other
    ? [other.artist, other.appName].filter(Boolean).join(' · ')
    : track
      ? track.source === 'stream'
        ? 'Live radio'
        : track.artist
      : lineup.length
        ? `With ${lineup.map((h) => h.name).join(' & ')}`
        : 'Ready when you are';
  /** cover art id/URL for the chrome (the other app's cover is a data: URL) */
  const art = other ? other.artworkUrl : track?.artworkId;

  const toggle = () =>
    runAction(async () => {
      if (other) await controlOtherApp(other.playing ? 'pause' : 'play');
      else if (track) await player.toggle();
      else if (station) await radio.start(station.id);
    });
  const next = () => runAction(() => (other ? controlOtherApp('next') : player.next()));
  const prev = () => runAction(() => (other ? controlOtherApp('prev') : player.prev()));
  /** prev/next do something */
  const canSkip = Boolean(track || other);

  return { p, r, station, track, other, lineup, speaking, playing, title, subtitle, art, toggle, next, prev, canSkip };
}
