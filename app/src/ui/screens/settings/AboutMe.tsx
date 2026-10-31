import { useEffect, useRef, useState } from 'react';
import { CalendarHeart, Crosshair, MapPin, Plus, Search, StickyNote, Trash2, AlarmClock } from 'lucide-react';
import { getWeather, lifeEventInfo, locateMe, searchPlaces } from '@/core/context';
import { weatherSpoken } from '@/core/radio/speakable';
import type { GeoPlace, Profile } from '@/core/types';
import { newId } from '@/core/util/id';
import { useProfile } from '@/state/profile';
import { Button, IconButton, Tabs, TextArea, TextField, Toggle, toast } from '../../components';
import { FieldGrid, FormSection, StatusLine, TagInput } from '../../radio/form';
import '../../radio/forms.css';

type Patch = Partial<Omit<Profile, 'id'>>;

/** Debounced profile save for typing fields. */
function useDraft<K extends keyof Profile>(key: K, profile: Profile, update: (p: Patch) => Promise<Profile>) {
  const [value, setValue] = useState(profile[key]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setValue(profile[key]);
  }, [profile, key]);
  const onChange = (v: Profile[K]) => {
    touched.current = true;
    setValue(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void update({ [key]: v } as Patch).finally(() => (touched.current = false));
    }, 500);
  };
  return [value, onChange] as const;
}

export default function AboutMe() {
  const { profile, update } = useProfile();
  const [name, setName] = useDraft('name', profile, update);
  const [callMe, setCallMe] = useDraft('callMe', profile, update);
  const [about, setAbout] = useDraft('about', profile, update);

  return (
    <div>
      <FormSection title="You" description="Your hosts use this to talk to you, not about you. It stays on this device unless you sync.">
        <FieldGrid>
          <TextField label="Name" value={name} autoComplete="name" onChange={setName} placeholder="Sam Rivera" />
          <TextField label="What should they call you?" value={callMe} onChange={setCallMe} placeholder="Sam" />
        </FieldGrid>
        <TextArea label="A little about you" rows={2} autoResize value={about} onChange={setAbout} placeholder="Night-shift nurse, two cats, training for a half marathon" />
        <TagInput label="Things you love" values={profile.interests} onChange={(interests) => update({ interests })} placeholder="running, jazz, cooking" suggestions={['music trivia', 'sports', 'movies', 'cooking', 'travel', 'tech']} />
        <TagInput label="Never bring up" values={profile.avoidTopics} onChange={(avoidTopics) => update({ avoidTopics })} placeholder="politics" suggestions={['politics', 'religion', 'diets', 'sad news']} />
      </FormSection>
      <PlaceSection profile={profile} update={update} />
      <LifeEvents profile={profile} update={update} />
      <Notes profile={profile} update={update} />
      <Reminders profile={profile} update={update} />
    </div>
  );
}

type SectionProps = { profile: Profile; update: (p: Patch) => Promise<Profile> };

