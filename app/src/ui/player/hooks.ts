// Player chrome hooks: keyboard shortcuts (desktop) and error toasts.
import { useEffect } from 'react';
import { toggleLike } from '@/core/library';
import { player } from '@/core/player';
import { setYouTubeMiniOpen } from '@/core/services/youtube/host';
import { navigate, useRoute } from '@/state/router';
import { runAction } from '../actions';
import { toast } from '../components';

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Space/K play-pause, J/L or Left/Right seek 10 s, Shift+Left/Right previous/next, M mute, S shuffle, R repeat,
 * +/- volume, Shift+L like, Q queue. Ignored while typing, inside dialogs and with Ctrl/Cmd/Alt.
 */
export function usePlayerShortcuts(): void {
  const path = useRoute((r) => r.path);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      const inDialog = (e.target as HTMLElement | null)?.closest?.('[role=dialog]:not(.aw-sheet--full), [role=menu]');
      if (inDialog) return;
      const s = player.state;
      const key = e.key;
      let handled = true;
      if (key === ' ' || key === 'k' || key === 'K') {
        // let buttons and links handle Space themselves
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (key === ' ' && (tag === 'BUTTON' || tag === 'A' || (e.target as HTMLElement).getAttribute?.('role') === 'button')) return;
        void runAction(() => player.toggle());
      } else if (e.shiftKey && (key === 'ArrowRight' || key === 'N')) void runAction(() => player.next());
      else if (e.shiftKey && (key === 'ArrowLeft' || key === 'P')) void runAction(() => player.prev());
      else if (key === 'ArrowRight' || key === 'l') player.seekBy(10_000);
      else if (key === 'ArrowLeft' || key === 'j') player.seekBy(-10_000);
      else if (key === 'm' || key === 'M') player.setMuted(!s.muted);
      else if (key === 's' || key === 'S') player.toggleShuffle();
      else if (key === 'r' || key === 'R') player.cycleRepeat();
      else if (key === '=' || key === '+') player.setVolume(Math.min(1, (s.volume ?? 0.85) + 0.05));
      else if (key === '-' || key === '_') player.setVolume(Math.max(0, (s.volume ?? 0.85) - 0.05));
      else if (key === 'L' && e.shiftKey && s.track) void runAction(() => toggleLike(s.track!));
      else if (key === 'q' || key === 'Q') navigate(path === '/now-playing' ? '/now-playing' : '/now-playing?tab=queue');
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path]);
}

/** Playback failures become a toast (the player already skipped to the next song). */
export function usePlayerErrors(): void {
  useEffect(() => {
    let last = '';
    let at = 0;
    const offError = player.on('error', (err) => {
      const now = Date.now();
      if (err.message === last && now - at < 3000) return;
      last = err.message;
      at = now;
      toast.error('Could not play that song', err.message);
    });
    // a song that cannot play here was left out; the music already moved on, so a short note is enough
    const offSkip = player.on('skipped', ({ track, reason }) => toast({ title: `Skipped ${track.title}`, description: reason, duration: 4000 }));
    // phone apps: the YouTube mini window opens Now Playing; a YouTube song that waited long off screen is offered
    setYouTubeMiniOpen(() => navigate('/now-playing'));
    const offWait = player.on('state', (s) => {
      if (s.waiting !== 'resume') {
        if (!s.waiting) resumeOffered = undefined;
        return;
      }
      if (resumeOffered === s.track?.id) return;
      resumeOffered = s.track?.id;
      toast({
        title: 'YouTube paused while Host-Caster was closed',
        description: s.track ? `${s.track.title} is ready to play on.` : undefined,
        duration: 10_000,
        action: { label: 'Resume', onClick: () => void player.play() },
      });
    });
    return () => {
      offError();
      offSkip();
      offWait();
      setYouTubeMiniOpen(undefined);
    };
  }, []);
}

/** one offer per waiting song (PlayerBar and MiniPlayer may both listen) */
let resumeOffered: string | undefined;
