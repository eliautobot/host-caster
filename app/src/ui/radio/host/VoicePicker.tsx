import { useEffect, useMemo, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { DEVICE_VOICE_ID, type Host, type HostVoice, type VoiceOption } from '@/core/types';
import { listVoices, previewVoice, stopPreview, voiceInstructions } from '@/core/voice';
import { useBrains } from '@/state/brains';
import { Button, Link, Select, Slider, TextArea } from '../../components';
import { PremiumVoiceNote } from '../../online/parts';
import { FieldGrid, StatusLine } from '../form';

export function VoicePicker({ host, onChange }: { host: Host; onChange: (v: HostVoice) => void }) {
  const providers = useBrains((s) => s.voices);
  const v = host.voice;
  const provider = providers.find((p) => p.id === v.voiceProviderId);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);

  const key = provider ? `${provider.id}:${provider.updatedAt}` : DEVICE_VOICE_ID;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    listVoices(provider ?? DEVICE_VOICE_ID)
      .then((list) => live && setVoices(list))
      .catch((err: unknown) => live && (setVoices([]), setError(err instanceof Error ? err.message : String(err))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the provider record changes
  }, [key]);

  // a retired Host-Caster voice shows (and speaks) as the voice that replaced it
  const listed = voices.some((o) => o.id === v.voiceId);
  const voiceId = (v.voiceId && !listed && voices.find((o) => o.replaces?.includes(v.voiceId))?.id) || v.voiceId;
  const isHostCaster = provider?.kind === 'hostcaster';

  const options = useMemo(() => {
    const lang = host.language.split('-')[0]!.toLowerCase();
    const sorted = [...voices].sort((a, b) => {
      const am = a.language?.toLowerCase().startsWith(lang) ? 0 : 1;
      const bm = b.language?.toLowerCase().startsWith(lang) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
    const list = sorted.slice(0, 300).map((o) => ({
      value: o.id,
      label: [o.name, o.language, o.gender && o.gender !== 'neutral' ? o.gender : '', o.premium ? 'Premium' : ''].filter(Boolean).join(' · '),
    }));
    if (voiceId && !list.some((o) => o.value === voiceId)) list.unshift({ value: voiceId, label: voiceId });
    return [{ value: '', label: provider ? 'Provider default' : 'Best match for the language' }, ...list];
  }, [voices, voiceId, host.language, provider]);

  const preview = async () => {
    if (playing) {
      stopPreview();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    setError(undefined);
    try {
      await previewVoice(host);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlaying(false);
    }
  };

  const isDevice = !provider || provider.kind === 'device';
  return (
    <>
      <FieldGrid>
        <Select
          label="Speech engine"
          value={provider?.id ?? DEVICE_VOICE_ID}
          onChange={(id) => onChange({ ...v, voiceProviderId: id, voiceId: '' })}
          options={[{ value: DEVICE_VOICE_ID, label: 'This device (offline)' }, ...providers.map((p) => ({ value: p.id, label: p.name }))]}
          hint={
            <>
              Add OpenAI, ElevenLabs or Kokoro in{' '}
              <Link to="/settings/voices" className="aw-textlink">
                Voices
              </Link>
              .
            </>
          }
        />
        <Select label="Voice" value={voiceId} onChange={(id) => onChange({ ...v, voiceId: id })} options={options} disabled={loading} hint={loading ? 'Loading voices...' : undefined} />
      </FieldGrid>
      {isHostCaster && !loading && <PremiumVoiceNote voice={voices.find((o) => o.id === voiceId)} hasPremiumVoices={voices.some((o) => o.premium)} />}
      <FieldGrid>
        <Slider label="Speed" showLabel thumb min={0.7} max={1.4} step={0.02} value={v.speed} format={(x) => `${x.toFixed(2)}x`} onChange={(speed) => onChange({ ...v, speed })} />
        {isDevice ? (
          <Slider label="Pitch" showLabel thumb min={0.6} max={1.4} step={0.02} value={v.pitch} format={(x) => x.toFixed(2)} onChange={(pitch) => onChange({ ...v, pitch })} />
        ) : (
          <div />
        )}
      </FieldGrid>
      {provider?.kind === 'openai' && (
        <TextArea
          label="Speaking style"
          rows={2}
          autoResize
          value={v.instructions ?? ''}
          placeholder={voiceInstructions({ ...host, voice: { ...v, instructions: '' } })}
          onChange={(instructions) => onChange({ ...v, instructions })}
          hint="Leave empty to use the host's style. OpenAI voices follow this direction."
        />
      )}
      <div className="aw-hstack">
        <Button icon={playing ? Square : Play} onClick={preview}>
          {playing ? 'Stop' : 'Preview voice'}
        </Button>
        {error && <StatusLine tone="error">{error}</StatusLine>}
      </div>
    </>
  );
}
