import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Disc3, Heart, ListMusic, ListPlus, Music2, Play, Search, Server, Shuffle, Upload, UserRound } from 'lucide-react';
import {
  formatBytes,
  groupAlbums,
  groupArtists,
  matchesName,
  searchTracks,
  serverLibraryAvailable,
  sortTracks,
  storageUsage,
  syncServerLibraryIfStale,
  type TrackSort,
} from '@/core/library';
import type { Track, TrackSource } from '@/core/types';
import { useLibrary } from '@/state/library';
import { navigate } from '@/state/router';
import { Button, Chip, EmptyState, IconButton, Select, Tabs, TextField } from '../components';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { Page } from '../layout/Page';
import { AlbumCard, ArtistCard, LikedCard, NewTile, PlaylistCard } from '../library/cards';
import { dialogs } from '../library/dialogs';
import { EmptyLibrary } from '../library/EmptyLibrary';
import { AddMusicButton, ImportProgressCard, syncServer, usePickers } from '../library/importUi';
import { playTracks } from '../library/play';
import { TrackList } from '../library/TrackList';
import type { ScreenProps } from '.';
import './Library.css';

type LibraryTab = 'songs' | 'albums' | 'artists' | 'playlists' | 'liked';

const TABS = [
  { value: 'songs', label: 'Songs', icon: Music2 },
  { value: 'albums', label: 'Albums', icon: Disc3 },
  { value: 'artists', label: 'Artists', icon: UserRound },
  { value: 'playlists', label: 'Playlists', icon: ListMusic },
  { value: 'liked', label: 'Liked', icon: Heart },
] as const satisfies { value: LibraryTab; label: string; icon: unknown }[];

const SORTS: { value: TrackSort; label: string }[] = [
  // short labels: the sort sits next to Play and Shuffle on a 360 px phone
  { value: 'added', label: 'Date added' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'plays', label: 'Most played' },
  { value: 'recent', label: 'Last played' },
];

const SOURCE_LABEL: Record<TrackSource, string> = {
  local: 'This device',
  server: 'Server',
  spotify: 'Spotify',
  youtube: 'YouTube',
  stream: 'Radio',
  subsonic: 'Subsonic',
  device: 'Device music',
};

