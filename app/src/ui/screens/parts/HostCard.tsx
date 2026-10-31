import { Plus } from 'lucide-react';
import type { Host, Level } from '@/core/types';
import { navigate } from '@/state/router';
import { Avatar, Card } from '../../components';
import { NoAiLine } from '../../radio/fallback';
import './cards.css';

export function Meter({ value, label }: { value: Level; label: string }) {
  return (
    <span className="aw-meter" role="img" aria-label={`${label} ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= value ? 'on' : undefined} />
      ))}
    </span>
  );
}

export function HostCard({ host, speaking }: { host: Host; speaking?: boolean }) {
  return (
    <Card onClick={() => navigate(`/hosts/${host.id}`)} className="aw-hostcard">
      <Avatar avatar={host.avatar} name={host.name} size={64} speaking={speaking} />
      <div>
        <h3 className="aw-hostcard__name">{host.name}</h3>
        <p className="aw-hostcard__tagline">{host.tagline}</p>
        <NoAiLine host={host} />
      </div>
      <div className="aw-hostcard__meta">
        <span>Energy</span>
        <Meter value={host.energy} label="Energy" />
      </div>
    </Card>
  );
}

export function NewCard({ title, description, onClick }: { title: string; description: string; onClick: () => void }) {
  return (
    <Card onClick={onClick} className="aw-newcard">
      <span className="aw-newcard__icon">
        <Plus size={22} aria-hidden />
      </span>
      <span>
        <span className="aw-newcard__title">{title}</span>
        <br />
        <span className="aw-newcard__desc">{description}</span>
      </span>
    </Card>
  );
}
