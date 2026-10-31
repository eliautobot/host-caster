// Shared bits for the Account, Connections and Data pages (owner: server agent). Class prefix: aw-acct-.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Info, type LucideIcon } from 'lucide-react';
import { Badge, Button, Card, Sheet, cx } from '../../../components';
import './account.css';

export type Tone = 'ok' | 'neutral' | 'warm' | 'danger';

/** A settings card: icon tile, title, one status line, optional badge, body. */
export function SectionCard({
  icon: Icon,
  tone = 'neutral',
  title,
  status,
  badge,
  children,
  id,
}: {
  icon: LucideIcon;
  tone?: 'neutral' | 'signal' | 'ok' | 'warm';
  title: ReactNode;
  status?: ReactNode;
  badge?: { label: string; tone: Tone; dot?: boolean };
  children?: ReactNode;
  id?: string;
}) {
  return (
    <Card className="aw-acct-card" id={id}>
      <div className="aw-acct-card__head">
        <span className={cx('aw-acct-tile', `aw-acct-tile--${tone}`)} aria-hidden>
          <Icon />
        </span>
        <div className="aw-acct-card__titles">
          <h3 className="aw-acct-card__title">{title}</h3>
          {status && <p className="aw-acct-card__status">{status}</p>}
        </div>
        {badge && (
          <Badge tone={badge.tone === 'warm' ? 'warm' : badge.tone} dot={badge.dot}>
            {badge.label}
          </Badge>
        )}
      </div>
      {children}
    </Card>
  );
}

export function Hint({ children, icon: Icon = Info }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <p className="aw-acct-hint">
      <Icon aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="aw-acct-actions">{children}</div>;
}

/** Confirm dialog for destructive or big actions. */
export function ConfirmSheet({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      description={description}
      size="sm"
      footer={
        <div className="aw-acct-sheet-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            data-autofocus
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children}
    </Sheet>
  );
}

/** Copy-to-clipboard button that says "Copied" for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      icon={done ? Check : Copy}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // older WebViews: select-and-copy fallback
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.append(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export interface Loaded<T> {
  data?: T;
  error?: unknown;
  loading: boolean;
  reload: () => void;
}

/** Runs fn when deps change; stale results are dropped. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
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

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? 'Something went wrong'));

export function timeAgo(ms: number | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
