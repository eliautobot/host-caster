// The scripted fallback, explained where it matters: a dismissible Home banner while the hosts on the station have no
// AI brain, and a line on each host card without one. It is never a choice; connecting an AI is the fix.
import { useEffect, useState } from 'react';
import { AudioLines, X } from 'lucide-react';
import { hasAi, showFallbackBanner } from '@/core/ai';
import { kvGet, kvSet } from '@/core/db';
import type { Host } from '@/core/types';
import { useBrains } from '@/state/brains';
import { navigate } from '@/state/router';
import { Button, IconButton } from '../components';
import './fallback.css';

export const FALLBACK_BANNER_KEY = 'ui:fallback-banner-dismissed';
export const FALLBACK_EXPLAINER =
  'Until an AI is connected, the hosts read short scripted lines (song, time, weather, your day) so the music never goes quiet.';

export { hasAi, showFallbackBanner };

/** Hosts (of `hosts`) with no AI brain; empty until the brains are loaded so nothing flashes. */
export function useNoAiHosts(hosts: Host[]): Host[] {
  const { brains, ready } = useBrains();
  return ready ? hosts.filter((h) => !hasAi(h, brains)) : [];
}

/** Home: "Your hosts are reading scripted lines" while none of the hosts on the mic has an AI brain. */
export function FallbackBanner({ hosts }: { hosts: Host[] }) {
  const { brains, ready } = useBrains();
  const [dismissed, setDismissed] = useState<boolean | undefined>();
  useEffect(() => {
    let live = true;
    void kvGet<boolean>(FALLBACK_BANNER_KEY).then((r) => live && setDismissed(Boolean(r?.value)));
    return () => {
      live = false;
    };
  }, []);
  if (!ready || dismissed === undefined || !showFallbackBanner(hosts, brains, dismissed)) return null;
  return (
    <div className="aw-fallback-banner" role="status" data-fallback-banner>
      <span className="aw-fallback-banner__icon" aria-hidden>
        <AudioLines />
      </span>
      <span className="aw-fallback-banner__text">Your hosts are reading scripted lines. Connect an AI to bring them to life.</span>
      <Button size="sm" variant="primary" onClick={() => navigate('/settings/brains')}>
        Connect
      </Button>
      <IconButton
        icon={X}
        size="sm"
        label="Dismiss"
        onClick={() => {
          setDismissed(true);
          void kvSet(FALLBACK_BANNER_KEY, true);
        }}
      />
    </div>
  );
}

/** One line on a host card when this host has no AI brain. */
export function NoAiLine({ host }: { host: Host }) {
  const noAi = useNoAiHosts([host]);
  if (!noAi.length) return null;
  return (
    <span className="aw-noai-line" data-noai>
      <AudioLines aria-hidden />
      Reading scripted lines, no AI yet
    </span>
  );
}