function PlaceSection({ profile, update }: SectionProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<(GeoPlace & { detail: string })[]>([]);
  const [busy, setBusy] = useState<'search' | 'locate'>();
  const [weather, setWeather] = useState<string>();
  const loc = profile.location;

  useEffect(() => {
    setWeather(undefined);
    if (!loc) return;
    let live = true;
    void getWeather(loc, profile.units).then((w) => live && setWeather(w ? `Right now: ${weatherSpoken(w)}.` : 'Weather is not reachable right now.'));
    return () => {
      live = false;
    };
  }, [loc, profile.units]);

  const search = async () => {
    setBusy('search');
    try {
      const r = await searchPlaces(query);
      setResults(r);
      if (!r.length) toast({ title: 'No places found', description: 'Try the city name only.' });
    } catch (err) {
      toast.error('Search failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  const locate = async () => {
    setBusy('locate');
    try {
      const place = await locateMe();
      await update({ location: { ...place, name: place.name || 'Your area' } });
    } catch (err) {
      toast.error('Could not find you', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <FormSection title="Where you are" description="For the weather and the right time of day. Only the city is used.">
      {loc && (
        <div className="aw-entry">
          <span className="aw-preset__icon">
            <MapPin aria-hidden />
          </span>
          <div className="aw-entry__text">
            <p className="aw-entry__title">{loc.name}</p>
            <p className="aw-entry__meta">{weather ?? 'Checking the weather...'}</p>
          </div>
          <IconButton icon={Trash2} label="Remove location" onClick={() => update({ location: undefined })} />
        </div>
      )}
      <div className="aw-modelrow">
        <TextField
          label={loc ? 'Change city' : 'Your city'}
          icon={Search}
          value={query}
          placeholder="Lisbon"
          onChange={setQuery}
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && void search()}
        />
        <Button loading={busy === 'search'} disabled={query.trim().length < 2} onClick={search}>
          Search
        </Button>
        <IconButton icon={Crosshair} label="Use my location" variant="solid" disabled={busy === 'locate'} onClick={locate} />
      </div>
      {results.length > 0 && (
        <div className="aw-entries">
          {results.map((r) => (
            <button
              key={`${r.lat},${r.lon}`}
              type="button"
              className="aw-entry aw-entry--button"
              onClick={() => {
                void update({ location: { name: r.name, lat: r.lat, lon: r.lon } });
                setResults([]);
                setQuery('');
              }}
            >
              <span className="aw-entry__text">
                <span className="aw-entry__title">{r.name}</span>
                <span className="aw-entry__meta" style={{ display: 'block' }}>
                  {r.detail}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="aw-field">
        <span className="aw-field__label">Units</span>
        <Tabs
          variant="segmented"
          label="Units"
          value={profile.units}
          onChange={(units) => update({ units })}
          items={[
            { value: 'metric', label: '°C, km' },
            { value: 'imperial', label: '°F, miles' },
          ]}
        />
      </div>
    </FormSection>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function LifeEvents({ profile, update }: SectionProps) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [yearly, setYearly] = useState(true);
  const add = () => {
    if (!title.trim() || !date) return;
    void update({ lifeEvents: [...profile.lifeEvents, { id: newId(), title: title.trim(), date, yearly }] });
    setTitle('');
    setDate('');
  };
  const sorted = [...profile.lifeEvents].sort((a, b) => (lifeEventInfo(a)?.daysAway ?? 999) - (lifeEventInfo(b)?.daysAway ?? 999));
  return (
    <FormSection title="Life events" description="Birthdays, anniversaries, big days. Hosts bring them up the week before and on the day.">
      {sorted.length > 0 && (
        <div className="aw-entries">
          {sorted.map((e) => {
            const info = lifeEventInfo(e);
            return (
              <div key={e.id} className="aw-entry">
                <span className="aw-preset__icon">
                  <CalendarHeart aria-hidden />
                </span>
                <div className="aw-entry__text">
                  <p className="aw-entry__title">{e.title}</p>
                  <p className="aw-entry__meta">
                    {new Date(`${e.date}T12:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: e.yearly ? undefined : 'numeric' })}
                    {e.yearly ? ' · every year' : ''}
                    {info && info.daysAway >= 0 && info.daysAway <= 30 ? ` · ${info.when}` : ''}
                  </p>
                </div>
                <IconButton icon={Trash2} label={`Remove ${e.title}`} onClick={() => update({ lifeEvents: profile.lifeEvents.filter((x) => x.id !== e.id) })} />
              </div>
            );
          })}
        </div>
      )}
      <FieldGrid>
        <TextField label="What" value={title} onChange={setTitle} placeholder="Mom's birthday" />
        <TextField label="Date" type="date" value={date} onChange={setDate} placeholder={today()} />
      </FieldGrid>
      <div className="aw-hstack aw-hstack--between">
        <Toggle checked={yearly} onChange={setYearly} label="Every year" />
        <Button icon={Plus} disabled={!title.trim() || !date} onClick={add}>
          Add event
        </Button>
      </div>
    </FormSection>
  );
}

function Notes({ profile, update }: SectionProps) {
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const add = () => {
    if (!text.trim()) return;
    void update({ notes: [...profile.notes, { id: newId(), text: text.trim(), until: until ? new Date(`${until}T23:59`).getTime() : undefined }] });
    setText('');
    setUntil('');
  };
  return (
    <FormSection title="Notes for your hosts" description="Anything you want them to know or mention: a shout-out, a goal, a little joke.">
      {profile.notes.length > 0 && (
        <div className="aw-entries">
          {profile.notes.map((n) => (
            <div key={n.id} className="aw-entry">
              <span className="aw-preset__icon">
                <StickyNote aria-hidden />
              </span>
              <div className="aw-entry__text">
                <p className="aw-entry__title">{n.text}</p>
                <p className="aw-entry__meta">{n.until ? (n.until < Date.now() ? 'Expired' : `Until ${new Date(n.until).toLocaleDateString()}`) : 'No end date'}</p>
              </div>
              <IconButton icon={Trash2} label="Remove note" onClick={() => update({ notes: profile.notes.filter((x) => x.id !== n.id) })} />
            </div>
          ))}
        </div>
      )}
      <FieldGrid>
        <TextField label="Note" value={text} onChange={setText} placeholder="I'm running my first 10K on Sunday" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <TextField label="Until (optional)" type="date" value={until} onChange={setUntil} />
      </FieldGrid>
      <div>
        <Button icon={Plus} disabled={!text.trim()} onClick={add}>
          Add note
        </Button>
      </div>
    </FormSection>
  );
}

function Reminders({ profile, update }: SectionProps) {
  const [text, setText] = useState('');
  const [at, setAt] = useState('');
  const add = () => {
    if (!text.trim() || !at) return;
    void update({ reminders: [...profile.reminders, { id: newId(), text: text.trim(), at: new Date(at).getTime() }] });
    setText('');
    setAt('');
  };
  const upcoming = [...profile.reminders].sort((a, b) => a.at - b.at);
  return (
    <FormSection title="Reminders" description="Hosts mention them in the breaks before they are due.">
      {upcoming.length > 0 && (
        <div className="aw-entries">
          {upcoming.map((r) => (
            <div key={r.id} className="aw-entry">
              <span className="aw-preset__icon">
                <AlarmClock aria-hidden />
              </span>
              <div className="aw-entry__text">
                <p className="aw-entry__title">{r.text}</p>
                <p className="aw-entry__meta">{new Date(r.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{r.at < Date.now() ? ' · done' : ''}</p>
              </div>
              <IconButton icon={Trash2} label="Remove reminder" onClick={() => update({ reminders: profile.reminders.filter((x) => x.id !== r.id) })} />
            </div>
          ))}
        </div>
      )}
      <FieldGrid>
        <TextField label="Remind me to" value={text} onChange={setText} placeholder="Call the pharmacy" />
        <TextField label="When" type="datetime-local" value={at} onChange={setAt} />
      </FieldGrid>
      <div>
        <Button icon={Plus} disabled={!text.trim() || !at} onClick={add}>
          Add reminder
        </Button>
      </div>
      {upcoming.some((r) => r.at < Date.now() - 86_400_000) && (
        <StatusLine tone="muted">
          <button type="button" className="aw-textlink" onClick={() => update({ reminders: profile.reminders.filter((r) => r.at >= Date.now() - 86_400_000) })}>
            Clear old reminders
          </button>
        </StatusLine>
      )}
    </FormSection>
  );
}
