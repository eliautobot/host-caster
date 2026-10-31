// Voice clips (host breaks) on the voice bus of the audio graph, over the music.
import { isRoutableUrl, type AudioGraph } from './graph';

export class VoiceChannel {
  private routedEl?: HTMLAudioElement;
  private directEl?: HTMLAudioElement;
  private stopCurrent?: () => void;
  /** a clip is playing right now */
  playing = false;

  constructor(
    private graph: AudioGraph | null,
    private onActivity: (playing: boolean) => void,
    /** master volume for clips that cannot go through the graph (cross-origin URLs, no Web Audio) */
    private level: () => number = () => 1,
  ) {}

  /** Plays `src` and resolves when it ends (or is stopped). Rejects when the clip cannot play. */
  async play(src: Blob | string): Promise<void> {
    this.stop();
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    const owned = typeof src !== 'string';
    const routable = Boolean(this.graph?.supported) && isRoutableUrl(url);
    let el: HTMLAudioElement;
    if (routable) {
      if (!this.routedEl) {
        const fresh = new Audio();
        // route() returns undefined when the context cannot start; that element then plays directly
        this.graph?.route(fresh, 'voice');
        this.routedEl = fresh;
      }
      el = this.routedEl;
      await this.graph?.resume();
    } else {
      el = this.directEl ??= new Audio();
      el.volume = Math.max(0, Math.min(1, this.level()));
    }
    el.setAttribute('playsinline', '');

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          el.removeEventListener('ended', onEnd);
          el.removeEventListener('error', onErr);
          this.stopCurrent = undefined;
          this.setPlaying(false);
        };
        const onEnd = () => {
          cleanup();
          resolve();
        };
        const onErr = () => {
          cleanup();
          reject(new Error('The voice clip could not be played'));
        };
        this.stopCurrent = () => {
          el.pause();
          cleanup();
          resolve();
        };
        el.addEventListener('ended', onEnd);
        el.addEventListener('error', onErr);
        el.src = url;
        this.setPlaying(true);
        el.play().catch((err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    } finally {
      if (owned) URL.revokeObjectURL(url);
    }
  }

  stop(): void {
    this.stopCurrent?.();
  }

  private setPlaying(on: boolean) {
    this.playing = on;
    this.onActivity(on);
  }
}
