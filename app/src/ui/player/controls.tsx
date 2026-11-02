// Transport, scrubber and volume shared by the desktop bar and Now Playing.
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume, Volume1, Volume2, VolumeX } from 'lucide-react';
import { player } from '@/core/player';
import { formatDuration } from '@/core/util/time';
import { usePlayer } from '@/state/player';
import { runAction } from '../actions';
import { Badge, IconButton, Slider, cx } from '../components';
import { controlOtherApp, otherAppPosition, useOtherApp } from './otherApp';
import { usePlayerView } from './usePlayerView';

export function Transport({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const v = usePlayerView();
  const p = v.p;
  const big = size === 'lg';
  const repeat = p.repeat ?? 'off';
  return (
    <div className={cx('aw-transport', big && 'aw-transport--lg')}>
      <IconButton
        icon={Shuffle}
        label={p.shuffle ? 'Shuffle on (S)' : 'Shuffle off (S)'}
        size={big ? 'md' : 'sm'}
        active={Boolean(p.shuffle)}
        disabled={Boolean(v.other)}
        onClick={() => player.toggleShuffle()}
      />
      <IconButton
        icon={SkipBack}
        label="Previous (Shift+Left)"
        size={big ? 'lg' : 'md'}
        iconProps={{ fill: 'currentColor' }}
        disabled={!v.canSkip}
        onClick={v.prev}
      />
      <IconButton
        icon={v.playing ? Pause : Play}
        label={v.playing ? 'Pause (Space)' : v.track ? 'Play (Space)' : 'Go on air'}
        variant="primary"
        size={big ? 'xl' : 'md'}
        className="aw-transport__play"
        iconProps={{ fill: 'currentColor', strokeWidth: 0 }}
        onClick={v.toggle}
      />
      <IconButton
        icon={SkipForward}
        label={p.holding ? 'Skip the break (Shift+Right)' : 'Next (Shift+Right)'}
        size={big ? 'lg' : 'md'}
        iconProps={{ fill: 'currentColor' }}
        disabled={!v.canSkip}
        onClick={v.next}
      />
      <IconButton
        icon={repeat === 'one' ? Repeat1 : Repeat}
        label={repeat === 'off' ? 'Repeat off (R)' : repeat === 'all' ? 'Repeat all (R)' : 'Repeat one (R)'}
        size={big ? 'md' : 'sm'}
        active={repeat !== 'off'}
        disabled={Boolean(v.other)}
        onClick={() => player.cycleRepeat()}
      />
    </div>
  );
}

export function Scrubber({ variant = 'bar' }: { variant?: 'bar' | 'sheet' }) {
  const own = usePlayer();
  const other = useOtherApp();
  const [scrub, setScrub] = useState<number>();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!other?.playing) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [other?.playing]);
  // any-app station: the other app's song (its position keeps moving between its reports)
  const p = other
    ? { live: !other.durationMs, positionMs: otherAppPosition(other), durationMs: other.durationMs ?? 0, track: other }
    : own;
  const seek = (ms: number) => (other ? void runAction(() => controlOtherApp('seek', ms)) : player.seek(ms));
  // the song the finger is on: a scrub never outlives it (a new song starts with its own bar)
  const songKey = other ? `other:${other.key}` : (own.track?.id ?? '');
  const scrubFor = useRef(songKey);
  useEffect(() => setScrub(undefined), [songKey]);
  const pos = scrub ?? p.positionMs;
  if (p.live) {
    return (
      <div className={cx('aw-scrub', `aw-scrub--${variant}`, 'aw-scrub--live')}>
        <Badge tone="accent" dot="live">
          Live
        </Badge>
        <span className="aw-scrub__livebar" aria-hidden />
        <span className="aw-tabular">{formatDuration(p.positionMs)}</span>
      </div>
    );
  }
  const slider = (
    <Slider
      label="Seek"
      value={Math.min(pos, Math.max(1, p.durationMs))}
      max={Math.max(1, p.durationMs)}
      step={1000}
      disabled={!p.track}
      thumb={variant === 'sheet'}
      onChange={(ms) => {
        scrubFor.current = songKey;
        setScrub(ms);
      }}
      onCommit={(ms) => {
        if (scrubFor.current === songKey) seek(ms);
        setScrub(undefined);
      }}
    />
  );
  if (variant === 'sheet') {
    return (
      <div className="aw-scrub aw-scrub--sheet">
        {slider}
        <div className="aw-scrub__times aw-tabular">
          <span>{formatDuration(pos)}</span>
          <span>{formatDuration(p.durationMs)}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="aw-scrub aw-scrub--bar">
      <span className="aw-tabular">{formatDuration(pos)}</span>
      {slider}
      <span className="aw-tabular">{formatDuration(p.durationMs)}</span>
    </div>
  );
}

export function VolumeControl({ width }: { width?: number }) {
  const p = usePlayer();
  const vol = p.volume ?? 0.85;
  const muted = Boolean(p.muted) || vol === 0;
  const Icon = muted ? VolumeX : vol < 0.34 ? Volume : vol < 0.67 ? Volume1 : Volume2;
  return (
    <div className="aw-volume" style={width ? { width } : undefined}>
      <IconButton icon={Icon} label={muted ? 'Unmute (M)' : 'Mute (M)'} size="sm" onClick={() => player.setMuted(!muted)} />
      <Slider label="Volume" value={muted ? 0 : vol} onChange={(x) => player.setVolume(x)} />
    </div>
  );
}
