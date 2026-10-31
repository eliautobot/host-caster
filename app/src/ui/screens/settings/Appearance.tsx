import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemePref } from '@/core/types';
import { useSettings } from '@/state/settings';
import { Card, Tabs } from '../../components';

const THEMES = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
] satisfies { value: ThemePref; label: string; icon: typeof Moon }[];

export default function Appearance() {
  const theme = useSettings((s) => s.settings.theme);
  const update = useSettings((s) => s.update);
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <p style={{ fontWeight: 560 }}>Theme</p>
          <p className="aw-muted" style={{ fontSize: 'var(--text-sm)' }}>
            Dark suits late nights. System follows your device.
          </p>
        </div>
        <Tabs variant="segmented" items={THEMES} value={theme} onChange={(t) => void update({ theme: t })} label="Theme" />
      </div>
    </Card>
  );
}
