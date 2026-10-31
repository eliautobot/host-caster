// Browse a Subsonic-compatible server: playlists, albums, artists, starred, search. Import or play anything.
import { useEffect, useState, type ReactNode } from 'react';
import { CloudOff, Disc3, Heart, ListMusic, Mic2, Play, Plus, RadioTower, Search, Server } from 'lucide-react';
import { createStationFor, findStationWith } from '@/core/services/imports';
import {
  getSubsonicClient,
  importSongs,
  importSubsonicAlbum,
  importSubsonicPlaylist,
  importSubsonicStarred,
  type SubsonicAlbum,
  type SubsonicArtist,
  type SubsonicClient,
  type SubsonicPlaylist,
  type SubsonicSong,
} from '@/core/services/subsonic';
import { formatDuration } from '@/core/util/time';
import { usePlayer } from '@/state/player';
import { navigate } from '@/state/router';
import { Button, Tabs, TextField, toast } from '../../components';
import { runAction } from '../../actions';
import { BusyButton, MediaRow, ProblemState, RemoteArt, RowList, RowSkeletons, errorText, formatCount, importAndPlay, useAsync } from './parts';
import { RowMenu } from './RowMenu';

type View = 'playlists' | 'albums' | 'artists' | 'starred';
const BASE = '/services/subsonic';

const albumName = (a: SubsonicAlbum) => a.name ?? a.title ?? 'Album';

function songsMeta(count?: number, seconds?: number) {
  return [count !== undefined ? formatCount(count, 'song') : '', seconds ? formatDuration(seconds * 1000) : ''].filter(Boolean).join(' · ');
}

async function playlistStation(client: SubsonicClient, pl: SubsonicPlaylist) {
  const { playlist } = await importSubsonicPlaylist(client, pl.id);
  const source = { kind: 'playlist' as const, ref: playlist.id };
  const station = (await findStationWith(source)) ?? (await createStationFor({ name: pl.name, description: 'From your music server', sources: [source], seed: `subsonic:${pl.id}` }));
  toast({ title: 'Station ready', description: `${station.name} on ${station.frequency}`, tone: 'success', action: { label: 'Open', onClick: () => navigate(`/stations/${station.id}`) } });
}

function SongList({ client, songs, label }: { client: SubsonicClient; songs: SubsonicSong[]; label: string }) {
  const currentRef = usePlayer((s) => (s.track?.source === 'subsonic' ? s.track.ref : undefined));
  return (
    <RowList label={label}>
      {songs.map((s, i) => (
        <MediaRow
          key={`${s.id}-${i}`}
          title={s.title ?? 'Untitled'}
          subtitle={[s.artist, s.album].filter(Boolean).join(' · ')}
          src={s.coverArt ? client.coverArtUrl(s.coverArt, 120) : undefined}
          current={currentRef === s.id}
          onOpen={() => void runAction(() => importAndPlay(() => importSongs(client, songs), i))}
          actions={
            <>
              <span className="aw-svc-row__sub aw-tabular aw-svc-hide-sm">{s.duration ? formatDuration(s.duration * 1000) : ''}</span>
              <RowMenu
                label={`More for ${s.title ?? 'song'}`}
                items={[
                  { icon: Play, label: 'Play', onSelect: () => void runAction(() => importAndPlay(() => importSongs(client, [s]))) },
                  { icon: Plus, label: 'Add to library', onSelect: () => void runAction(() => importSongs(client, [s]), { success: 'Added to your library' }) },
                ]}
              />
            </>
          }
        />
      ))}
    </RowList>
  );
}

