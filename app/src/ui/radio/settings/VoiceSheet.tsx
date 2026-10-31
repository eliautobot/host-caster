import { useEffect, useState } from 'react';
import { Cloud, HardDrive, ListRestart, Play, Sparkles, Trash2 } from 'lucide-react';
import { isOnline } from '@/core/api';
import { usePlan } from '@/state/plan';
import { IncludedNotice, PremiumVoiceNote } from '../../online/parts';
import { PRIVATE_URL } from './BrainSheet';
import { STARTER_HOSTS } from '@/core/db';
import type { Draft, Host, VoiceOption, VoiceProvider } from '@/core/types';
import { HOSTCASTER_VOICES_PRESET, getVoicePreset, listVoices, playStandalone, synthesize, VOICE_PRESETS, type VoicePreset } from '@/core/voice';
import { useBrains } from '@/state/brains';
import { useHosts } from '@/state/hosts';
import { runAction } from '../../actions';
import { Button, IconButton, Select, Sheet, TextField, toast } from '../../components';
import { FieldGrid, StatusLine } from '../form';
import { KeyField, TransportField } from './fields';

type VoiceDraft = Draft<VoiceProvider> & { preset?: string };

function fromPreset(p: VoicePreset): VoiceDraft {
  // Host-Caster Voices always run on the service
  if (p.kind === 'hostcaster') return { name: p.name, kind: 'hostcaster', model: '', transport: 'server', preset: p.id };
  return { name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, apiKey: '', transport: 'device', preset: p.id };
}

const voiceLabel = (v: VoiceOption) => [v.name, v.language, v.premium ? 'Premium' : ''].filter(Boolean).join(' · ');

