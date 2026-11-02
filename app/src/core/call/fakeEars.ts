// Ears that hear what a test types in: unit tests, and the end-to-end tests of debug builds (nobody can speak into a
// phone or a headless browser from a script). `hear(text)` plays out like speech: a few partial captions, then the
// end of the utterance.
import type { Ears, ListenOptions } from './session';

export class FakeEars implements Ears {
  kind = 'fake' as const;
  overlap: boolean;
  private pending?: { opts: ListenOptions; resolve: (t: string) => void; reject: (e: Error) => void; heard: string };
  private waiting: string[] = [];
  /** ms between partial captions */
  private step: number;

  constructor(opts: { overlap?: boolean; step?: number } = {}) {
    this.overlap = opts.overlap ?? true;
    this.step = opts.step ?? 40;
  }

  /** Is a listen open right now (the call waits for the listener)? */
  get listening(): boolean {
    return Boolean(this.pending);
  }

  listen(opts: ListenOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => done(this.pending?.heard ?? ''), opts.maxMs);
      const done = (t: string) => {
        clearTimeout(timer);
        if (this.pending?.opts === opts) this.pending = undefined;
        resolve(t);
      };
      if (opts.signal.aborted) return reject(new Error('aborted'));
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        if (this.pending?.opts === opts) this.pending = undefined;
        reject(new Error('aborted'));
      });
      opts.finish.addEventListener('abort', () => done(this.pending?.opts === opts ? this.pending.heard : ''));
      this.pending = { opts, resolve: done, reject, heard: '' };
      const next = this.waiting.shift();
      if (next !== undefined) void this.play(next);
    });
  }

  /** The listener says `text` (now, or at the next listen). */
  hear(text: string): Promise<void> {
    if (!this.pending) {
      this.waiting.push(text);
      return Promise.resolve();
    }
    return this.play(text);
  }

  private async play(text: string): Promise<void> {
    const p = this.pending;
    if (!p) return;
    const words = text.split(/\s+/).filter(Boolean);
    for (let i = 1; i <= words.length; i++) {
      if (this.pending !== p) return;
      p.heard = words.slice(0, i).join(' ');
      p.opts.onPartial(p.heard);
      if (i < words.length) await new Promise((r) => setTimeout(r, this.step));
    }
    if (this.pending === p) p.resolve(text);
  }
}
