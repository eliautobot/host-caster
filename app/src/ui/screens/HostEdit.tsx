import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Sparkles, Square, Trash2, WandSparkles } from 'lucide-react';
import { brainLabel, isFallback } from '@/core/ai';
import { designBrain, designHost, HOST_PRESETS, sayTestLine, type HostPreset } from '@/core/radio';
import { DEVICE_VOICE_ID, type BreakLine, type Draft, type Host, type Level } from '@/core/types';
import { newId } from '@/core/util/id';
import { stopPreview } from '@/core/voice';
import { useBrains } from '@/state/brains';
import { useHost, useHosts } from '@/state/hosts';
import { navigate } from '@/state/router';
import { runAction } from '../actions';
import { Avatar, Button, EmptyState, Link, Select, Slider, TextArea, TextField, toast } from '../components';
import { Page } from '../layout/Page';
import { FieldGrid, FormSection, SaveBar, StatusLine, TagInput } from '../radio/form';
import { AvatarEditor } from '../radio/host/AvatarEditor';
import { VoicePicker } from '../radio/host/VoicePicker';
import '../radio/host/host.css';
import type { ScreenProps } from '.';

type HostDraft = Draft<Host> & Pick<Host, 'id'>;

const LANGUAGES = [
  ['en', 'English'], ['en-GB', 'English (UK)'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt-BR', 'Portuguese (Brazil)'], ['pt-PT', 'Portuguese (Portugal)'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'],
  ['tr', 'Turkish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['hi', 'Hindi'], ['ar', 'Arabic'],
].map(([value, label]) => ({ value: value!, label: label! }));

const LEVEL_WORDS: Record<'energy' | 'humor' | 'verbosity', string[]> = {
  energy: ['Very calm', 'Relaxed', 'Steady', 'Upbeat', 'Hyped'],
  humor: ['Earnest', 'Sincere', 'Playful', 'Funny', 'Comedian'],
  verbosity: ['Few words', 'Brief', 'Balanced', 'Chatty', 'Storyteller'],
};

function blankHost(brainId: string | null, voiceProviderId: string): HostDraft {
  return {
    id: newId(),
    name: '',
    avatar: { kind: 'monogram', value: '', color: 'sunrise' },
    tagline: '',
    personality: '',
    style: '',
    energy: 3,
    humor: 3,
    verbosity: 2,
    language: (typeof navigator !== 'undefined' && navigator.language.startsWith('en') ? 'en' : navigator.language) || 'en',
    catchphrases: [],
    topics: [],
    avoid: [],
    voice: { voiceProviderId, voiceId: '', speed: 1, pitch: 1 },
    brainId,
  };
}

export default function HostEdit({ params }: ScreenProps) {
  const isNew = params.id === 'new';
  const stored = useHost(isNew ? undefined : params.id);
  const ready = useHosts((s) => s.ready);
  const { save, remove } = useHosts();
  const { brains, voices } = useBrains();
  const aiBrains = useMemo(() => brains.filter((b) => !isFallback(b) && b.kind !== 'connector'), [brains]);
  const [draft, setDraft] = useState<HostDraft>();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (draft) return;
    if (isNew) {
      const brain = brains.find((b) => !isFallback(b) && b.kind !== 'connector');
      setDraft(blankHost(brain?.id ?? null, voices[0]?.id ?? DEVICE_VOICE_ID));
    } else if (stored) setDraft(stored);
  }, [isNew, stored, draft, brains, voices]);

  const set = (patch: Partial<HostDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  if (!draft) {
    return (
      <Page back="/hosts" title="Host" width="narrow">
        {ready && !isNew && <EmptyState icon={WandSparkles} title="Host not found" description="It may have been deleted." />}
      </Page>
    );
  }

  const host = draft as Host;
  const onSave = () =>
    runAction(async () => {
      if (!draft.name.trim()) throw new Error('Give your host a name');
      const avatar = draft.avatar.kind === 'monogram' && !draft.avatar.value ? { ...draft.avatar, value: draft.name.trim()[0]!.toUpperCase() } : draft.avatar;
      const saved = await save({ ...draft, name: draft.name.trim(), avatar });
      setDirty(false);
      toast.success(`${saved.name} is ready for the mic`);
      if (isNew) navigate(`/hosts/${saved.id}`, { replace: true });
    });

  const onDelete = () =>
    runAction(async () => {
      if (!confirm(`Delete ${draft.name}? They will leave every station.`)) return;
      await remove(draft.id);
      navigate('/hosts', { replace: true });
    });

  return (
    <Page
      back="/hosts"
      eyebrow={isNew ? 'New host' : 'Host'}
      title={draft.name || (isNew ? 'Design a host' : 'Host')}
      subtitle={draft.tagline || 'Personality, brain and voice.'}
      width="narrow"
      actions={<Avatar avatar={draft.avatar} name={draft.name || 'Host'} size={56} />}
    >
      <StartSection isNew={isNew} host={host} onApply={set} />

      <FormSection title="Look" description="How they show up on the ON AIR strip.">
        <AvatarEditor avatar={draft.avatar} name={draft.name} onChange={(avatar) => set({ avatar })} />
        <FieldGrid>
          <TextField label="Name" value={draft.name} placeholder="Maya" maxLength={24} onChange={(name) => set({ name })} />
          <TextField label="Tagline" value={draft.tagline} placeholder="Your bright start to the day" maxLength={60} onChange={(tagline) => set({ tagline })} />
        </FieldGrid>
      </FormSection>

      <FormSection title="Personality" description="Who they are and how they talk. The more specific, the better they sound.">
        <TextArea label="Who they are" rows={3} autoResize value={draft.personality} onChange={(personality) => set({ personality })} placeholder="A sunny morning host who loves strong coffee and early walks..." />
        <TextArea label="How they talk" rows={2} autoResize value={draft.style} onChange={(style) => set({ style })} placeholder="Warm, upbeat and quick. Short sentences." />
        <div className="aw-levels">
          {(['energy', 'humor', 'verbosity'] as const).map((k) => (
            <Slider
              key={k}
              label={k === 'verbosity' ? 'Talkativeness' : k[0]!.toUpperCase() + k.slice(1)}
              showLabel
              thumb
              min={1}
              max={5}
              step={1}
              value={draft[k]}
              format={(x) => LEVEL_WORDS[k][x - 1]}
              onChange={(x) => set({ [k]: x as Level })}
            />
          ))}
        </div>
        <TagInput label="Catchphrases" values={draft.catchphrases} onChange={(catchphrases) => set({ catchphrases })} placeholder="Rise and shine" max={4} hint="Used now and then, never every break." />
        <TagInput label="Loves talking about" values={draft.topics} onChange={(topics) => set({ topics })} placeholder="music trivia, the weather" suggestions={['music trivia', 'the day ahead', 'food', 'sports', 'movies', 'travel']} />
        <TagInput label="Never talks about" values={draft.avoid} onChange={(avoid) => set({ avoid })} placeholder="politics" suggestions={['politics', 'religion', 'sad news']} />
        <Select label="Language" value={LANGUAGES.some((l) => l.value === draft.language) ? draft.language : 'en'} options={LANGUAGES} onChange={(language) => set({ language })} />
      </FormSection>

      <FormSection title="Brain" description="The AI model they think with.">
        {aiBrains.length ? (
          <Select
            label="Brain"
            value={aiBrains.some((b) => b.id === draft.brainId) ? draft.brainId! : ''}
            onChange={(brainId) => set({ brainId: brainId || null })}
            options={[
              ...(aiBrains.some((b) => b.id === draft.brainId) ? [] : [{ value: '', label: 'Choose a brain', disabled: true }]),
              ...aiBrains.map((b) => ({ value: b.id, label: brainLabel(b) })),
            ]}
            hint={
              <>
                Add OpenAI, Claude, Grok, Gemini or a model on your network in{' '}
                <Link to="/settings/brains" className="aw-textlink">
                  Brains
                </Link>
                . If the AI is out of reach, too slow or at a limit, the scripted fallback reads a few lines so the music never goes quiet.
              </>
            }
          />
        ) : (
          <div className="aw-host-nobrain" data-host-nobrain>
            <p className="aw-host-nobrain__text">
              <strong>No AI connected yet.</strong> Until you connect one, {draft.name.trim() || 'this host'} reads short scripted lines (song, time,
              weather, your day) so the music never goes quiet.
            </p>
            <div>
              <Button size="sm" variant="primary" onClick={() => navigate('/settings/brains')}>
                Connect an AI
              </Button>
            </div>
          </div>
        )}
      </FormSection>

      <FormSection title="Voice">
        <VoicePicker host={host} onChange={(voice) => set({ voice })} />
      </FormSection>

      <TryIt host={host} />

      {!isNew && (
        <div className="aw-dangerrow">
          <Button variant="ghost" icon={Trash2} onClick={onDelete}>
            Delete host
          </Button>
        </div>
      )}

      {(dirty || isNew) && (
        <SaveBar note={isNew ? undefined : 'Unsaved changes'}>
          {!isNew && stored && (
            <Button variant="ghost" onClick={() => (setDraft(stored), setDirty(false))}>
              Discard
            </Button>
          )}
          <Button variant="primary" onClick={onSave}>
            {isNew ? 'Create host' : 'Save'}
          </Button>
        </SaveBar>
      )}
    </Page>
  );
}

