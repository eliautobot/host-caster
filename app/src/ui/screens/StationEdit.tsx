import { useEffect, useState } from 'react';
import { History, Play, RadioTower, Square, Trash2 } from 'lucide-react';
import { radio } from '@/core/radio';
import { defaultSegments } from '@/core/db';
import type { Draft, Station } from '@/core/types';
import { newId } from '@/core/util/id';
import { useHosts } from '@/state/hosts';
import { useRadio } from '@/state/radio';
import { navigate } from '@/state/router';
import { useStation, useStations } from '@/state/stations';
import { runAction } from '../actions';
import { Button, EmptyState, StationArt, TextArea, TextField, toast } from '../components';
import { Page } from '../layout/Page';
import { FieldGrid, FormSection, SaveBar, Swatches } from '../radio/form';
import { StationFeeds } from '../radio/station/StationFeeds';
import { StationHosts } from '../radio/station/StationHosts';
import { StationSources } from '../radio/station/StationSources';
import { StationSegmentsEditor, StationTalk } from '../radio/station/StationTalk';
import type { ScreenProps } from '.';

type StationDraft = Draft<Station> & Pick<Station, 'id'>;

/** Warm and neutral station colours (no purple). */
const COLORS = [
  { value: '#ff5a36', label: 'Signal orange' },
  { value: '#ffb020', label: 'Amber' },
  { value: '#e2725b', label: 'Terracotta' },
  { value: '#c2410c', label: 'Rust' },
  { value: '#e11d48', label: 'Rose' },
  { value: '#0f766e', label: 'Teal' },
  { value: '#2563eb', label: 'Blue' },
  { value: '#16a34a', label: 'Green' },
  { value: '#52525b', label: 'Graphite' },
].map((c) => ({ ...c, css: c.value }));

function blankStation(hostIds: string[]): StationDraft {
  return {
    id: newId(),
    name: '',
    frequency: (88 + Math.floor(Math.random() * 190) / 10).toFixed(1),
    color: COLORS[Math.floor(Math.random() * 4)]!.value,
    description: '',
    sources: [{ kind: 'library' }],
    hostIds: hostIds.slice(0, 2),
    talkEvery: 2,
    talkLength: 'normal',
    segments: defaultSegments(),
    talkOverIntro: true,
    duckLevel: 0.18,
    newsFeeds: [],
    shuffle: true,
  };
}

const cleanFrequency = (f: string) => f.replace(/[^0-9.]/g, '').slice(0, 5);

