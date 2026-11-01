import { useMemo } from 'react';
import { accountNews, deviceHints, type AccountNews } from '@/core/context/news';
import { useProfile } from './profile';
import { useSettings } from './settings';

/** The account's news (Settings, Connections): the feeds stations without their own read. */
export function useAccountNews(): AccountNews {
  const conn = useSettings((s) => s.settings.connections.news);
  const place = useProfile((s) => s.profile.location);
  return useMemo(() => accountNews(conn, { place, ...deviceHints() }), [conn, place]);
}
