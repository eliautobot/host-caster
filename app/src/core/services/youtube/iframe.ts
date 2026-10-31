// YouTube IFrame Player API: minimal typings, states, error codes, script loader.
// https://developers.google.com/youtube/iframe_api_reference
import { PlaybackError } from '../../player/errors';
import { loadScriptOnce } from '../adapterkit';

export interface YtPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  getVolume?(): number;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  cueVideoById(opts: { videoId: string; startSeconds?: number }): void;
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  getIframe?(): HTMLIFrameElement;
  destroy(): void;
}
export interface YtPlayerOptions {
  width?: string | number;
  height?: string | number;
  videoId?: string;
  host?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (e: { target: YtPlayer }) => void;
    onStateChange?: (e: { data: number; target: YtPlayer }) => void;
    onError?: (e: { data: number }) => void;
    onAutoplayBlocked?: () => void;
  };
}
export type YtPlayerCtor = new (el: HTMLElement | string, opts: YtPlayerOptions) => YtPlayer;

export const YT_STATE = { unstarted: -1, ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 } as const;

/** Plain words for IFrame API error codes. */
export function youTubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'This YouTube video id is not valid.';
    case 5:
      return 'This YouTube video cannot play in this browser.';
    case 100:
      return 'This YouTube video was removed or is private.';
    case 101:
    case 150:
      return 'The owner of this video does not allow playback outside YouTube.';
    case 152:
    case 153:
      return 'YouTube refused to play here (embedding blocked for this app).';
    default:
      return `YouTube could not play this video (error ${code}).`;
  }
}

/**
 * Errors about this one video (bad id, removed, private, embedding off) mean it cannot play here: the player leaves it
 * out and plays on. 5 (a player hiccup) and 152/153 (this whole app refused, e.g. no referrer) are not the video's
 * fault, so they are not remembered against it.
 */
export function youTubeError(code: number): PlaybackError {
  const videoOnly = code === 2 || code === 100 || code === 101 || code === 150;
  return new PlaybackError(youTubeErrorMessage(code), videoOnly ? 'unplayable' : 'failed', code);
}

export async function loadRealApi(): Promise<YtPlayerCtor> {
  const w = window as unknown as { YT?: { Player?: YtPlayerCtor } };
  if (!w.YT?.Player) await loadScriptOnce('https://www.youtube.com/iframe_api', 20000, 'onYouTubeIframeAPIReady');
  if (!w.YT?.Player) throw new Error('YouTube player did not load (offline or blocked).');
  return w.YT.Player;
}
