// Header of an album, artist, playlist or Liked songs page: big cover, title, facts, Play / Shuffle and more.
import type { CSSProperties, ReactNode } from 'react';
import { ChevronLeft, Pause, Play, Shuffle } from 'lucide-react';
import { player } from '@/core/player';
import type { Track } from '@/core/types';
import { usePlayer } from '@/state/player';
import { back } from '@/state/router';
import { runAction } from '../actions';
import { Button, IconButton, cx } from '../components';
import { useArtColor } from '../player/useArtColor';
import { isPlayingList, playTracks } from './play';
import './library.css';

export interface CollectionHeroProps {
  kind: string;
  title: string;
  meta?: ReactNode;
  description?: string;
  cover: ReactNode;
  /** artwork id the backdrop color comes from */
  colorFrom?: string;
  round?: boolean;
  tracks: Track[];
  /** extra buttons after Play / Shuffle */
  actions?: ReactNode;
  backTo: string;
}

export function CollectionHero({ kind, title, meta, description, cover, colorFrom, round, tracks, actions, backTo }: CollectionHeroProps) {
  const color = useArtColor(colorFrom, 'var(--surface-3)');
  const queue = usePlayer((s) => s.queue);
  const status = usePlayer((s) => s.status);
  const current = isPlayingList(tracks, queue);
  const playing = current && status === 'playing';
  const onPlay = () => {
    if (current) void runAction(() => player.toggle());
    else void playTracks(tracks, 0, { shuffle: false, from: `${kind} · ${title}`, to: location.hash.replace(/^#/, '') });
  };
  return (
    <header className={cx('aw-hero2', round && 'aw-hero2--round')} style={{ '--hc': color } as CSSProperties}>
      <div className="aw-hero2__wash" aria-hidden />
      <IconButton icon={ChevronLeft} label="Back" variant="solid" className="aw-hero2__back" onClick={() => back(backTo)} />
      <div className="aw-hero2__cover">{cover}</div>
      <div className="aw-hero2__text">
        <p className="aw-hero2__kind">{kind}</p>
        <h1 className="aw-hero2__title">{title}</h1>
        {description && <p className="aw-hero2__desc">{description}</p>}
        {meta && <p className="aw-hero2__meta">{meta}</p>}
        <div className="aw-hero2__actions">
          <Button variant="primary" size="lg" icon={playing ? Pause : Play} onClick={onPlay} disabled={!tracks.length}>
            {playing ? 'Pause' : 'Play'}
          </Button>
          <Button size="lg" icon={Shuffle} onClick={() => void playTracks(tracks, 0, { shuffle: true, from: `${kind} · ${title}`, to: location.hash.replace(/^#/, '') })} disabled={tracks.length < 2}>
            Shuffle
          </Button>
          {actions}
        </div>
      </div>
    </header>
  );
}
