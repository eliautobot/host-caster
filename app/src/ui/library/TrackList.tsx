// Song lists: library, album, playlist, liked, search. Grows in pages while you scroll (big libraries stay fast).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical, Heart, Radio, X } from 'lucide-react';
import { toggleLike } from '@/core/library';
import type { Track } from '@/core/types';
import { formatDuration } from '@/core/util/time';
import { usePlayer } from '@/state/player';
import { runAction } from '../actions';
import { Artwork, IconButton, cx } from '../components';
import { playTracks } from './play';
import { TrackMenuButton } from './TrackMenu';
import { useReorder } from './useReorder';
import './library.css';

const PAGE = 120;

const currentPath = () => location.hash.replace(/^#/, '') || '/';

export interface TrackListProps {
  tracks: Track[];
  /** default: play the list from this song */
  onPlay?: (index: number) => void;
  /** album view: track numbers instead of covers */
  numbered?: boolean;
  /** desktop album column */
  showAlbum?: boolean;
  /** "Remove from this playlist" in the menu */
  playlistId?: string;
  /** edit mode: drag handles and remove buttons */
  editing?: { onMove: (from: number, to: number) => void; onRemove: (index: number) => void };
  empty?: ReactNode;
  label?: string;
  /** "Playing from" in Now Playing, and where it links back to */
  from?: string;
  to?: string;
}

export function TrackList({ tracks, onPlay, numbered, showAlbum = true, playlistId, editing, empty, label = 'Songs', from, to }: TrackListProps) {
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  // only the current track and play state: position ticks must not re-render the whole list
  const current = usePlayer((s) => s.track);
  const status = usePlayer((s) => s.status);
  const reorder = useReorder(tracks.length, (a, b) => editing?.onMove(a, b));

  useEffect(() => {
    const el = sentinel.current;
    if (!el || limit >= tracks.length) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && setLimit((l) => l + PAGE), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, tracks.length]);

  if (!tracks.length) return <>{empty}</>;
  const play = onPlay ?? ((i: number) => void playTracks(tracks, i, { shuffle: false, from: from ?? label, to: to ?? currentPath() }));
  const shown = editing ? tracks : tracks.slice(0, limit);

  return (
    <div className={cx('aw-tracks', numbered && 'aw-tracks--numbered', !showAlbum && 'aw-tracks--noalbum', editing && 'aw-tracks--editing')} role="list" aria-label={label}>
      {shown.map((t, i) => {
        const isCurrent = current?.id === t.id;
        return (
          <div
            key={`${t.id}-${i}`}
            data-row
            role="listitem"
            className={cx('aw-track', isCurrent && 'is-current', reorder.draggingIndex === i && 'is-dragging')}
            style={reorder.rowStyle(i)}
          >
            <div
              className="aw-track__main"
              role="button"
              tabIndex={0}
              aria-label={`Play ${t.title} by ${t.artist}`}
              onClick={() => !editing && play(i)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !editing && e.target === e.currentTarget) {
                  e.preventDefault();
                  play(i);
                }
              }}
            >
              {editing && (
                <span className="aw-track__grip" {...reorder.handleProps(i)} tabIndex={0} role="button">
                  <GripVertical aria-hidden />
                </span>
              )}
              <span className="aw-track__lead">
                {numbered ? (
                  <span className="aw-track__no aw-tabular">{isCurrent ? <NowBars playing={status === 'playing'} /> : (t.trackNo ?? i + 1)}</span>
                ) : (
                  <span className="aw-track__art">
                    <Artwork artworkId={t.artworkId} size={44} radius={8} icon={t.source === 'stream' ? Radio : undefined} />
                    {isCurrent && (
                      <span className="aw-track__art-now">
                        <NowBars playing={status === 'playing'} />
                      </span>
                    )}
                  </span>
                )}
              </span>
              <span className="aw-track__text">
                <span className="aw-track__title aw-truncate">{t.title}</span>
                <span className="aw-track__sub aw-truncate">
                  {t.liked && <Heart className="aw-track__liked-dot" aria-label="Liked" fill="currentColor" strokeWidth={0} />}
                  {t.source === 'stream' ? 'Live radio' : t.artist}
                  {t.source !== 'stream' && !numbered && showAlbum && <span className="aw-track__sub-album"> · {t.album}</span>}
                </span>
              </span>
              {showAlbum && !numbered && <span className="aw-track__album aw-truncate">{t.source === 'stream' ? 'Internet radio' : t.album}</span>}
            </div>
            <span className="aw-track__end">
              {!editing && (
                <IconButton
                  icon={Heart}
                  label={t.liked ? `Unlike ${t.title}` : `Like ${t.title}`}
                  size="sm"
                  active={Boolean(t.liked)}
                  className={cx('aw-track__like', t.liked && 'is-on')}
                  iconProps={t.liked ? { fill: 'currentColor', strokeWidth: 0 } : undefined}
                  onClick={() => void runAction(() => toggleLike(t))}
                />
              )}
              <span className="aw-track__dur aw-tabular">{t.source === 'stream' ? 'Live' : formatDuration(t.durationMs)}</span>
              {editing ? (
                <IconButton icon={X} label={`Remove ${t.title}`} size="sm" onClick={() => editing.onRemove(i)} />
              ) : (
                <TrackMenuButton track={t} ctx={playlistId ? { playlistId, playlistIndex: i } : undefined} />
              )}
            </span>
          </div>
        );
      })}
      {!editing && limit < tracks.length && <div ref={sentinel} className="aw-tracks__more" aria-hidden />}
    </div>
  );
}

/** Animated "now playing" bars (still while paused). */
export function NowBars({ playing }: { playing: boolean }) {
  return (
    <span className={cx('aw-nowbars', playing && 'is-playing')} aria-label={playing ? 'Playing' : 'Paused'}>
      <i />
      <i />
      <i />
    </span>
  );
}
