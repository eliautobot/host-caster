import {
  Bell,
  CalendarDays,
  Clock,
  CloudSun,
  Mail,
  Music2,
  Newspaper,
  PartyPopper,
  Sparkles,
  StickyNote,
  type LucideIcon,
} from 'lucide-react';
import type { SegmentKey } from '@/core/types';

/** Labels and icons for Station.segments, in display order. */
export const SEGMENT_META: { key: SegmentKey; label: string; icon: LucideIcon }[] = [
  { key: 'songs', label: 'The songs', icon: Music2 },
  { key: 'time', label: 'Time of day', icon: Clock },
  { key: 'weather', label: 'Weather', icon: CloudSun },
  { key: 'calendar', label: 'Your calendar', icon: CalendarDays },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'news', label: 'News', icon: Newspaper },
  { key: 'lifeEvents', label: 'Life events', icon: PartyPopper },
  { key: 'notes', label: 'Notes', icon: StickyNote },
  { key: 'reminders', label: 'Reminders', icon: Bell },
  { key: 'funFacts', label: 'Fun facts', icon: Sparkles },
];
