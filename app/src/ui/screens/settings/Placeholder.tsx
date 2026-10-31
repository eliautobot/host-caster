import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { EmptyState } from '../../components';

/** Shared "not built yet" body for settings pages. */
export function SettingsPlaceholder(props: { icon: LucideIcon; title: string; description: string; actions?: ReactNode }) {
  return <EmptyState {...props} size="compact" card />;
}
