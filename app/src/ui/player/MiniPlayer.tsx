// Phone mini player above the tab bar (owner: player agent). The on-air strip slides in above it while a host talks.
import type { CSSProperties } from 'react';
import { Music2, Pause, Play, Radio, SkipForward } from 'lucide-react';
import { navigate } from '@/state/router';
import { Artwork, IconButton, StationArt } from '../components';
import { LibraryDialogs } from '../library/dialogs';
import { OnAirStrip } from '../radio/OnAirStrip';
import { usePlayerErrors } from './hooks';
import { useArtColor } from './useArtColor';
import { usePlayerView } from './usePlayerView';
import './player.css';

export function MiniPlayer() {
  const v = usePlayerView();
  usePlayerErrors();
  const color = useArtColor(v.art, v.station?.color ?? 'var(--accent)');
  const pct = !v.other && v.p.durationMs && !v.p.live ? (v.p.positionMs / v.p.durationMs) * 100 : 0;
  return (
    <div className="aw-mini-dock">
      <OnAirStrip variant="mini" />
      <div className="aw-mini" style={{ '--c': color } as CSSProperties}>
        <button type="button" className="aw-mini__open" onClick={() => navigate('/now-playing')} aria-label="Open Now Playing">
          {v.track ? (
            <Artwork artworkId={v.track.artworkId} size={42} radius={8} icon={v.track.source === 'stream' ? Radio : undefined} />
          ) : v.other ? (
            <Artwork artworkId={v.other.artworkUrl} size={42} radius={8} icon={Music2} />
          ) : (
            <StationArt color={v.station?.color ?? '#ff5a36'} frequency={v.station?.frequency ?? '88.1'} size={42} radius={8} />
          )}
          <span className="aw-mini__meta">
            <span className="aw-mini__title aw-truncate">
              {v.r.onAir && <span className="aw-mini__live" aria-label="On air" />}
              <span className="aw-truncate">{v.title}</span>
            </span>
            <span className="aw-mini__subtitle aw-truncate">{v.subtitle}</span>
          </span>
        </button>
        <IconButton
          icon={v.playing ? Pause : Play}
          label={v.playing ? 'Pause' : v.track || v.other ? 'Play' : 'Go on air'}
          size="lg"
          iconProps={{ fill: 'currentColor', strokeWidth: 0 }}
          className="aw-mini__play"
          onClick={v.toggle}
        />
        {v.canSkip && (
          <IconButton
            icon={SkipForward}
            label={v.p.holding && !v.other ? 'Skip the break' : 'Next'}
            iconProps={{ fill: 'currentColor' }}
            className="aw-mini__next"
            onClick={v.next}
          />
        )}
        <span className="aw-mini__progress" style={{ width: `${pct}%` }} aria-hidden />
      </div>
      <LibraryDialogs />
    </div>
  );
}
