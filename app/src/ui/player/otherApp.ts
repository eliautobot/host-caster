// "Any music app" stations (Android): while one is on air, the player chrome shows and controls the song the other
// app (YouTube Music, Spotify ...) is playing instead of Host-Caster's own paused queue.
import { useEffect } from 'react';
import { create } from 'zustand';
import { anyApp, type AnyAppNowPlaying } from '@/core/native';
import { useRadio } from '@/state/radio';
import { useStation } from '@/state/stations';

const useOther = create<{ now?: AnyAppNowPlaying }>(() => ({}));
let offs: (() => void)[] = [];
let users = 0;

const put = (now: AnyAppNowPlaying) => useOther.setState({ now });

function follow() {
  if (users++ > 0) return;
  void anyApp.nowPlaying().then(
    (now) => now && put(now),
    () => undefined,
  );
  offs = [
    anyApp.on('trackchange', put),
    anyApp.on('trackupdate', put),
    anyApp.on('playstate', (e) => {
      const cur = useOther.getState().now;
      if (cur && cur.packageName === e.packageName) put({ ...cur, playing: e.playing, positionMs: e.positionMs, at: e.at || Date.now() });
    }),
  ];
}

function unfollow() {
  if (--users > 0) return;
  for (const off of offs) off();
  offs = [];
  useOther.setState({ now: undefined });
}

/** The other app's song while an any-app station is on air, else undefined. */
export function useOtherApp(): AnyAppNowPlaying | undefined {
  const onAir = useRadio((r) => r.onAir);
  const station = useStation(useRadio((r) => r.stationId));
  const active = anyApp.available && onAir && Boolean(station?.sources.some((s) => s.kind === 'anyapp'));
  useEffect(() => {
    if (!active) return;
    follow();
    return unfollow;
  }, [active]);
  const now = useOther((s) => s.now);
  return active ? now : undefined;
}

/** Where the other app's song is now (it keeps moving while playing). */
export function otherAppPosition(now: AnyAppNowPlaying, at = Date.now()): number {
  const pos = now.playing ? now.positionMs + Math.max(0, at - now.at) : now.positionMs;
  return now.durationMs ? Math.min(pos, now.durationMs) : pos;
}

/** Play/pause/next/prev/seek on the other app (optimistic play state until the app reports back). */
export async function controlOtherApp(action: 'play' | 'pause' | 'next' | 'prev' | 'seek', positionMs?: number): Promise<void> {
  const cur = useOther.getState().now;
  if (cur && (action === 'play' || action === 'pause')) put({ ...cur, playing: action === 'play', positionMs: otherAppPosition(cur), at: Date.now() });
  if (cur && action === 'seek' && positionMs != null) put({ ...cur, positionMs, at: Date.now() });
  const ok = await anyApp.control(action, positionMs);
  if (!ok) throw new Error('The music app did not respond');
}