/** Station editor. params.id = station id or 'new'. */
export default function StationEdit({ params }: ScreenProps) {
  const isNew = params.id === 'new';
  const stored = useStation(isNew ? undefined : params.id);
  const ready = useStations((s) => s.ready);
  const { save, remove } = useStations();
  const hosts = useHosts((s) => s.hosts);
  const hostsReady = useHosts((s) => s.ready);
  const r = useRadio();
  const [draft, setDraft] = useState<StationDraft>();
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (draft) return;
    if (isNew && hostsReady) setDraft(blankStation(hosts.map((h) => h.id)));
    else if (!isNew && stored) setDraft(stored);
  }, [isNew, stored, draft, hosts, hostsReady]);

  if (!draft) {
    return (
      <Page back="/stations" title="Station" width="narrow">
        {ready && !isNew && <EmptyState icon={RadioTower} title="Station not found" description="It may have been deleted." />}
      </Page>
    );
  }

  const set = (patch: Partial<StationDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };
  const station = draft as Station;
  const onAir = r.onAir && r.stationId === draft.id;
  const live = draft.sources.some((s) => s.kind === 'stream');
  const name = draft.name.trim() || `Host-Caster ${draft.frequency || '88.1'}`;

  const persist = async () => {
    if (!draft.sources.length) throw new Error('Pick at least one music source');
    if (!draft.hostIds.length) throw new Error('Put at least one host on the mic');
    const saved = await save({ ...draft, name, frequency: draft.frequency || '88.1', description: draft.description?.trim() || undefined });
    setDirty(false);
    if (isNew) navigate(`/stations/${saved.id}`, { replace: true });
    return saved;
  };

  const onSave = () =>
    runAction(async () => {
      const before = stored?.sources;
      const saved = await persist();
      toast.success(isNew ? `${saved.name} is on the dial` : 'Station saved');
      if (!onAir) return;
      // new music sources need a restart; anything else is picked up from the next break
      if (JSON.stringify(before) !== JSON.stringify(saved.sources)) await radio.start(saved.id, { restart: true });
      else await radio.reload();
    });

  const onToggleAir = () =>
    runAction(async () => {
      if (onAir) return radio.stop();
      const saved = dirty || isNew ? await persist() : station;
      await radio.start(saved.id);
    });

  const onDelete = () =>
    runAction(async () => {
      if (!confirm(`Delete ${draft.name || 'this station'}? Your songs and hosts stay.`)) return;
      if (onAir) radio.stop();
      await remove(draft.id);
      navigate('/stations', { replace: true });
    });

  return (
    <Page
      back="/stations"
      eyebrow={isNew ? 'New station' : `${draft.frequency || '88.1'} FM`}
      title={draft.name || (isNew ? 'Create a station' : 'Station')}
      subtitle={draft.description || 'Music, hosts and what they talk about.'}
      tint={draft.color}
      width="narrow"
      actions={<StationArt color={draft.color} frequency={draft.frequency || '88.1'} size={56} radius={12} />}
    >
      <div className="aw-hstack aw-stationedit__top">
        <Button variant={onAir ? 'secondary' : 'primary'} icon={onAir ? Square : Play} onClick={onToggleAir}>
          {onAir ? 'Stop the station' : 'Go on air'}
        </Button>
        {!isNew && (
          <Button variant="ghost" icon={History} onClick={() => navigate(`/on-air?station=${draft.id}`)}>
            On-air history
          </Button>
        )}
      </div>

      <FormSection title="On the dial" description="How the station looks in your list and on the lock screen.">
        <FieldGrid>
          <TextField label="Name" value={draft.name} placeholder={`Host-Caster ${draft.frequency || '88.1'}`} maxLength={32} onChange={(n) => set({ name: n })} />
          <TextField
            label="Frequency"
            value={draft.frequency}
            inputMode="decimal"
            placeholder="88.1"
            hint="Just for show"
            onChange={(f) => set({ frequency: cleanFrequency(f) })}
          />
        </FieldGrid>
        <TextArea label="Description" rows={2} autoResize maxLength={140} value={draft.description ?? ''} placeholder="Easy mornings with Maya and Jules" onChange={(description) => set({ description })} />
        <Swatches label="Colour" value={draft.color} options={COLORS.some((c) => c.value === draft.color) ? COLORS : [...COLORS, { value: draft.color, label: 'Current', css: draft.color }]} onChange={(color) => set({ color })} />
      </FormSection>

      <FormSection title="Music" description="Where the songs come from. Mix as many as you like.">
        <StationSources sources={draft.sources} onChange={(sources) => set({ sources })} />
      </FormSection>

      <FormSection title="Hosts" description="Up to four voices on the mic. The first one leads the show.">
        <StationHosts hostIds={draft.hostIds} onChange={(hostIds) => set({ hostIds })} />
      </FormSection>

      <FormSection title="Talk" description={live ? 'A radio stream has no song ends, so the hosts break in on a timer.' : 'How often and how long the hosts talk between songs.'}>
        <StationTalk station={station} live={live} onChange={set} />
      </FormSection>

      <FormSection title="What they talk about" description="Topics rotate, so nothing is repeated too soon.">
        <StationSegmentsEditor segments={draft.segments} onChange={(segments) => set({ segments })} />
      </FormSection>

      <FormSection title="News feeds" description="RSS or Atom feeds the hosts take headlines from.">
        <StationFeeds feeds={draft.newsFeeds} newsOn={draft.segments.news} onChange={(newsFeeds) => set({ newsFeeds })} />
      </FormSection>

      {!isNew && (
        <div className="aw-dangerrow">
          <Button variant="ghost" icon={Trash2} onClick={onDelete}>
            Delete station
          </Button>
        </div>
      )}

      {(dirty || isNew) && (
        <SaveBar note={isNew ? undefined : 'Unsaved changes'}>
          {!isNew && (
            <Button variant="ghost" onClick={() => (setDraft(stored), setDirty(false))}>
              Discard
            </Button>
          )}
          <Button variant="primary" onClick={onSave}>
            {isNew ? 'Create station' : 'Save'}
          </Button>
        </SaveBar>
      )}
    </Page>
  );
}
