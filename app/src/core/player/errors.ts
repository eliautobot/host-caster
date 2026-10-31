// Why a song did not start, so the player knows what to do next:
//   unplayable    = this song can never play here (embedding off, removed, private, region): leave it out, play on
//   needs-gesture = the browser wants a tap before sound (autoplay rules): pause and ask, skipping would not help
//   failed        = anything else (network, slow server): play on when the start was automatic

export type PlaybackErrorKind = 'unplayable' | 'needs-gesture' | 'failed';

export class PlaybackError extends Error {
  override name = 'PlaybackError';
  constructor(
    message: string,
    readonly kind: PlaybackErrorKind,
    /** the service's own code (YouTube 101/150 ...) */
    readonly code?: number,
  ) {
    super(message);
  }
}

export function playbackErrorKind(err: unknown): PlaybackErrorKind {
  if (err instanceof PlaybackError) return err.kind;
  const kind = (err as { kind?: unknown } | null)?.kind;
  return kind === 'unplayable' || kind === 'needs-gesture' ? kind : 'failed';
}
