import { ArrowUp, Plus, X } from 'lucide-react';
import { brainLabel, isFallback } from '@/core/ai';
import { useBrains } from '@/state/brains';
import { useHosts } from '@/state/hosts';
import { navigate } from '@/state/router';
import { Avatar, Badge, Button, Chip, IconButton } from '../../components';
import { lineup } from '../../screens/parts/StationCard';
import { hasAi } from '../fallback';

/** The line-up: 1 to 4 hosts, the first one leads. */
export function StationHosts({ hostIds, onChange }: { hostIds: string[]; onChange: (ids: string[]) => void }) {
  const hosts = useHosts((s) => s.hosts);
  const brains = useBrains((s) => s.brains);
  const on = lineup(hosts, hostIds);
  const off = hosts.filter((h) => !hostIds.includes(h.id));
  const brainName = (id: string | null) => {
    const b = brains.find((x) => x.id === id);
    return b && !isFallback(b) ? brainLabel(b) : 'No AI yet, reads scripted lines';
  };
  const noAi = on.every((h) => !hasAi(h, brains));
  const shared = on.length > 1 && new Set(on.map((h) => h.brainId)).size === 1;
  return (
    <>
      <div className="aw-entries">
        {on.map((h, i) => (
          <div key={h.id} className="aw-entry">
            <Avatar avatar={h.avatar} name={h.name} size={40} />
            <div className="aw-entry__text">
              <p className="aw-entry__title">
                {h.name} {i === 0 && <Badge tone="warm">Lead</Badge>}
              </p>
              <p className="aw-entry__meta aw-truncate">{brainName(h.brainId)}</p>
            </div>
            {i > 0 && <IconButton icon={ArrowUp} label={`Make ${h.name} the lead`} size="sm" onClick={() => onChange([h.id, ...hostIds.filter((x) => x !== h.id)])} />}
            <IconButton icon={X} label={`Take ${h.name} off the mic`} size="sm" disabled={on.length <= 1} onClick={() => onChange(hostIds.filter((x) => x !== h.id))} />
          </div>
        ))}
      </div>
      {on.length < 4 && (
        <div className="aw-hstack">
          {off.map((h) => (
            <Chip key={h.id} icon={Plus} onClick={() => onChange([...hostIds, h.id].slice(0, 4))}>
              {h.name}
            </Chip>
          ))}
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => navigate('/hosts/new')}>
            New host
          </Button>
        </div>
      )}
      {on.length > 1 && (
        <p className="aw-field__hint">
          {noAi
            ? 'Connect an AI in Brains to bring them to life. Until then they read short scripted lines.'
            : shared
              ? 'They share a brain, so each break is written as one conversation.'
              : 'Each host thinks with their own brain and they take turns.'}
        </p>
      )}
    </>
  );
}
