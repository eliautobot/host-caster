// Spotify browser: Liked Songs, your playlists, search. Import into the library or play right away.
import { useEffect, useState } from 'react';
import { AudioWaveform, CloudOff, Heart, ListMusic, Play, Plus, RadioTower, Search } from 'lucide-react';
import { createStationFor, findStationWith } from '@/core/services/imports';
import {
  importSpotifyLiked,
  importSpotifyPlaylist,
  importSpotifyTracks,
  listSpotifyPlaylists,
  pickImage,
  playlistTrackCount,
  searchSpotify,
  spotifyLikedTracks,
  spotifyPlaylistTracks,
  type SpotifyPlaylistSummary,
  type SpotifyTrackObject,
} from '@/core/services/spotify';
import { formatDuration } from '@/core/util/time';
import { usePlayer } from '@/state/player';
import { navigate } from '@/state/router';
import { useSettings } from '@/state/settings';
import { Button, TextField, toast } from '../../components';
import { runAction } from '../../actions';
import { BusyButton, MediaRow, ProblemState, RemoteArt, RowList, RowSkeletons, errorText, formatCount, importAndPlay, useAsync } from './parts';
import { RowMenu } from './RowMenu';

const BASE = '/services/spotify';
const LIKED = 'liked';

async function makeStation(name: string, importFn: () => Promise<{ playlist: { id: string; name: string } }>, seed: string) {
  const { playlist } = await importFn();
  const source = { kind: 'spotify-playlist' as const, ref: playlist.id };
  const station = (await findStationWith(source)) ?? (await createStationFor({ name, description: 'From Spotify', sources: [source], seed }));
  toast({ title: 'Station ready', description: `${station.name} on ${station.frequency}`, tone: 'success', action: { label: 'Open', onClick: () => navigate(`/stations/${station.id}`) } });
}

function TrackRows({ tracks, label }: { tracks: SpotifyTrackObject[]; label: string }) {
  const currentRef = usePlayer((s) => (s.track?.source === 'spotify' ? s.track.ref : undefined));
  return (
    <RowList label={label}>
      {tracks.map((t, i) => (
        <MediaRow
          key={`${t.uri}-${i}`}
          title={t.name}
          subtitle={[t.artists?.map((a) => a.name).join(', '), t.album?.name].filter(Boolean).join(' · ')}
          src={pickImage(t.album?.images, 64)}
          current={currentRef === t.uri}
          onOpen={() => void runAction(() => importAndPlay(() => importSpotifyTracks(tracks), i))}
          actions={
            <>
              <span className="aw-svc-row__sub aw-tabular aw-svc-hide-sm">{formatDuration(t.duration_ms)}</span>
              <RowMenu
                label={`More for ${t.name}`}
                items={[
                  { icon: Play, label: 'Play', onSelect: () => void runAction(() => importAndPlay(() => importSpotifyTracks([t]))) },
                  { icon: Plus, label: 'Add to library', onSelect: () => void runAction(() => importSpotifyTracks([t]), { success: 'Added to your library' }) },
                ]}
              />
            </>
          }
        />
      ))}
    </RowList>
  );
}

function PlaylistDetail({ id, lists }: { id: string; lists?: SpotifyPlaylistSummary[] }) {
  const liked = id === LIKED;
  const meta = lists?.find((p) => p.id === id);
  const tracks = useAsync(() => (liked ? spotifyLikedTracks(500) : spotifyPlaylistTracks(id)), [id]);
  const name = liked ? 'Liked Songs' : (meta?.name ?? 'Playlist');
  const doImport = () => (liked ? importSpotifyLiked() : importSpotifyPlaylist(meta ?? { id, name }));
  return (
    <div className="aw-svc-browse">
      <div className="aw-svc-hero">
        <RemoteArt src={liked ? undefined : pickImage(meta?.images, 300)} size={96} icon={liked ? Heart : ListMusic} />
        <div className="aw-svc-hero__text">
          <p className="aw-svc-hero__kicker">Spotify {liked ? 'library' : 'playlist'}</p>
          <h2 className="aw-svc-hero__title">{name}</h2>
          {tracks.data && <p className="aw-svc-hero__meta">{formatCount(tracks.data.length, 'song')}</p>}
        </div>
      </div>
      <div className="aw-svc-actions">
        <Button variant="primary" icon={Play} disabled={!tracks.data?.length} onClick={() => void runAction(() => importAndPlay(async () => (await doImport()).tracks, 0, `Spotify · ${name}`))}>
          Play
        </Button>
        <BusyButton icon={Plus} disabled={!tracks.data?.length} onRun={doImport} success={`${name} added to your library`}>
          Add to library
        </BusyButton>
        <BusyButton variant="ghost" icon={RadioTower} disabled={!tracks.data?.length} onRun={() => makeStation(name, doImport, `spotify:${id}`)}>
          Make a station
        </BusyButton>
      </div>
      {tracks.loading && !tracks.data ? (
        <RowSkeletons />
      ) : tracks.error ? (
        <ProblemState icon={CloudOff} title="Could not open this playlist" description={errorText(tracks.error)} />
      ) : tracks.data?.length ? (
        <TrackRows tracks={tracks.data} label="Songs" />
      ) : (
        <ProblemState icon={ListMusic} title="No playable songs here" />
      )}
    </div>
  );
}

