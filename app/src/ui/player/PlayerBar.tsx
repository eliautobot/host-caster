// Desktop bottom player bar (owner: player agent).
import { Heart, ListMusic, Music2, Radio } from 'lucide-react';
import { albumIdOf, artistIdOf, toggleLike } from '@/core/library';
import { navigate, useRoute } from '@/state/router';
import { runAction } from '../actions';
import { Artwork, IconButton, StationArt, cx } from '../components';
import { LibraryDialogs } from '../library/dialogs';
import { DropOverlay } from '../library/importUi';
import { OnAirStrip } from '../radio/OnAirStrip';
import { Scrubber, Transport, VolumeControl } from './controls';
import { usePlayerErrors, usePlayerShortcuts } from './hooks';
import { usePlayerView } from './usePlayerView';
import './player.css';

export function PlayerBar() {
  const v = usePlayerView();
  const path = useRoute((r) => r.path);
  usePlayerShortcuts();
  usePlayerErrors();
  const t = v.track;
  const link = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };

  return (
    <footer className={cx('aw-playerbar', v.r.onAir && 'is-onair')} aria-label="Player">
      <div className="aw-playerbar__now">
        <button type="button" className="aw-playerbar__art" onClick={() => navigate('/now-playing')} aria-label="Open Now Playing">
          {t ? (
            <Artwork artworkId={t.artworkId} size={56} radius={10} icon={t.source === 'stream' ? Radio : undefined} />
          ) : v.other ? (
            <Artwork artworkId={v.other.artworkUrl} size={56} radius={10} icon={Music2} />
          ) : (
            <StationArt color={v.station?.color ?? '#ff5a36'} frequency={v.station?.frequency ?? '88.1'} size={56} radius={10} />
          )}
        </button>
        <div className="aw-playerbar__meta">
          {t && t.source !== 'stream' ? (
            <>
              <a className="aw-playerbar__title aw-truncate" href={`#/library/albums/${albumIdOf(t)}`} onClick={link(`/library/albums/${albumIdOf(t)}`)}>
                {v.title}
              </a>
              <a className="aw-playerbar__subtitle aw-truncate" href={`#/library/artists/${artistIdOf(t.artist)}`} onClick={link(`/library/artists/${artistIdOf(t.artist)}`)}>
                {v.subtitle}
              </a>
            </>
          ) : (
            <>
              <p className="aw-playerbar__title aw-truncate">{v.title}</p>
              <p className="aw-playerbar__subtitle aw-truncate">{v.subtitle}</p>
            </>
          )}
        </div>
        {t && (
          <IconButton
            icon={Heart}
            label={t.liked ? 'Remove from Liked songs (Shift+L)' : 'Add to Liked songs (Shift+L)'}
            size="sm"
            active={Boolean(t.liked)}
            iconProps={t.liked ? { fill: 'currentColor', strokeWidth: 0 } : undefined}
            onClick={() => void runAction(() => toggleLike(t))}
          />
        )}
      </div>

      <div className="aw-playerbar__center">
        <Transport />
        <Scrubber variant="bar" />
      </div>

      <div className="aw-playerbar__side">
        <OnAirStrip variant="bar" className="aw-playerbar__onair" />
        <IconButton
          icon={ListMusic}
          label="Queue (Q)"
          size="sm"
          active={path === '/now-playing'}
          onClick={() => navigate('/now-playing?tab=queue')}
        />
        <VolumeControl />
      </div>
      <LibraryDialogs />
      <DropOverlay />
    </footer>
  );
}
