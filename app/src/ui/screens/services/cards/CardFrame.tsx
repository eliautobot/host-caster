import type { ReactNode } from 'react';
import { Check, Info, Minus, TriangleAlert } from 'lucide-react';
import { Badge, Card, cx } from '../../../components';
import { ServiceTile, type ServiceKind } from '../parts';

export type CardStatus = 'connected' | 'off' | 'available' | 'attention';

const BADGE: Record<CardStatus, { label: string; tone: 'ok' | 'neutral' | 'warm' }> = {
  connected: { label: 'Connected', tone: 'ok' },
  available: { label: 'Ready', tone: 'ok' },
  off: { label: 'Not connected', tone: 'neutral' },
  attention: { label: 'Needs setup', tone: 'warm' },
};

export function ServiceCard({
  kind,
  tile,
  title,
  status,
  statusLine,
  children,
  id,
}: {
  kind?: ServiceKind;
  tile?: ReactNode;
  title: string;
  status?: CardStatus;
  statusLine?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const b = status ? BADGE[status] : undefined;
  return (
    <Card className="aw-svc-card" id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="aw-svc-card__head">
        {tile ?? (kind && <ServiceTile kind={kind} />)}
        <div className="aw-svc-card__titles">
          <h3 className="aw-svc-card__title" id={id ? `${id}-title` : undefined}>
            {title}
          </h3>
          {statusLine && <p className="aw-svc-card__status">{statusLine}</p>}
        </div>
        {b && (
          <Badge tone={b.tone} dot={status === 'connected' || status === 'available'}>
            {b.label}
          </Badge>
        )}
      </div>
      {children}
    </Card>
  );
}

/** "What it can do" chips. */
export function Caps({ items }: { items: [string, boolean?][] }) {
  return (
    <div className="aw-svc-caps" aria-label="What it can do">
      {items.map(([label, ok = true]) => (
        <span key={label} className={cx('aw-svc-cap', !ok && 'aw-svc-cap--no')}>
          {ok ? <Check aria-hidden /> : <Minus aria-hidden />}
          {label}
        </span>
      ))}
    </div>
  );
}

export function Note({ children, plain }: { children: ReactNode; plain?: boolean }) {
  return (
    <div className={cx('aw-svc-note', plain && 'aw-svc-note--plain')}>
      {plain ? <Info aria-hidden /> : <TriangleAlert aria-hidden />}
      <div>{children}</div>
    </div>
  );
}

export function CardText({ children }: { children: ReactNode }) {
  return <p className="aw-svc-card__desc">{children}</p>;
}