export function SpotifyBrowse({ query }: { query: Record<string, string> }) {
  const connected = useSettings((s) => s.settings.connections.spotify?.connected);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  const lists = useAsync(async () => (connected ? listSpotifyPlaylists() : undefined), [connected]);
  const results = useAsync(async () => (debounced ? searchSpotify(debounced) : undefined), [debounced]);

  if (!connected) {
    return (
      <ProblemState
        icon={AudioWaveform}
        title="Spotify is not connected"
        description="Connect your Spotify account in Settings > Music services."
        action={<Button variant="primary" onClick={() => navigate('/settings/music-services')}>Connect Spotify</Button>}
      />
    );
  }
  if (query.playlist) return <PlaylistDetail id={query.playlist} lists={lists.data} />;

  return (
    <div className="aw-svc-browse">
      <div className="aw-svc-toolbar">
        <TextField icon={Search} type="search" placeholder="Search Spotify" aria-label="Search Spotify" value={q} onChange={setQ} />
      </div>
      {debounced ? (
        results.loading && !results.data ? (
          <RowSkeletons />
        ) : results.error ? (
          <ProblemState icon={CloudOff} title="Search failed" description={errorText(results.error)} />
        ) : results.data?.length ? (
          <TrackRows tracks={results.data} label="Results" />
        ) : (
          <ProblemState icon={Search} title={`Nothing for "${debounced}"`} />
        )
      ) : (
        <section className="aw-svc-section" aria-label="Your library">
          <RowList label="Playlists">
            <MediaRow
              title="Liked Songs"
              subtitle="Your saved songs"
              leading={<RemoteArt icon={Heart} />}
              onOpen={() => navigate(`${BASE}?playlist=${LIKED}`)}
            />
            {lists.loading && !lists.data ? null : lists.error ? null : (
              (lists.data ?? []).map((p) => (
                <MediaRow
                  key={p.id}
                  title={p.name}
                  subtitle={[formatCount(playlistTrackCount(p), 'song'), p.owner?.display_name].filter(Boolean).join(' · ')}
                  src={pickImage(p.images, 120)}
                  onOpen={() => navigate(`${BASE}?playlist=${encodeURIComponent(p.id)}`)}
                  actions={
                    <RowMenu
                      label={`More for ${p.name}`}
                      items={[
                        { icon: Play, label: 'Play', onSelect: () => void runAction(() => importAndPlay(async () => (await importSpotifyPlaylist(p)).tracks)) },
                        { icon: Plus, label: 'Add to library', onSelect: () => void runAction(() => importSpotifyPlaylist(p), { success: 'Playlist added to your library' }) },
                        { icon: RadioTower, label: 'Make a station', onSelect: () => void runAction(() => makeStation(p.name, () => importSpotifyPlaylist(p), `spotify:${p.id}`)) },
                      ]}
                    />
                  }
                />
              ))
            )}
          </RowList>
          {lists.loading && !lists.data && <RowSkeletons count={4} />}
          {lists.error ? <ProblemState icon={CloudOff} title="Could not load your playlists" description={errorText(lists.error)} action={<Button onClick={lists.reload}>Try again</Button>} /> : null}
        </section>
      )}
    </div>
  );
}