/** Library (owner: player agent): songs, albums, artists, playlists, liked; import, streams, server library. */
export default function Library({ query }: ScreenProps) {
  const desktop = useIsDesktop();
  // the tab lives in the URL (?tab=albums) so Back and links land on the right one
  const tab: LibraryTab = TABS.some((t) => t.value === query.tab) ? (query.tab as LibraryTab) : 'songs';
  const setTab = (t: LibraryTab) => navigate(t === 'songs' ? '/library' : `/library?tab=${t}`, { replace: true });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<TrackSort>('added');
  const [source, setSource] = useState<TrackSource | 'all'>('all');
  const { tracks, playlists, ready } = useLibrary();
  const [bytes, setBytes] = useState<number>();
  const pickers = usePickers();
  const empty = ready && tracks.length === 0 && playlists.length === 0;

  useEffect(() => {
    void syncServerLibraryIfStale().catch(() => undefined);
  }, []);
  useEffect(() => {
    void storageUsage().then((u) => setBytes(u.libraryBytes), () => undefined);
  }, [tracks.length]);

  const sources = useMemo(() => [...new Set(tracks.map((t) => t.source))], [tracks]);
  const pool = useMemo(() => (source === 'all' ? tracks : tracks.filter((t) => t.source === source)), [tracks, source]);
  const songs = useMemo(() => sortTracks(searchTracks(pool, q), sort), [pool, q, sort]);
  const liked = useMemo(() => sortTracks(searchTracks(tracks.filter((t) => t.liked), q), 'added'), [tracks, q]);
  const albums = useMemo(() => groupAlbums(pool).filter((a) => !q || matchesName(`${a.title} ${a.artist}`, q)), [pool, q]);
  const artists = useMemo(() => groupArtists(pool).filter((a) => !q || matchesName(a.name, q)), [pool, q]);
  const lists = useMemo(() => playlists.filter((p) => !q || matchesName(p.name, q)), [playlists, q]);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const listTracks = (ids: string[]) => ids.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t));

  const subtitle = empty
    ? 'Everything your stations can play.'
    : [
        `${tracks.length.toLocaleString()} song${tracks.length === 1 ? '' : 's'}`,
        `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`,
        bytes ? `${formatBytes(bytes)} on this device` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <Page
      title="Library"
      subtitle={subtitle}
      actions={
        <>
          {!desktop && !empty && <IconButton icon={Search} label="Search your library" variant="solid" onClick={() => navigate('/library/search')} />}
          <AddMusicButton pickers={pickers} />
        </>
      }
    >
      {pickers.inputs}
      <ImportProgressCard />
      {empty ? (
        <EmptyLibrary pickers={pickers} />
      ) : (
        <>
          <div className="aw-library__toolbar">
            <Tabs items={[...TABS]} value={tab} onChange={setTab} label="Library sections" />
            {desktop && (
              <TextField
                icon={Search}
                placeholder="Search your library"
                value={q}
                onChange={setQ}
                aria-label="Search your library"
                className="aw-library__search"
                type="search"
              />
            )}
          </div>

          {(tab === 'songs' || tab === 'albums' || tab === 'artists') && sources.length > 1 && (
            <div className="aw-library__sources" role="group" aria-label="Show songs from">
              <Chip size="sm" selected={source === 'all'} onClick={() => setSource('all')}>
                All
              </Chip>
              {sources.map((s) => (
                <Chip key={s} size="sm" selected={source === s} onClick={() => setSource(s)}>
                  {SOURCE_LABEL[s]}
                </Chip>
              ))}
            </div>
          )}

          {tab === 'songs' && (
            <section aria-label="Songs">
              <ListBar tracks={songs}>
                <Select
                  value={sort}
                  options={SORTS}
                  onChange={setSort}
                  aria-label="Sort songs"
                  className="aw-library__sort"
                />
              </ListBar>
              <TrackList
                tracks={songs}
                from="Your library"
                empty={<EmptyState size="compact" icon={Search} title="No songs match" description="Try another word." />}
              />
            </section>
          )}

          {tab === 'albums' &&
            (albums.length ? (
              <div className="aw-tiles">
                {albums.map((a) => (
                  <AlbumCard key={a.id} album={a} />
                ))}
              </div>
            ) : (
              <EmptyState size="compact" icon={Disc3} title={q ? 'No albums match' : 'No albums yet'} />
            ))}

          {tab === 'artists' &&
            (artists.length ? (
              <div className="aw-tiles">
                {artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} />
                ))}
              </div>
            ) : (
              <EmptyState size="compact" icon={UserRound} title={q ? 'No artists match' : 'No artists yet'} />
            ))}

          {tab === 'playlists' && (
            <div className="aw-tiles">
              {!q && <NewTile icon={ListPlus} title="New playlist" desc="Start from scratch" onClick={() => dialogs.newPlaylist()} />}
              {!q && <NewTile icon={Upload} title="Import playlist" desc="M3U, M3U8 or PLS file" onClick={pickers.pickPlaylist} />}
              {!q && <LikedCard tracks={tracks.filter((t) => t.liked)} />}
              {lists.map((p) => (
                <PlaylistCard key={p.id} playlist={p} tracks={() => listTracks(p.trackIds)} />
              ))}
            </div>
          )}

          {tab === 'liked' && (
            <section aria-label="Liked songs">
              <ListBar tracks={liked} />
              <TrackList
                tracks={liked}
                from="Liked songs"
                to="/library/liked"
                empty={
                  <EmptyState
                    icon={Heart}
                    title={q ? 'No liked songs match' : 'Songs you like show up here'}
                    description={q ? undefined : 'Tap the heart on any song to save it here.'}
                  />
                }
              />
            </section>
          )}

          {serverLibraryAvailable() && tab === 'songs' && !sources.includes('server') && (
            <div className="aw-library__server">
              <Server aria-hidden />
              <p>Your Host-Caster server has a music library.</p>
              <Button size="sm" onClick={() => void syncServer()}>
                Show its songs
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

function ListBar({ tracks, children }: { tracks: Track[]; children?: ReactNode }) {
  return (
    <div className="aw-library__listbar">
      <Button variant="primary" size="sm" icon={Play} disabled={!tracks.length} onClick={() => void playTracks(tracks, 0, { shuffle: false })}>
        Play
      </Button>
      <Button size="sm" icon={Shuffle} disabled={tracks.length < 2} onClick={() => void playTracks(tracks, 0, { shuffle: true })}>
        Shuffle
      </Button>
      <span className="aw-library__count">
        {tracks.length.toLocaleString()} song{tracks.length === 1 ? '' : 's'}
      </span>
      {children}
    </div>
  );
}

