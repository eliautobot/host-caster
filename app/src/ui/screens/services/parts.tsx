// Shared bits for the music-service screens (owner: services builder).
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AudioWaveform, Music2, RadioReceiver, Server, SquarePlay, type LucideIcon } from 'lucide-react';
import { player } from '@/core/player';
import type { Track } from '@/core/types';
import { Artwork, Button, EmptyState, Skeleton, cx } from '../../components';
import { runAction } from '../../actions';
import { usePlayContext } from '../../library/play';
import './services.css';

export type ServiceKind = 'subsonic' | 'radio' | 'youtube' | 'spotify';

export const SERVICE_META: Record<ServiceKind, { name: string; icon: LucideIcon; tone: string }> = {
  subsonic: { name: 'Your music server', icon: Server, tone: 'graphite' },
  radio: { name: 'Internet radio', icon: RadioReceiver, tone: 'signal' },
  youtube: { name: 'YouTube Music', icon: SquarePlay, tone: 'red' },
  spotify: { name: 'Spotify', icon: AudioWaveform, tone: 'green' },
};

/** Rounded tile with the service icon (brand-neutral, no logos). */
export function ServiceTile({ kind, size = 44 }: { kind: ServiceKind; size?: number }) {
  const { icon: Icon, tone } = SERVICE_META[kind];
  return (
    <span className={cx('aw-svc-tile', `aw-svc-tile--${tone}`)} style={{ width: size, height: size }} aria-hidden>
      <Icon />
    </span>
  );
}

export interface AsyncState<T> {
  data?: T;
  error?: unknown;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` when deps change; ignores stale results. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setState((s) => ({ data: s.data, loading: true }));
    fn().then(
      (data) => my === seq.current && setState({ data, loading: false }),
      (error: unknown) => my === seq.current && setState({ error, loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Something went wrong');
}

/** Remote cover with a quiet placeholder when the image is missing or broken (radio favicons often are). */
export function RemoteArt({ src, round, wide, icon: Icon = Music2, size = 48 }: { src?: string; round?: boolean; wide?: boolean; icon?: LucideIcon; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <span
      className={cx('aw-svc-art', round && 'aw-svc-art--round', wide && 'aw-svc-art--wide')}
      style={{ '--s': `${size}px` } as CSSProperties}
    >
      {src && !broken ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <Icon aria-hidden />}
    </span>
  );
}

export interface MediaRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** image URL (remote cover) */
  src?: string;
  artworkId?: string;
  /** round art (artists) */
  round?: boolean;
  /** wide 16:9 art (videos) */
  wide?: boolean;
  /** fallback icon / custom leading node */
  leading?: ReactNode;
  onOpen?: () => void;
  actions?: ReactNode;
  current?: boolean;
  dim?: boolean;
}

/** List row: art, two lines, trailing actions. Tapping the row opens (or plays). */
export function MediaRow({ title, subtitle, src, artworkId, round, wide, leading, onOpen, actions, current, dim }: MediaRowProps) {
  const art = leading ?? (src ? <RemoteArt src={src} round={round} wide={wide} /> : <Artwork artworkId={artworkId} size={48} radius={round ? 999 : 10} />);
  const body = (
    <>
      <span className="aw-svc-row__art">{art}</span>
      <span className="aw-svc-row__text">
        <span className="aw-svc-row__title">{title}</span>
        {subtitle && <span className="aw-svc-row__sub">{subtitle}</span>}
      </span>
    </>
  );
  return (
    <div className={cx('aw-svc-row', current && 'is-current', dim && 'is-dim')} role="listitem">
      {onOpen ? (
        <button type="button" className="aw-svc-row__main" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="aw-svc-row__main">{body}</div>
      )}
      {actions && <div className="aw-svc-row__actions">{actions}</div>}
    </div>
  );
}

export function RowList({ children, label, busy }: { children: ReactNode; label: string; busy?: boolean }) {
  return (
    <div className={cx('aw-svc-list', busy && 'is-busy')} role="list" aria-label={label} aria-busy={busy || undefined}>
      {children}
    </div>
  );
}

export function RowSkeletons({ count = 6 }: { count?: number }) {
  return (
    <div className="aw-svc-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="aw-svc-row">
          <div className="aw-svc-row__main">
            <Skeleton width={48} height={48} radius={10} />
            <span className="aw-svc-row__text" style={{ gap: 6 }}>
              <Skeleton width={`${50 + ((i * 17) % 35)}%`} height={14} />
              <Skeleton width={`${30 + ((i * 11) % 25)}%`} height={12} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProblemState({ icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return <EmptyState icon={icon} title={title} description={description} actions={action} card size="compact" />;
}

const SOURCE_LABEL: Partial<Record<Track['source'], string>> = {
  subsonic: 'Your music server',
  youtube: 'YouTube',
  spotify: 'Spotify',
  stream: 'Internet radio',
};

/** Sets "Playing from" in Now Playing (tapping it comes back to this screen). */
export function setPlayedFrom(tracks: Track[], from?: string): void {
  const to = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') || undefined : undefined;
  usePlayContext.setState({ from: from ?? (tracks[0] && SOURCE_LABEL[tracks[0].source]), to });
}

/** Imports with `importFn`, then plays the result from `index`. `from` = "Playing from" label (playlist/album name). */
export async function importAndPlay(importFn: () => Promise<Track[]>, index = 0, from?: string): Promise<void> {
  const tracks = await importFn();
  if (!tracks.length) throw new Error('Nothing playable here.');
  setPlayedFrom(tracks, from);
  await player.playQueue(tracks, Math.min(index, tracks.length - 1));
}

export function PlayAction({ onPlay, label = 'Play' }: { onPlay: () => Promise<unknown>; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="primary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await runAction(onPlay);
        setBusy(false);
      }}
    >
      {label}
    </Button>
  );
}

/** Button that runs an async action with a spinner and an optional success toast. */
export function BusyButton({
  onRun,
  success,
  children,
  ...rest
}: { onRun: () => Promise<unknown>; success?: string; children?: ReactNode } & Omit<Parameters<typeof Button>[0], 'onClick' | 'children'>) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      {...rest}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await runAction(onRun, { success });
        setBusy(false);
      }}
    >
      {children}
    </Button>
  );
}

export function formatCount(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
