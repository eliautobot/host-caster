import { useEffect, useState } from 'react';
import { AudioLines, Cloud, HardDrive, Plus, Smartphone, Sparkles } from 'lucide-react';
import type { VoiceProvider } from '@/core/types';
import { deviceSpeechAvailable, listDeviceVoices } from '@/core/voice';
import { useBrains } from '@/state/brains';
import { useHosts } from '@/state/hosts';
import { Badge, Button } from '../../components';
import { VoiceSheet } from '../../radio/settings/VoiceSheet';
import '../../radio/forms.css';
import '../../online/online.css';

/** Voices: speech engines hosts can use. This device's voice is always there. */
export default function Voices() {
  const providers = useBrains((s) => s.voices);
  const hosts = useHosts((s) => s.hosts);
  const [sheet, setSheet] = useState<{ provider?: VoiceProvider } | null>(null);
  const [deviceCount, setDeviceCount] = useState<number>();
  useEffect(() => {
    void listDeviceVoices().then((v) => setDeviceCount(v.length)).catch(() => setDeviceCount(0));
  }, []);
  const usedBy = (id: string) => hosts.filter((h) => h.voice.voiceProviderId === id).map((h) => h.name);
  const deviceUsers = usedBy('device');

  return (
    <div className="aw-fsec__body">
      <div className="aw-entries">
        <div className="aw-entry">
          <span className="aw-preset__icon">
            <Smartphone aria-hidden />
          </span>
          <div className="aw-entry__text">
            <p className="aw-entry__title">This device</p>
            <p className="aw-entry__meta">
              {!deviceSpeechAvailable()
                ? 'This browser has no speech voices'
                : deviceCount === 0
                  ? 'No voices installed in this browser yet'
                  : deviceCount
                    ? `${deviceCount} built-in voice${deviceCount === 1 ? '' : 's'}, works offline`
                    : 'Built-in voices, works offline'}
              {deviceUsers.length ? ` · ${deviceUsers.join(', ')}` : ''}
            </p>
          </div>
          <Badge tone={deviceSpeechAvailable() ? 'ok' : 'neutral'}>{deviceSpeechAvailable() ? 'Always on' : 'Unavailable'}</Badge>
        </div>
        {providers.map((p) => {
          const users = usedBy(p.id);
          const Icon = p.kind === 'hostcaster' ? Sparkles : p.kind === 'openai-compatible' ? HardDrive : p.kind === 'device' ? AudioLines : Cloud;
          return (
            <div key={p.id} className="aw-entry">
              <span className={p.kind === 'hostcaster' ? 'aw-preset__icon aw-included-tile' : 'aw-preset__icon'}>
                <Icon aria-hidden />
              </span>
              <button type="button" className="aw-entry__text aw-entry__open" onClick={() => setSheet({ provider: p })}>
                <p className="aw-entry__title">{p.name}</p>
                <p className="aw-entry__meta aw-truncate">
                  {p.kind === 'hostcaster'
                    ? 'Included with your plan'
                    : `${p.model || p.kind} · ${p.transport === 'server' ? 'via your server' : p.kind === 'openai-compatible' ? 'self-hosted' : 'cloud'}`}
                  {users.length ? ` · ${users.join(', ')}` : ''}
                </p>
              </button>
              <Button size="sm" onClick={() => setSheet({ provider: p })}>
                Edit
              </Button>
            </div>
          );
        })}
      </div>
      <div>
        <Button variant="primary" icon={Plus} onClick={() => setSheet({})}>
          Add a voice engine
        </Button>
      </div>
      <p className="aw-field__hint">Pick a voice for each host in the host editor. Voices are prepared before the song ends, so breaks start on time.</p>
      <VoiceSheet open={sheet !== null} provider={sheet?.provider} onClose={() => setSheet(null)} />
    </div>
  );
}
