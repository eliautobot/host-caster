// "YouTube hidden" chip (phone and desktop apps): shows while the listener has closed the YouTube window. YouTube
// songs wait meanwhile (a YouTube song plays only from a player on screen); a tap shows the video again and they play
// again. The window itself is core/services/youtube/host.ts.
import { useSyncExternalStore } from 'react';
import { EyeOff } from 'lucide-react';
import { onVideoWindow, setVideoHidden, videoHidden, videoWindow } from '@/core/services/youtube/videoWindow';
import { cx } from '../components';
import './youtubeWindow.css';

export function useVideoHidden(): boolean {
  return useSyncExternalStore(onVideoWindow, () => videoHidden(videoWindow()));
}

export function YouTubeHiddenChip({ variant }: { variant: 'mini' | 'bar' | 'sheet' }) {
  const hidden = useVideoHidden();
  if (!hidden) return null;
  return (
    <button
      type="button"
      className={cx('aw-yt-chip', `aw-yt-chip--${variant}`)}
      onClick={() => setVideoHidden(false)}
      aria-label="YouTube hidden. Show the video"
      title="Show the video. YouTube songs play again."
    >
      <EyeOff aria-hidden />
      <span className="aw-yt-chip__label">YouTube hidden</span>
      <span className="aw-yt-chip__action" aria-hidden>
        Show
      </span>
    </button>
  );
}
