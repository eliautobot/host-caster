import { useEffect, useState } from 'react';
import { Cloud, HardDrive, ListRestart, PlugZap, Sparkles, Trash2 } from 'lucide-react';
import { isOnline } from '@/core/api';
import { usePlan } from '@/state/plan';
import { IncludedNotice } from '../../online/parts';
import { BRAIN_PRESETS, getPreset, listModels, testBrain, type BrainPresetInfo, type BrainTestResult } from '@/core/ai';
import type { Brain, Draft } from '@/core/types';
import { useBrains } from '@/state/brains';
import { useHosts } from '@/state/hosts';
import { hasAi } from '../fallback';
import { runAction } from '../../actions';
import { Button, IconButton, Select, Sheet, Slider, TextField, toast } from '../../components';
import { FieldGrid, StatusLine } from '../form';
import { ChatGPTBrainForm } from './chatgpt/ChatGPTBrainForm';
import { ChatGPTMark } from './chatgpt/ChatGPTMark';
import type { ChatGPTState } from './chatgpt/useChatGPT';
import { KeyField, TransportField } from './fields';

type BrainDraft = Draft<Brain>;

/** an address on this computer or a private network (LAN, tailnet) */
export const PRIVATE_URL = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.|\[?::1\]?)/;

const names = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

export function fromPreset(p: BrainPresetInfo): BrainDraft {
  // a ChatGPT plan always runs on the server (it holds the ChatGPT sign-in); no key, no address
  if (p.kind === 'chatgpt') return { name: p.name, kind: 'chatgpt', preset: p.id, model: '', transport: 'server' };
  // Host-Caster AI (online plans): the service picks the model and holds the key
  if (p.kind === 'hostcaster') return { name: p.name, kind: 'hostcaster', preset: p.id, model: 'hostcaster', transport: 'server', temperature: 0.9 };
  return { name: p.name, kind: p.kind, preset: p.id, baseUrl: p.baseUrl, model: p.defaultModel, apiKey: '', temperature: 0.9, transport: 'device' };
}

function PlanTile({ preset, onPick }: { preset: BrainPresetInfo; onPick: (p: BrainPresetInfo) => void }) {
  return (
    <button type="button" className="aw-preset" onClick={() => onPick(preset)}>
      <span className="aw-preset__icon aw-cgpt-tile">
        <ChatGPTMark size={20} />
      </span>
      <span className="aw-preset__text">
        <span className="aw-preset__title">Use your ChatGPT plan</span>
        <span className="aw-preset__desc">Plus or Pro. No API key.</span>
      </span>
    </button>
  );
}

function IncludedTile({ preset, onPick }: { preset: BrainPresetInfo; onPick: (p: BrainPresetInfo) => void }) {
  const included = usePlan((s) => s.status?.includes.brain);
  return (
    <button type="button" className="aw-preset" onClick={() => onPick(preset)} data-preset="hostcaster">
      <span className="aw-preset__icon aw-included-tile">
        <Sparkles aria-hidden />
      </span>
      <span className="aw-preset__text">
        <span className="aw-preset__title">Host-Caster AI</span>
        <span className="aw-preset__desc">{included ? 'Included with your plan' : 'With the Brain, Everything or Premium plan'}</span>
      </span>
    </button>
  );
}

