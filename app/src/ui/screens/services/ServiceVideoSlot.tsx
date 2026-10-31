// Where the YouTube video shows (Now Playing art area). The iframe itself lives in a fixed host and is laid over
// this element, so mounting/unmounting this never reloads the video.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { artworkUrl } from '@/core/services/artwork';
import { attachYouTubeSlot } from '@/core/services/youtube/host';
import type { Track } from '@/core/types';
import './services.css';

export function ServiceVideoSlot({ track, className }: { track?: Track; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [bg, setBg] = useState<string>();
  useEffect(() => {
    const el = ref.current;
    if (!el || track?.source !== 'youtube') return;
    return attachYouTubeSlot(el);
  }, [track?.source]);
  useEffect(() => {
    let live = true;
    void artworkUrl(track?.artworkId).then((u) => live && setBg(u));
    return () => {
      live = false;
    };
  }, [track?.artworkId]);
  if (track?.source !== 'youtube') return null;
  return (
    <div ref={ref} className={['aw-yt-slot', className].filter(Boolean).join(' ')} data-testid="youtube-slot">
      {bg && <div className="aw-yt-slot__bg" style={{ backgroundImage: `url(${bg})` } as CSSProperties} aria-hidden />}
    </div>
  );
}