/** Add or edit a speech engine: preset, address, key, model, list voices, play a sample, save. */
export function VoiceSheet({ open, onClose, provider }: { open: boolean; onClose: () => void; provider?: VoiceProvider }) {
  const { saveVoice, removeVoice } = useBrains();
  const hosts = useHosts((s) => s.hosts);
  const [draft, setDraft] = useState<VoiceDraft | undefined>(provider);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [busy, setBusy] = useState<'list' | 'play'>();
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    if (open) {
      setDraft(provider);
      setVoices([]);
      setVoiceId('');
      setStatus(undefined);
    }
  }, [open, provider]);

  const preset = getVoicePreset(draft?.preset ?? (draft?.kind === 'hostcaster' ? 'hostcaster' : undefined));
  const set = (patch: Partial<VoiceDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const included = usePlan((s) => s.status?.includes.voices);
  // online edition: voice servers on the user's own computer or network connect from this device only
  const localOnly = isOnline() && draft?.kind !== 'hostcaster' && PRIVATE_URL.test(draft?.baseUrl ?? '');
  const isHostCaster = draft?.kind === 'hostcaster';
  useEffect(() => {
    // the included voices list itself
    if (open && isHostCaster && !voices.length) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isHostCaster]);
  const asProvider = (): VoiceProvider => ({ id: provider?.id ?? 'draft', createdAt: 0, updatedAt: 0, ...draft! });

  const load = async () => {
    setBusy('list');
    setStatus(undefined);
    try {
      const list = await listVoices(asProvider());
      setVoices(list);
      setVoiceId(list.find((v) => v.id === preset?.defaultVoice)?.id ?? list[0]?.id ?? '');
      setStatus({ ok: true, text: `${list.length} voices` });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(undefined);
    }
  };

  const sample = async () => {
    setBusy('play');
    setStatus(undefined);
    try {
      const base: Host = hosts[0] ?? { ...STARTER_HOSTS[0]!, createdAt: 0, updatedAt: 0 };
      const host: Host = { ...base, voice: { ...base.voice, voiceProviderId: provider?.id ?? 'draft', voiceId } };
      const t0 = Date.now();
      const blob = await synthesize(asProvider(), host, `Hi, this is ${draft?.name ?? 'your new voice'} on Host-Caster. Sounds good, right?`);
      setStatus({ ok: true, text: `Works. Spoke in ${((Date.now() - t0) / 1000).toFixed(1)} s.` });
      await playStandalone({ kind: 'audio', blob });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(undefined);
    }
  };

  const save = () =>
    runAction(async () => {
      if (!draft) return;
      if (draft.kind === 'hostcaster' && !usePlan.getState().status?.includes.voices) throw new Error('Host-Caster Voices come with the Voices, Everything or Premium plan');
      if (draft.kind !== 'elevenlabs' && draft.kind !== 'openai' && draft.kind !== 'hostcaster' && !draft.baseUrl?.trim()) throw new Error('Add the server address');
      const { preset: _p, ...rec } = draft;
      await saveVoice({ ...(provider ?? {}), ...rec, name: rec.name.trim() || 'Voice', baseUrl: rec.baseUrl?.trim(), ...(localOnly ? { transport: 'device' as const } : {}) });
      toast.success(`${rec.name} saved`, 'Pick it for a host in the host editor.');
      onClose();
    });

  const remove = () =>
    runAction(async () => {
      if (!provider) return;
      const using = hosts.filter((h) => h.voice.voiceProviderId === provider.id).map((h) => h.name);
      if (!confirm(using.length ? `${using.join(', ')} will switch to this device's voice. Delete ${provider.name}?` : `Delete ${provider.name}?`)) return;
      await removeVoice(provider.id);
      onClose();
    });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="md"
      title={provider ? provider.name : draft ? `Connect ${preset?.name ?? draft.name}` : 'Add a voice engine'}
      description={draft ? (preset?.note ?? 'Speech engine settings') : 'Studio voices from the cloud, or free voices running on your own computer.'}
      footer={
        draft && (
          <>
            {provider && <IconButton icon={Trash2} label="Delete voice engine" onClick={remove} />}
            {!provider && (
              <Button variant="ghost" onClick={() => setDraft(undefined)}>
                Back
              </Button>
            )}
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </>
        )
      }
    >
      {!draft ? (
        <div className="aw-presetgrid">
          {isOnline() && (
            <button type="button" className="aw-preset" data-preset="hostcaster" onClick={() => setDraft(fromPreset(HOSTCASTER_VOICES_PRESET))}>
              <span className="aw-preset__icon aw-included-tile">
                <Sparkles aria-hidden />
              </span>
              <span className="aw-preset__text">
                <span className="aw-preset__title">Host-Caster Voices</span>
                <span className="aw-preset__desc">{included ? 'Included with your plan' : 'With the Voices, Everything or Premium plan'}</span>
              </span>
            </button>
          )}
          {VOICE_PRESETS.map((p) => (
            <button key={p.id} type="button" className="aw-preset" onClick={() => setDraft(fromPreset(p))}>
              <span className="aw-preset__icon">{p.keyRequired ? <Cloud aria-hidden /> : <HardDrive aria-hidden />}</span>
              <span className="aw-preset__text">
                <span className="aw-preset__title">{p.name}</span>
                <span className="aw-preset__desc">{p.keyRequired ? 'API key' : 'Self-hosted, free'}</span>
              </span>
            </button>
          ))}
        </div>
      ) : isHostCaster ? (
        <div className="aw-fsec__body aw-sheetform">
          <IncludedNotice kind="voices" />
          <div className="aw-modelrow">
            {voices.length ? (
              <Select label="Try a voice" value={voiceId} onChange={setVoiceId} options={voices.map((v) => ({ value: v.id, label: voiceLabel(v) }))} />
            ) : (
              <div className="aw-field">
                <span className="aw-field__label">Voices</span>
                <p className="aw-field__hint">{busy === 'list' ? 'Loading the voices...' : 'Load the list to hear one.'}</p>
              </div>
            )}
            <IconButton icon={Play} label="Play a sample" variant="solid" disabled={busy === 'play' || !voiceId} onClick={sample} />
          </div>
          <PremiumVoiceNote voice={voices.find((v) => v.id === voiceId)} hasPremiumVoices={voices.some((v) => v.premium)} />
          <p className="aw-field__hint">Pick a voice for each host in the host editor. Premium voices (ElevenLabs) sound most natural and have their own monthly allowance.</p>
          {status && <StatusLine tone={status.ok ? 'ok' : 'error'}>{status.text}</StatusLine>}
        </div>
      ) : (
        <div className="aw-fsec__body aw-sheetform">
          <FieldGrid>
            <TextField label="Name" value={draft.name} onChange={(name) => set({ name })} />
            <TextField label="Server address" value={draft.baseUrl ?? ''} placeholder="http://192.168.1.20:8880/v1" spellCheck={false} onChange={(baseUrl) => set({ baseUrl })} />
          </FieldGrid>
          <FieldGrid>
            <KeyField value={draft.apiKey ?? ''} onChange={(apiKey) => set({ apiKey })} keyUrl={preset?.keyUrl} required={preset?.keyRequired} />
            <TextField label="Model" value={draft.model ?? ''} placeholder="tts-1" spellCheck={false} onChange={(model) => set({ model })} />
          </FieldGrid>
          <TransportField value={draft.transport} onChange={(transport) => set({ transport })} deviceOnly={localOnly} />
          <div className="aw-modelrow">
            {voices.length ? (
              <Select label="Try a voice" value={voiceId} onChange={setVoiceId} options={voices.slice(0, 300).map((v) => ({ value: v.id, label: voiceLabel(v) }))} />
            ) : (
              <div className="aw-field">
                <span className="aw-field__label">Voices</span>
                <p className="aw-field__hint">Load the list to hear one.</p>
              </div>
            )}
            <Button icon={ListRestart} loading={busy === 'list'} onClick={load}>
              Load voices
            </Button>
            <IconButton icon={Play} label="Play a sample" variant="solid" disabled={busy === 'play'} onClick={sample} />
          </div>
          {status && <StatusLine tone={status.ok ? 'ok' : 'error'}>{status.text}</StatusLine>}
        </div>
      )}
    </Sheet>
  );
}


