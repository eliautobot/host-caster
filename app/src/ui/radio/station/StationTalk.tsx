// Talk settings + segments of the station editor.
import { TALK_MIX_STEPS, talkMixOf } from '@/core/radio/planner';
import type { Station, StationSegments, TalkLength } from '@/core/types';
import { Slider, Tabs, Toggle } from '../../components';
import { SEGMENT_META } from '../../screens/parts/segments';
import './station.css';

const LENGTHS: { value: TalkLength; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'normal', label: 'Normal' },
  { value: 'long', label: 'Long' },
];

const LENGTH_HINT: Record<TalkLength, string> = {
  short: 'One or two quick lines, about 10 seconds.',
  normal: 'Three or four lines, about 25 seconds.',
  long: 'Five to eight lines, a real conversation of up to a minute.',
};

const SEGMENT_HINT: Record<keyof StationSegments, string> = {
  songs: 'Intros, outros and trivia',
  time: 'Good morning, late nights',
  weather: 'Now and later today',
  calendar: 'What is coming up next',
  email: 'Light mentions, never the content',
  news: 'Headlines from your feeds',
  lifeEvents: 'Birthdays, anniversaries',
  notes: 'Notes you or your AI apps left',
  reminders: 'Said once, when they are due',
  funFacts: 'Little stories and facts',
};

/** Talk mix steps, Music (0) to My day (4); the default leans toward the listener's day. */
const MIX: { label: string; hint: string }[] = [
  { label: 'Music', hint: 'Mostly the songs: what just played and what is next. Your day only when something is due.' },
  { label: 'Mostly music', hint: 'The songs come first; your day, the news and the weather now and then.' },
  { label: 'Even', hint: 'Songs and your day about evenly. Every song is introduced.' },
  { label: 'More my day', hint: 'Your calendar, reminders, mail and news in every break. Every song is introduced; the last one is named now and then.' },
  { label: 'My day', hint: 'A personal show: your day comes first, the songs get one short line.' },
];

type TalkPatch = Partial<Pick<Station, 'talkEvery' | 'talkLength' | 'talkMix' | 'talkOverIntro' | 'duckLevel' | 'shuffle'>>;

export function StationTalk({ station, live, onChange }: { station: Station; live: boolean; onChange: (p: TalkPatch) => void }) {
  return (
    <div className="aw-talk">
      <Slider
        label={live ? 'Break in every' : 'Talk every'}
        showLabel
        thumb
        min={1}
        max={10}
        step={1}
        value={station.talkEvery}
        format={(x) => (live ? `${Math.max(4, x * 4)} minutes` : x === 1 ? 'Every song' : `${x} songs`)}
        onChange={(talkEvery) => onChange({ talkEvery })}
      />
      <div className="aw-field">
        <span className="aw-field__label">How long they talk</span>
        <Tabs variant="segmented" label="How long they talk" items={LENGTHS} value={station.talkLength} onChange={(talkLength) => onChange({ talkLength })} />
        <p className="aw-field__hint">{LENGTH_HINT[station.talkLength]}</p>
      </div>
      <div className="aw-field aw-talkmix">
        <Slider
          label="Talk mix"
          showLabel
          thumb
          min={0}
          max={TALK_MIX_STEPS - 1}
          step={1}
          value={talkMixOf(station)}
          format={(x) => MIX[x]?.label}
          onChange={(talkMix) => onChange({ talkMix })}
        />
        <div className="aw-talkmix__ends" aria-hidden>
          <span>Music</span>
          <span>My day</span>
        </div>
        <p className="aw-field__hint">{MIX[talkMixOf(station)]?.hint}</p>
      </div>
      <Slider
        label="Music under the voices"
        showLabel
        thumb
        min={0}
        max={60}
        step={2}
        value={Math.round(station.duckLevel * 100)}
        format={(x) => (x === 0 ? 'Silent' : `${x}%`)}
        onChange={(x) => onChange({ duckLevel: x / 100 })}
      />
      {!live && (
        <Toggle
          label="Talk over the intro"
          description="The last line plays over the first seconds of the next song, like real radio."
          checked={station.talkOverIntro}
          onChange={(talkOverIntro) => onChange({ talkOverIntro })}
        />
      )}
      {!live && <Toggle label="Shuffle" description="Mix the songs up. Off plays them in order." checked={station.shuffle} onChange={(shuffle) => onChange({ shuffle })} />}
    </div>
  );
}

export function StationSegmentsEditor({ segments, onChange }: { segments: StationSegments; onChange: (s: StationSegments) => void }) {
  return (
    <div className="aw-segtoggles">
      {SEGMENT_META.map(({ key, label, icon: Icon }) => (
        <label key={key} className="aw-segtoggle">
          <Icon className="aw-segtoggle__icon" aria-hidden />
          <span className="aw-segtoggle__text">
            <span className="aw-segtoggle__title">{label}</span>
            <span className="aw-segtoggle__meta">{SEGMENT_HINT[key]}</span>
          </span>
          <Toggle size="sm" aria-label={label} checked={segments[key]} onChange={(on) => onChange({ ...segments, [key]: on })} />
        </label>
      ))}
    </div>
  );
}