function PresetGrid({ onPick, plan }: { onPick: (p: BrainPresetInfo) => void; plan: boolean }) {
  const chatgptPreset = BRAIN_PRESETS.find((p) => p.group === 'plan');
  const includedPreset = isOnline() ? BRAIN_PRESETS.find((p) => p.group === 'included') : undefined;
  const groups: { title: string; items: BrainPresetInfo[]; icon: typeof Cloud }[] = [
    { title: 'Cloud (API key)', items: BRAIN_PRESETS.filter((p) => p.group === 'cloud'), icon: Cloud },
    { title: 'On your computer or network', items: BRAIN_PRESETS.filter((p) => p.group === 'local'), icon: HardDrive },
  ];
  return (
    <div className="aw-fsec__body">
      {includedPreset && (
        <div className="aw-field">
          <span className="aw-field__label">Included with Host-Caster</span>
          <div className="aw-presetgrid">
            <IncludedTile preset={includedPreset} onPick={onPick} />
          </div>
        </div>
      )}
      {plan && chatgptPreset && (
        <div className="aw-field">
          <span className="aw-field__label">Your subscription</span>
          <div className="aw-presetgrid">
            <PlanTile preset={chatgptPreset} onPick={onPick} />
          </div>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.title} className="aw-field">
          <span className="aw-field__label">{g.title}</span>
          <div className="aw-presetgrid">
            {g.items.map((p) => (
              <button key={p.id} type="button" className="aw-preset" onClick={() => onPick(p)}>
                <span className="aw-preset__icon">
                  <g.icon aria-hidden />
                </span>
                <span className="aw-preset__text">
                  <span className="aw-preset__title">{p.name}</span>
                  <span className="aw-preset__desc">{p.local ? 'No key needed' : p.note ?? 'API key'}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Add or edit a brain: preset, address, key, model (with the live list), test, save. `start` opens on a preset. */
export function BrainSheet({ open, onClose, brain, start, cg }: { open: boolean; onClose: () => void; brain?: Brain; start?: BrainPresetInfo; cg: ChatGPTState }) {
  const { saveBrain, removeBrain, brains } = useBrains();
  const hosts = useHosts((s) => s.hosts);
  const saveHost = useHosts((s) => s.save);
  const [draft, setDraft] = useState<BrainDraft | undefined>(brain);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [test, setTest] = useState<BrainTestResult & { busy?: boolean }>();

  useEffect(() => {
    if (open) {
      setDraft(brain ?? (start ? fromPreset(start) : undefined));
      setModels([]);
      setTest(undefined);
    }
  }, [open, brain, start]);

  const preset = getPreset(draft?.preset);
  const set = (patch: Partial<BrainDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  // online edition: models on the user's own computer or network connect from this device only
  const localOnly = isOnline() && (preset?.group === 'local' || PRIVATE_URL.test(draft?.baseUrl ?? ''));
  const asBrain = (): Brain => ({ id: brain?.id ?? 'draft', createdAt: 0, updatedAt: 0, ...draft! });

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const list = await listModels(asBrain());
      setModels(list);
      if (!list.length) toast({ title: 'No models found', description: 'The server answered but listed no models.' });
      // an empty model, or the preset's example model that this server does not have: pick one it has
      else if (list[0] && (!draft?.model || (draft.model === preset?.defaultModel && !list.includes(draft.model)))) set({ model: list[0] });
    } catch (err) {
      toast.error('Could not list models', err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
    }
  };

  const runTest = async () => {
    setTest({ ok: false, message: 'Asking the model to say hello...', busy: true });
    setTest(await testBrain(asBrain()));
    if (draft?.kind === 'chatgpt') void cg.refresh();
  };

  const save = () =>
    runAction(async () => {
      if (!draft) return;
      if (draft.kind === 'chatgpt' && !cg.status?.connected) throw new Error('Continue with ChatGPT first');
      if (draft.kind === 'hostcaster' && !usePlan.getState().status?.includes.brain) throw new Error('Host-Caster AI comes with the Brain, Everything or Premium plan');
      if (!draft.model.trim()) throw new Error('Pick a model');
      if (draft.kind !== 'anthropic' && draft.kind !== 'chatgpt' && draft.kind !== 'hostcaster' && !draft.baseUrl?.trim()) throw new Error('Add the server address');
      const saved = await saveBrain({
        ...(brain ?? {}),
        ...draft,
        name: draft.name.trim() || preset?.name || 'Brain',
        model: draft.model.trim(),
        baseUrl: draft.baseUrl?.trim(),
        ...(localOnly ? { transport: 'device' as const } : {}),
      });
      onClose();
      // The first AI: every host with no AI brain (reading scripted lines) moves to it (that is why it was added).
      const offline = hosts.filter((h) => !hasAi(h, brains));
      if (brain || !offline.length || offline.length < hosts.length) {
        toast.success(`${saved.name} saved`);
        return;
      }
      await Promise.all(offline.map((h) => saveHost({ ...h, brainId: saved.id })));
      toast({
        tone: 'success',
        title: `${saved.name} saved`,
        description: `${names(offline.map((h) => h.name))} now think with it.`,
        action: { label: 'Undo', onClick: () => void Promise.all(offline.map((h) => saveHost(h))) },
        duration: 8000,
      });
    });

  const remove = () =>
    runAction(async () => {
      if (!brain) return;
      const using = hosts.filter((h) => h.brainId === brain.id).map((h) => h.name);
      if (!confirm(using.length ? `${using.join(', ')} use this brain and will read scripted lines until you pick another. Delete it?` : `Delete ${brain.name}?`)) return;
      await removeBrain(brain.id);
      await Promise.all(hosts.filter((h) => h.brainId === brain.id).map((h) => saveHost({ ...h, brainId: null })));
      onClose();
    });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="md"
      title={brain ? brain.name : draft ? (draft.kind === 'chatgpt' ? 'Use your ChatGPT plan' : draft.kind === 'hostcaster' ? 'Host-Caster AI' : `Connect ${preset?.name ?? 'a brain'}`) : 'Add a brain'}
      description={
        draft
          ? draft.kind === 'chatgpt'
            ? 'Your hosts write their breaks on your ChatGPT plan instead of an API key.'
            : draft.kind === 'hostcaster'
              ? 'The brain that comes with your Host-Caster plan. Your hosts write every break with it.'
            : (preset?.note ?? 'Any OpenAI-compatible server works.')
          : 'Pick where your hosts think. You can add as many as you like.'
      }
      footer={
        draft && (
          <>
            {brain && <IconButton icon={Trash2} label="Delete brain" onClick={remove} />}
            {!brain && (
              <Button variant="ghost" onClick={() => setDraft(undefined)}>
                Back
              </Button>
            )}
            <Button icon={PlugZap} loading={test?.busy} disabled={draft.kind === 'chatgpt' && !cg.status?.connected} onClick={runTest}>
              Test
            </Button>
            <Button variant="primary" disabled={draft.kind === 'chatgpt' && (!cg.status?.connected || !draft.model)} onClick={save}>
              Save
            </Button>
          </>
        )
      }
    >
      {!draft ? (
        <PresetGrid onPick={(p) => setDraft(fromPreset(p))} plan={cg.serverOn} />
      ) : draft.kind === 'hostcaster' ? (
        <div className="aw-fsec__body aw-sheetform">
          <IncludedNotice kind="brain" />
          {test && !test.busy && (
            <StatusLine tone={test.ok ? 'ok' : 'error'}>
              {test.message}
              {test.sample && <span className="aw-sample">“{test.sample}”</span>}
            </StatusLine>
          )}
          {test?.busy && <StatusLine tone="muted">{test.message}</StatusLine>}
        </div>
      ) : draft.kind === 'chatgpt' ? (
        <div className="aw-fsec__body aw-sheetform">
          <ChatGPTBrainForm cg={cg} draft={draft} set={set} />
          {test && !test.busy && (
            <StatusLine tone={test.ok ? 'ok' : 'error'}>
              {test.message}
              {test.sample && <span className="aw-sample">“{test.sample}”</span>}
            </StatusLine>
          )}
          {test?.busy && <StatusLine tone="muted">{test.message}</StatusLine>}
        </div>
      ) : (
        <div className="aw-fsec__body aw-sheetform">
          <FieldGrid>
            <TextField label="Name" value={draft.name} onChange={(name) => set({ name })} />
            <TextField
              label="Server address"
              value={draft.baseUrl ?? ''}
              placeholder="http://192.168.1.20:11434/v1"
              spellCheck={false}
              onChange={(baseUrl) => set({ baseUrl })}
            />
          </FieldGrid>
          <KeyField value={draft.apiKey ?? ''} onChange={(apiKey) => set({ apiKey })} keyUrl={preset?.keyUrl} required={preset?.keyRequired} />
          <div className="aw-modelrow">
            {models.length ? (
              <Select label="Model" value={draft.model} onChange={(model) => set({ model })} options={(models.includes(draft.model) || !draft.model ? models : [draft.model, ...models]).map((m) => ({ value: m, label: m }))} />
            ) : (
              <TextField label="Model" value={draft.model} placeholder="gpt-4o-mini, llama3.2 ..." spellCheck={false} onChange={(model) => set({ model })} />
            )}
            <Button icon={ListRestart} loading={loadingModels} onClick={loadModels}>
              Load models
            </Button>
          </div>
          <Slider
            label="Creativity"
            showLabel
            thumb
            min={0}
            max={1.5}
            step={0.05}
            value={draft.temperature ?? 0.9}
            format={(t) => (t < 0.5 ? 'Focused' : t < 1.05 ? 'Balanced' : 'Wild')}
            onChange={(temperature) => set({ temperature })}
          />
          <TransportField
            value={draft.transport}
            onChange={(transport) => set({ transport })}
            deviceOnly={localOnly}
          />
          {test && !test.busy && (
            <StatusLine tone={test.ok ? 'ok' : 'error'}>
              {test.message}
              {test.sample && <span className="aw-sample">“{test.sample}”</span>}
            </StatusLine>
          )}
          {test?.busy && <StatusLine tone="muted">{test.message}</StatusLine>}
        </div>
      )}
    </Sheet>
  );
}