function Hero({ art, kicker, title, meta, children }: { art?: string; kicker: string; title: string; meta?: string; children?: ReactNode }) {
  return (
    <div className="aw-svc-browse">
      <div className="aw-svc-hero">
        <RemoteArt src={art} size={96} icon={Disc3} />
        <div className="aw-svc-hero__text">
          <p className="aw-svc-hero__kicker">{kicker}</p>
          <h2 className="aw-svc-hero__title">{title}</h2>
          {meta && <p className="aw-svc-hero__meta">{meta}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function PlaylistDetail({ client, id }: { client: SubsonicClient; id: string }) {
  const pl = useAsync(() => client.playlist(id), [id]);
  if (pl.loading && !pl.data) return <RowSkeletons />;
  if (pl.error || !pl.data) return <ProblemState icon={CloudOff} title="Could not open this playlist" description={errorText(pl.error)} />;
  const p = pl.data;
  return (
    <Hero art={p.coverArt ? client.coverArtUrl(p.coverArt, 300) : undefined} kicker="Playlist" title={p.name} meta={songsMeta(p.songCount, p.duration)}>
      <div className="aw-svc-actions">
        <Button variant="primary" icon={Play} onClick={() => void runAction(() => importAndPlay(async () => (await importSubsonicPlaylist(client, id)).tracks, 0, `Playlist · ${p.name}`))}>
          Play
        </Button>
        <BusyButton icon={Plus} onRun={() => importSubsonicPlaylist(client, id)} success="Playlist added to your library">
          Add to library
        </BusyButton>
        <BusyButton variant="ghost" icon={RadioTower} onRun={() => playlistStation(client, p)}>
          Make a station
        </BusyButton>
      </div>
      <SongList client={client} songs={p.entry ?? []} label="Songs" />
    </Hero>
  );
}

function AlbumDetail({ client, id }: { client: SubsonicClient; id: string }) {
  const al = useAsync(() => client.album(id), [id]);
  if (al.loading && !al.data) return <RowSkeletons />;
  if (al.error || !al.data) return <ProblemState icon={CloudOff} title="Could not open this album" description={errorText(al.error)} />;
  const a = al.data;
  return (
    <Hero
      art={a.coverArt ? client.coverArtUrl(a.coverArt, 300) : undefined}
      kicker="Album"
      title={albumName(a)}
      meta={[a.artist, a.year, songsMeta(a.songCount, a.duration)].filter(Boolean).join(' · ')}
    >
      <div className="aw-svc-actions">
        <Button variant="primary" icon={Play} onClick={() => void runAction(() => importAndPlay(() => importSubsonicAlbum(client, id), 0, `Album · ${albumName(a)}`))}>
          Play
        </Button>
        <BusyButton icon={Plus} onRun={() => importSubsonicAlbum(client, id)} success="Album added to your library">
          Add to library
        </BusyButton>
      </div>
      <SongList client={client} songs={a.song ?? []} label="Songs" />
    </Hero>
  );
}

function AlbumRows({ client, albums }: { client: SubsonicClient; albums: SubsonicAlbum[] }) {
  return (
    <RowList label="Albums">
      {albums.map((a) => (
        <MediaRow
          key={a.id}
          title={albumName(a)}
          subtitle={[a.artist, a.year].filter(Boolean).join(' · ')}
          src={a.coverArt ? client.coverArtUrl(a.coverArt, 120) : undefined}
          onOpen={() => navigate(`${BASE}?album=${encodeURIComponent(a.id)}`)}
          actions={
            <RowMenu
              label={`More for ${albumName(a)}`}
              items={[
                { icon: Play, label: 'Play', onSelect: () => void runAction(() => importAndPlay(() => importSubsonicAlbum(client, a.id))) },
                { icon: Plus, label: 'Add to library', onSelect: () => void runAction(() => importSubsonicAlbum(client, a.id), { success: 'Album added to your library' }) },
              ]}
            />
          }
        />
      ))}
    </RowList>
  );
}

function ArtistDetail({ client, id }: { client: SubsonicClient; id: string }) {
  const ar = useAsync(() => client.artist(id), [id]);
  if (ar.loading && !ar.data) return <RowSkeletons />;
  if (ar.error || !ar.data) return <ProblemState icon={CloudOff} title="Could not open this artist" description={errorText(ar.error)} />;
  return (
    <Hero art={ar.data.coverArt ? client.coverArtUrl(ar.data.coverArt, 300) : undefined} kicker="Artist" title={ar.data.name} meta={formatCount(ar.data.album?.length ?? 0, 'album')}>
      <AlbumRows client={client} albums={ar.data.album ?? []} />
    </Hero>
  );
}

function Lists({ client, view }: { client: SubsonicClient; view: View }) {
  const data = useAsync(async (): Promise<ReactNode> => {
    if (view === 'playlists') {
      const pls = await client.playlists();
      if (!pls.length) return <ProblemState icon={ListMusic} title="No playlists on your server yet" />;
      return (
        <RowList label="Playlists">
          {pls.map((p) => (
            <MediaRow
              key={p.id}
              title={p.name}
              subtitle={songsMeta(p.songCount, p.duration)}
              src={p.coverArt ? client.coverArtUrl(p.coverArt, 120) : undefined}
              onOpen={() => navigate(`${BASE}?playlist=${encodeURIComponent(p.id)}`)}
              actions={
                <RowMenu
                  label={`More for ${p.name}`}
                  items={[
                    { icon: Play, label: 'Play', onSelect: () => void runAction(() => importAndPlay(async () => (await importSubsonicPlaylist(client, p.id)).tracks)) },
                    { icon: Plus, label: 'Add to library', onSelect: () => void runAction(() => importSubsonicPlaylist(client, p.id), { success: 'Playlist added to your library' }) },
                    { icon: RadioTower, label: 'Make a station', onSelect: () => void runAction(() => playlistStation(client, p)) },
                  ]}
                />
              }
            />
          ))}
        </RowList>
      );
    }
    if (view === 'albums') return <AlbumRows client={client} albums={await client.albumList('alphabeticalByName', 200)} />;
    if (view === 'artists') {
      const artists = await client.artists();
      return (
        <RowList label="Artists">
          {artists.map((a) => (
            <MediaRow
              key={a.id}
              round
              title={a.name}
              subtitle={a.albumCount !== undefined ? formatCount(a.albumCount, 'album') : undefined}
              src={a.coverArt ? client.coverArtUrl(a.coverArt, 120) : (a as SubsonicArtist).artistImageUrl}
              onOpen={() => navigate(`${BASE}?artist=${encodeURIComponent(a.id)}`)}
            />
          ))}
        </RowList>
      );
    }
    const st = await client.starred();
    return (
      <>
        <div className="aw-svc-actions">
          <BusyButton variant="primary" icon={Heart} onRun={() => importSubsonicStarred(client)} success="Starred songs added as liked">
            Add starred to my likes
          </BusyButton>
        </div>
        {st.songs.length ? <SongList client={client} songs={st.songs} label="Starred songs" /> : null}
        {st.albums.length ? <AlbumRows client={client} albums={st.albums} /> : null}
        {!st.songs.length && !st.albums.length && <ProblemState icon={Heart} title="Nothing starred yet" description="Star songs or albums in your server's app and they show up here." />}
      </>
    );
  }, [view]);
  if (data.loading && !data.data) return <RowSkeletons />;
  if (data.error) return <ProblemState icon={CloudOff} title="Your server is not answering" description={errorText(data.error)} action={<Button onClick={data.reload}>Try again</Button>} />;
  return <>{data.data}</>;
}

function SearchResults({ client, q }: { client: SubsonicClient; q: string }) {
  const r = useAsync(() => client.search(q), [q]);
  if (r.loading && !r.data) return <RowSkeletons />;
  if (r.error) return <ProblemState icon={CloudOff} title="Search failed" description={errorText(r.error)} />;
  const d = r.data!;
  if (!d.songs.length && !d.albums.length && !d.artists.length) return <ProblemState icon={Search} title={`Nothing for "${q}"`} />;
  return (
    <>
      {d.songs.length > 0 && <SongList client={client} songs={d.songs} label="Songs" />}
      {d.albums.length > 0 && <AlbumRows client={client} albums={d.albums} />}
    </>
  );
}

export function SubsonicBrowse({ query }: { query: Record<string, string> }) {
  const client = useAsync(getSubsonicClient, []);
  const [view, setView] = useState<View>('playlists');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  if (client.loading) return <RowSkeletons />;
  const c = client.data;
  if (!c) {
    return (
      <ProblemState
        icon={Server}
        title="No music server connected"
        description="Connect Navidrome, Airsonic, Gonic, Jellyfin or another Subsonic server first."
        action={<Button variant="primary" onClick={() => navigate('/settings/music-services')}>Connect a server</Button>}
      />
    );
  }
  if (query.playlist) return <PlaylistDetail client={c} id={query.playlist} />;
  if (query.album) return <AlbumDetail client={c} id={query.album} />;
  if (query.artist) return <ArtistDetail client={c} id={query.artist} />;

  return (
    <div className="aw-svc-browse">
      <div className="aw-svc-toolbar">
        <TextField icon={Search} type="search" placeholder="Search your server" aria-label="Search your server" value={q} onChange={setQ} />
        {!debounced && (
          <Tabs<View>
            label="Browse"
            value={view}
            onChange={setView}
            items={[
              { value: 'playlists', label: 'Playlists', icon: ListMusic },
              { value: 'albums', label: 'Albums', icon: Disc3 },
              { value: 'artists', label: 'Artists', icon: Mic2 },
              { value: 'starred', label: 'Starred', icon: Heart },
            ]}
          />
        )}
      </div>
      {debounced ? <SearchResults client={c} q={debounced} /> : <Lists client={c} view={view} />}
    </div>
  );
}

