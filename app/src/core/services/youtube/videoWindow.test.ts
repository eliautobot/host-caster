// The YouTube window's close button and size, and how they reach the player (the screen rule's off screen path).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../../types';
import { bindYouTubeScreenRule } from './screenRule';
import { onVideoWindow, setVideoHidden, setVideoNeedsScreen, setVideoSize, videoHidden, videoWindow } from './videoWindow';

function fakePlayer() {
  return {
    screenOnly: undefined as ((t: Track) => boolean) | undefined,
    hidden: [] as boolean[],
    setScreenOnly(test: ((t: Track) => boolean) | undefined) {
      this.screenOnly = test;
    },
    setOnScreen: vi.fn(),
    setVideoHidden(h: boolean) {
      this.hidden.push(h);
    },
  };
}

const track = (source: Track['source']) => ({ source }) as Track;

describe('YouTube window state', () => {
  afterEach(() => {
    setVideoHidden(false);
    setVideoSize('large');
    setVideoNeedsScreen(false);
  });

  it('starts shown and large; hidden counts only where the visible player rule is on', () => {
    expect(videoWindow()).toMatchObject({ hidden: false, size: 'large' });
    setVideoHidden(true);
    expect(videoWindow().hidden).toBe(true);
    expect(videoHidden()).toBe(false); // web: no rule, nothing waits
    setVideoNeedsScreen(true);
    expect(videoHidden()).toBe(true);
    setVideoHidden(false);
    expect(videoHidden()).toBe(false);
  });

  it('tells listeners about each change once', () => {
    const seen: string[] = [];
    const off = onVideoWindow((s) => seen.push(`${s.hidden ? 'hidden' : 'shown'} ${s.size}`));
    setVideoSize('small');
    setVideoSize('small');
    setVideoHidden(true);
    setVideoHidden(true);
    off();
    setVideoHidden(false);
    expect(seen).toEqual(['shown small', 'hidden small']);
  });

  it('the player follows: YouTube needs the screen while the rule is on, and waits while the video is hidden', () => {
    const p = fakePlayer();
    const off = bindYouTubeScreenRule(p);
    expect(p.screenOnly).toBeUndefined(); // web
    setVideoNeedsScreen(true);
    expect(p.screenOnly?.(track('youtube'))).toBe(true);
    expect(p.screenOnly?.(track('local'))).toBe(false);
    setVideoHidden(true);
    setVideoHidden(false);
    expect(p.hidden.slice(-2)).toEqual([true, false]);
    // the size never stops a song
    const before = p.hidden.length;
    setVideoSize('small');
    expect(p.hidden.slice(before)).toEqual([false]);
    off();
    setVideoHidden(true);
    expect(p.hidden.at(-1)).toBe(false);
  });
});
