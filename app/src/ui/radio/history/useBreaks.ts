import { useEffect, useState } from 'react';
import { recentBreaks } from '@/core/radio';
import type { Break } from '@/core/types';
import { bindLive } from '@/state/live';

/** Live list of recent breaks (newest first); undefined while loading. */
export function useBreaks(limit = 50, stationId?: string): Break[] | undefined {
  const [breaks, setBreaks] = useState<Break[]>();
  useEffect(() => bindLive(() => recentBreaks(limit, stationId), setBreaks), [limit, stationId]);
  return breaks;
}