function presetVoice(p: HostPreset, host: Host, providerKind: string | undefined): Host['voice'] {
  const voiceId = providerKind === 'openai' ? p.voice.openai : providerKind === 'openai-compatible' ? p.voice.kokoro : host.voice.voiceId;
  return { ...host.voice, voiceId: voiceId ?? '', speed: p.voice.speed, pitch: p.voice.pitch };
}

/** Presets + "Describe your host". */
function StartSection({ isNew, host, onApply }: { isNew: boolean; host: Host; onApply: (patch: Partial<HostDraft>) => void }) {
  const voices = useBrains((s) => s.voices);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [note, setNote] = useState<string>();
  const providerKind = voices.find((v) => v.id === host.voice.voiceProviderId)?.kind;

  const apply = (p: HostPreset) => {
    setPicked(p.id);
    onApply({ ...p.host, avoid: host.avoid, voice: presetVoice(p, host, providerKind) });
  };

  const describe = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const brain = await designBrain(host.brainId);
      const { fields, usedAi } = await designHost(desc, brain);
      const { emoji, ...rest } = fields;
      onApply({ ...rest, avatar: emoji ? { kind: 'emoji', value: emoji, color: host.avatar.color } : host.avatar });
      setNote(usedAi ? `Filled in by ${brain?.name}. Tweak anything below.` : 'Filled in offline from the closest personality. Connect an AI for a fully custom host.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSection
      title={isNew ? 'Start with a personality' : 'Reinvent this host'}
      description={isNew ? 'Pick one to fill everything in, or describe your own.' : 'Describe a new direction and let the brain rewrite the fields.'}
    >
      {isNew && (
        <div className="aw-presetgrid">
          {HOST_PRESETS.map((p) => (
            <button key={p.id} type="button" className="aw-preset" aria-pressed={picked === p.id} onClick={() => apply(p)}>
              <Avatar avatar={p.host.avatar} name={p.host.name} size={36} />
              <span className="aw-preset__text">
                <span className="aw-preset__title">{p.label}</span>
                <span className="aw-preset__desc">{p.host.tagline}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="aw-describe">
        <TextArea
          label="Describe your host"
          rows={2}
          autoResize
          value={desc}
          onChange={setDesc}
          placeholder="A retired jazz drummer from New Orleans who tells tiny stories and loves bad puns"
        />
        <div className="aw-hstack">
          <Button icon={Sparkles} loading={busy} disabled={desc.trim().length < 8} onClick={describe}>
            Fill in for me
          </Button>
          {note && <StatusLine tone="muted">{note}</StatusLine>}
        </div>
      </div>
    </FormSection>
  );
}

/** "Say something": a real line from the host's brain about your day, in their voice. */
function TryIt({ host }: { host: Host }) {
  const [lines, setLines] = useState<BreakLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  const name = host.name || 'Your host';
  const go = async () => {
    if (busy) {
      ctrl.current?.abort();
      stopPreview();
      setBusy(false);
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(undefined);
    try {
      await sayTestLine({ ...host, name }, { onLines: setLines, signal: c.signal });
    } catch (err) {
      if (!c.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const text = useMemo(() => lines.map((l) => l.text).join(' '), [lines]);
  return (
    <FormSection title="Say something" description={`${name} reads the room (time, weather, your day) and says hi, in their brain and voice.`}>
      <div className="aw-tryit">
        {text && (
          <div className="aw-tryit__line" aria-live="polite">
            <Avatar avatar={host.avatar} name={name} size={36} speaking={busy} />
            <div>
              <p className="aw-tryit__who">{name}</p>
              <p className="aw-tryit__text">{text}</p>
            </div>
          </div>
        )}
        <div className="aw-hstack">
          <Button icon={busy ? Square : MessageCircle} onClick={go}>
            {busy ? 'Stop' : text ? 'Say something else' : 'Say something'}
          </Button>
          {error && <StatusLine tone="error">{error}</StatusLine>}
        </div>
      </div>
    </FormSection>
  );
}
