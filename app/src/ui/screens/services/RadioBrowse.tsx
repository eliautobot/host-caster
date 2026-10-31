// Internet radio browser: popular, saved, search by name / genre / country (radio-browser.info).
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Heart, Play, RadioReceiver, RadioTower, RotateCw, Search, WifiOff } from 'lucide-react';
import { getTrack } from '@/core/db';
import { player } from '@/core/player';
import { isWebUrl, openExternal } from '@/core/native';
import {
  listSavedRadios,
  makeRadioStation,
  playableHere,
  countryName,
  RADIO_GENRES,
  previewTrack,
  radioBrowser,
  removeSavedRadio,
  saveRadioToLibrary,
  savedRadioStations,
  stationMeta,
  type RadioStation,
} from '@/core/services/radiobrowser';
import { usePlayer } from '@/state/player';
import { navigate } from '@/state/router';
import { Button, Chip, IconButton, Select, TextField, toast } from '../../components';
import { runAction } from '../../actions';
import { MediaRow, ProblemState, RemoteArt, RowList, RowSkeletons, setPlayedFrom, useAsync } from './parts';
import { RowMenu } from './RowMenu';

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

async function playStation(st: RadioStation) {
  if (!playableHere(st)) throw new Error('This station only streams over http, which browsers block on secure pages.');
  void radioBrowser.countClick(st.uuid);
  const saved = (await listSavedRadios()).find((s) => s.uuid === st.uuid);
  const track = (saved && (await getTrack(saved.trackId))) || previewTrack(st);
  setPlayedFrom([track], 'Internet radio');
  await player.playQueue([track], 0);
}

function StationRow({ st, saved, onSavedChange }: { st: RadioStation; saved: boolean; onSavedChange: () => void }) {
  const current = usePlayer((s) => s.track?.ref === st.url);
  const blocked = !playableHere(st);
  const meta = [stationMeta(st), st.tags.slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  return (
    <MediaRow
      title={st.name}
      subtitle={blocked ? 'http only: blocked on secure pages' : meta || 'Internet radio'}
      leading={<RemoteArt src={st.favicon} icon={RadioReceiver} />}
      current={current}
      dim={blocked}
      onOpen={() => void runAction(() => playStation(st))}
      actions={
        <>
          <IconButton
            icon={Heart}
            label={saved ? 'Remove from saved' : 'Save to library'}
            size="sm"
            active={saved}
            iconProps={saved ? { fill: 'currentColor' } : undefined}
            onClick={() =>
              void runAction(async () => {
                if (saved) await removeSavedRadio(st.uuid);
                else {
                  await saveRadioToLibrary(st);
                  toast.success('Saved to your library', st.name);
                }
                onSavedChange();
              })
            }
          />
          <RowMenu
            label={`More for ${st.name}`}
            items={[
              { icon: Play, label: 'Play now', onSelect: () => void runAction(() => playStation(st)) },
              {
                icon: RadioTower,
                label: 'Make a Host-Caster station',
                onSelect: () =>
                  void runAction(async () => {
                    const station = await makeRadioStation(st);
                    onSavedChange();
                    toast({ title: 'Station ready', description: `${station.name} on ${station.frequency}`, tone: 'success', action: { label: 'Open', onClick: () => navigate(`/stations/${station.id}`) } });
                  }),
              },
              { icon: ExternalLink, label: 'Station website', hidden: !st.homepage || !isWebUrl(st.homepage), onSelect: () => void openExternal(st.homepage ?? '') },
            ]}
          />
        </>
      }
    />
  );
}

export function RadioBrowse() {
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [country, setCountry] = useState('');
  const query = useDebounced(q.trim());
  const filtering = Boolean(query || tag || country);

  const saved = useAsync(listSavedRadios, []);
  const savedIds = useMemo(() => new Set((saved.data ?? []).map((s) => s.uuid)), [saved.data]);
  const countries = useAsync(() => radioBrowser.countries(), []);
  const list = useAsync(
    () => (filtering ? radioBrowser.search({ name: query, tag, countryCode: country, limit: 60 }) : radioBrowser.popular(40)),
    [query, tag, country],
  );
  const savedStations = useAsync(() => savedRadioStations(), [saved.data]);

  return (
    <div className="aw-svc-browse">
      <div className="aw-svc-toolbar">
        <div className="aw-svc-form__row aw-svc-form__row--2">
          <TextField icon={Search} placeholder="Search stations" value={q} onChange={setQ} aria-label="Search stations" type="search" />
          <Select
            aria-label="Country"
            value={country}
            onChange={setCountry}
            options={[
              { value: '', label: 'All countries' },
              ...(countries.data ?? [])
                .slice(0, 150)
                .map((c) => ({ value: c.code, label: `${countryName(c.code, c.name)} (${c.stations.toLocaleString()})` }))
                .sort((a, b) => a.label.localeCompare(b.label)),
            ]}
          />
        </div>
        <div className="aw-svc-chips" role="group" aria-label="Genres">
          <Chip size="sm" selected={!tag} onClick={() => setTag('')}>
            All
          </Chip>
          {RADIO_GENRES.map((t) => (
            <Chip key={t} size="sm" selected={tag === t} onClick={() => setTag(tag === t ? '' : t)}>
              {t}
            </Chip>
          ))}
        </div>
      </div>

      {!filtering && (savedStations.data?.length ?? 0) > 0 && (
        <section className="aw-svc-section" aria-label="Saved stations">
          <div className="aw-svc-section__head">
            <h2 className="aw-svc-section__title">Saved</h2>
          </div>
          <RowList label="Saved stations">
            {savedStations.data!.map((st) => (
              <StationRow key={st.uuid} st={st} saved onSavedChange={saved.reload} />
            ))}
          </RowList>
        </section>
      )}

      <section className="aw-svc-section" aria-label={filtering ? 'Results' : 'Popular stations'}>
        <div className="aw-svc-section__head">
          <h2 className="aw-svc-section__title">{filtering ? 'Stations' : 'Popular right now'}</h2>
          {list.data && <span className="aw-svc-section__meta">{list.data.length} stations</span>}
        </div>
        {list.loading && !list.data ? (
          <RowSkeletons />
        ) : list.error ? (
          <ProblemState
            icon={WifiOff}
            title="Can't reach the radio directory"
            description={
              typeof navigator !== 'undefined' && navigator.onLine === false
                ? 'You are offline. Saved stations still show here; they play once you are back online.'
                : 'radio-browser.info is not answering right now. Try again in a moment.'
            }
            action={
              <Button icon={RotateCw} onClick={list.reload}>
                Try again
              </Button>
            }
          />
        ) : list.data?.length ? (
          <RowList label="Stations" busy={list.loading}>
            {list.data.map((st) => (
              <StationRow key={st.uuid} st={st} saved={savedIds.has(st.uuid)} onSavedChange={saved.reload} />
            ))}
          </RowList>
        ) : (
          <ProblemState icon={RadioReceiver} title="No stations found" description="Try another name, genre or country." />
        )}
      </section>
      <p className="aw-field__hint">Station list by radio-browser.info, a free community directory.</p>
    </div>
  );
}
