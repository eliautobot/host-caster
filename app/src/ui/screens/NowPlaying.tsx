import { useEffect, useState, type CSSProperties } from 'react';
import { ChevronDown, Heart, ListMusic, Music2, Radio } from 'lucide-react';
import { albumIdOf, artistIdOf, toggleLike } from '@/core/library';
import { back, navigate } from '@/state/router';
import { runAction } from '../actions';
import { Artwork, IconButton, StationArt, Tabs, cx } from '../components';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { usePlayContext } from '../library/play';
import { TrackMenuButton } from '../library/TrackMenu';
import { Scrubber, Transport, VolumeControl } from '../player/controls';
import { Queue } from '../player/Queue';
import { useArtColor, useArtworkUrl } from '../player/useArtColor';
import { usePlayerView } from '../player/usePlayerView';
import { OnAirStrip } from '../radio/OnAirStrip';
import { ServiceVideoSlot } from './services/ServiceVideoSlot';
import type { ScreenProps } from '.';
import './NowPlaying.css';

type NpTab = 'player' | 'queue';

/** Full-screen Now Playing (owner: player agent). Opened as a sheet over the current page. */
export default function NowPlaying({ query }: ScreenProps) {
  const v = usePlayerView();
  const desktop = useIsDesktop();
  const [tab, setTab] = useState<NpTab>(query.tab === 'queue' ? 'queue' : 'player');
  useEffect(() => setTab(query.tab === 'queue' ? 'queue' : 'player'), [query.tab]);
  const ctx = usePlayContext();
  const t = v.track;
  const fallback = v.station?.color ?? '#ff5a36';
  const color = useArtColor(v.art, fallback);
  const artUrl = useArtworkUrl(v.art);
  // YouTube tracks: the service's video is laid over the artwork area (services builder's slot)
  const youtube = t?.source === 'youtube';

  const sourceName = v.r.onAir ? (v.station?.name ?? 'Host-Caster') : (ctx.from ?? (t ? 'Your library' : (v.station?.name ?? 'Host-Caster')));
  const go = (to: string) => {
    navigate(to);
  };

  return (
    <div className={cx('aw-np', `aw-np--${tab}`)} style={{ '--c': color } as CSSProperties}>
      <div className="aw-np__bg" aria-hidden>
        {artUrl && <img src={artUrl} alt="" />}
      </div>

      <header className="aw-np__top">
        <IconButton icon={ChevronDown} label="Close" onClick={() => back('/')} />
        <button type="button" className="aw-np__source" onClick={() => ctx.to && go(ctx.to)} disabled={!ctx.to || v.r.onAir}>
          <span className="aw-np__source-kicker">{v.r.onAir ? 'On air' : 'Playing from'}</span>
          <span className="aw-np__source-name aw-truncate">{sourceName}</span>
        </button>
        {t ? <TrackMenuButton track={t} size="md" /> : <span className="aw-np__spacer" />}
      </header>

      <div className="aw-np__body">
        <section className="aw-np__player" aria-label="Now playing">
          <div className={cx('aw-np__art', youtube && 'aw-np__art--video')} key={youtube ? 'video' : (t?.id ?? 'station')}>
            {youtube ? (
              <ServiceVideoSlot track={t} />
            ) : t ? (
              <Artwork artworkId={t.artworkId} fluid radius={20} icon={t.source === 'stream' ? Radio : Music2} alt={`${t.album} cover`} />
            ) : v.other ? (
              <Artwork artworkId={v.other.artworkUrl} fluid radius={20} icon={Music2} alt={`${v.other.title} cover`} />
            ) : (
              <StationArt color={v.station?.color ?? '#ff5a36'} frequency={v.station?.frequency ?? '88.1'} fluid radius={20} />
            )}
          </div>

          <div className="aw-np__info">
            <div className="aw-np__titles">
              <h2 className="aw-np__title aw-truncate">{v.title}</h2>
              {t && t.source !== 'stream' ? (
                <p className="aw-np__subtitle aw-truncate">
                  <a href={`#/library/artists/${artistIdOf(t.artist)}`} onClick={(e) => (e.preventDefault(), go(`/library/artists/${artistIdOf(t.artist)}`))}>
                    {t.artist}
                  </a>
                  {t.album && (
                    <>
                      {' · '}
                      <a href={`#/library/albums/${albumIdOf(t)}`} onClick={(e) => (e.preventDefault(), go(`/library/albums/${albumIdOf(t)}`))}>
                        {t.album}
                      </a>
                    </>
                  )}
                </p>
              ) : (
                <p className="aw-np__subtitle aw-truncate">{v.subtitle}</p>
              )}
            </div>
            {t && (
              <IconButton
                icon={Heart}
                label={t.liked ? 'Remove from Liked songs' : 'Add to Liked songs'}
                size="lg"
                active={Boolean(t.liked)}
                className="aw-np__like"
                iconProps={t.liked ? { fill: 'currentColor', strokeWidth: 0 } : undefined}
                onClick={() => void runAction(() => toggleLike(t))}
              />
            )}
          </div>

          <Scrubber variant="sheet" />
          <Transport size="lg" />
          <OnAirStrip variant="sheet" />
          {desktop && (
            <div className="aw-np__extras">
              <VolumeControl width={200} />
            </div>
          )}
        </section>

        <aside className="aw-np__queue" aria-label="Queue">
          {desktop && (
            <div className="aw-np__queue-head">
              <ListMusic aria-hidden />
              <h3>Queue</h3>
            </div>
          )}
          {v.other ? <p className="aw-np__other-note">{v.other.appName || 'Your music app'} picks what plays next. Your hosts talk between its songs.</p> : <Queue />}
          {!desktop && (
            <div className="aw-np__queue-controls">
              <Transport />
            </div>
          )}
        </aside>
      </div>

      {!desktop && (
        <nav className="aw-np__tabs">
          <Tabs
            variant="segmented"
            label="Now Playing views"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'player', label: 'Now playing' },
              { value: 'queue', label: 'Up next' },
            ]}
          />
        </nav>
      )}
    </div>
  );
}
