import { Plus, UsersRound } from 'lucide-react';
import { useHosts } from '@/state/hosts';
import { useRadio } from '@/state/radio';
import { navigate } from '@/state/router';
import { Button, EmptyState } from '../components';
import { Page } from '../layout/Page';
import { HostCard, NewCard } from './parts/HostCard';
import type { ScreenProps } from '.';
import './parts/cards.css';

export default function Hosts(_: ScreenProps) {
  const { hosts, ready } = useHosts();
  const speakingId = useRadio((r) => r.speakingHostId);
  return (
    <Page
      title="Hosts"
      subtitle="The voices of your stations. Give them a personality, a brain and a voice."
      actions={
        <Button variant="primary" icon={Plus} onClick={() => navigate('/hosts/new')}>
          New host
        </Button>
      }
    >
      {ready && hosts.length === 0 ? (
        <EmptyState icon={UsersRound} title="No hosts yet" description="Create a host to give your station a voice." />
      ) : (
        <div className="aw-grid aw-grid--hosts">
          {hosts.map((h) => (
            <HostCard key={h.id} host={h} speaking={h.id === speakingId} />
          ))}
          <NewCard title="New host" description="Design a personality" onClick={() => navigate('/hosts/new')} />
        </div>
      )}
    </Page>
  );
}
