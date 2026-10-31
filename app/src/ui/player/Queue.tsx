// The play queue: now playing, then up next (drag to reorder, remove, jump).
import { memo } from 'react';
import { GripVertical, ListMusic, Radio, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { player } from '@/core/player';
import { formatDuration } from '@/core/util/time';
import { usePlayer } from '@/state/player';
import { runAction } from '../actions';
import { Artwork, Button, EmptyState, IconButton, cx } from '../components';
import { NowBars } from '../library/TrackList';
import { usePlayContext } from '../library/play';
import { useReorder } from '../library/useReorder';
import './player.css';

const MAX_ROWS = 200;

/** Memoized, and reads only queue/index/track: position ticks do not re-render up to 200 rows. */
export const Queue = memo(function Queue() {
  const p = usePlayer(useShallow((s) => ({ queue: s.queue, index: s.index, track: s.track, status: s.status, repeat: s.repeat })));
  const from = usePlayContext((s) => s.from);
  const start = p.index + 1;
  const upcoming = p.queue.slice(start, start + MAX_ROWS);
  const more = p.queue.length - start - upcoming.length;
  const reorder = useReorder(upcoming.length, (a, b) => player.moveInQueue(start + a, start + b));
  const cur = p.track;

  if (!cur) {
    return <EmptyState size="compact" icon={ListMusic} title="Nothing is playing" description="Pick a song, an album or a station." />;
  }

  return (
    <div className="aw-queue">
      <p className="aw-queue__label">Now playing</p>
      <div className="aw-qrow is-current">
        <Artwork artworkId={cur.artworkId} size={44} radius={8} icon={cur.source === 'stream' ? Radio : undefined} />
        <div className="aw-qrow__text">
          <span className="aw-qrow__title aw-truncate">{cur.title}</span>
          <span className="aw-qrow__sub aw-truncate">{cur.artist}</span>
        </div>
        <NowBars playing={p.status === 'playing'} />
      </div>

      <div className="aw-queue__head">
        <p className="aw-queue__label">{from ? `Up next from ${from}` : 'Up next'}</p>
        {upcoming.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => player.clearUpcoming()}>
            Clear
          </Button>
        )}
      </div>
      {upcoming.length === 0 ? (
        <p className="aw-queue__empty">
          {p.repeat === 'all' && p.queue.length > 1 ? 'The queue starts over after this song.' : 'Nothing up next. Use Play next or Add to queue on any song.'}
        </p>
      ) : (
        <div className="aw-queue__list" role="list" aria-label="Up next">
          {upcoming.map((t, i) => (
            <div key={`${t.id}-${start + i}`} data-row role="listitem" className={cx('aw-qrow', reorder.draggingIndex === i && 'is-dragging')} style={reorder.rowStyle(i)}>
              <span className="aw-qrow__grip" {...reorder.handleProps(i)} tabIndex={0} role="button">
                <GripVertical aria-hidden />
              </span>
              <button type="button" className="aw-qrow__main" onClick={() => runAction(() => player.jumpTo(start + i))} aria-label={`Play ${t.title} now`}>
                <Artwork artworkId={t.artworkId} size={40} radius={6} icon={t.source === 'stream' ? Radio : undefined} />
                <span className="aw-qrow__text">
                  <span className="aw-qrow__title aw-truncate">{t.title}</span>
                  <span className="aw-qrow__sub aw-truncate">{t.artist}</span>
                </span>
              </button>
              <span className="aw-qrow__dur aw-tabular">{t.source === 'stream' ? 'Live' : formatDuration(t.durationMs)}</span>
              <IconButton icon={X} label={`Remove ${t.title} from the queue`} size="sm" className="aw-qrow__remove" onClick={() => player.removeFromQueue(start + i)} />
            </div>
          ))}
          {more > 0 && <p className="aw-queue__empty">and {more.toLocaleString()} more</p>}
        </div>
      )}
    </div>
  );
});
