// YouTube Music browser: your playlists (incl. Liked videos) and search, through the Host-Caster server.
import { useState, type FormEvent } from 'react';
import { CloudOff, Heart, ListMusic, LogIn, Play, Plug, Plus, RadioTower, Search, Server, SquarePlay } from 'lucide-react';
import { createStationFor, findStationWith } from '@/core/services/imports';
import {
  connectYouTube,
  importVideos,
  importYouTubePlaylist,
  leftOutText,
  thumbUrl,
  youTubeStatus,
  ytPlaylistPage,
  ytPlaylists,
  ytSearch,
  type YouTubeImport,
  type YtPlaylist,
  type YtVideo,
} from '@/core/services/youtube';
import { formatDuration } from '@/core/util/time';
import { usePlayer } from '@/state/player';
import { navigate } from '@/state/router';
import { Button, TextField, toast } from '../../components';
import { runAction } from '../../actions';
import { BusyButton, MediaRow, ProblemState, RemoteArt, RowList, RowSkeletons, errorText, formatCount, importAndPlay, useAsync } from './parts';
import { RowMenu } from './RowMenu';

const BASE = '/services/youtube';

/** The whole playlist (in steps, with a progress toast), then how many came in and what was left out and why. */
async function importPlaylist(pl: Pick<YtPlaylist, 'id' | 'title' | 'liked' | 'thumbnail'>): Promise<YouTubeImport> {
  const progress = toast({ title: 'Importing from YouTube', description: 'Reading the playlist…', duration: 0 });
  try {
    const res = await importYouTubePlaylist(pl, {
      onProgress: (read, total) => progress.update({ description: total ? `${read.toLocaleString()} of ${formatCount(total, 'video')} read` : `${formatCount(read, 'video')} read` }),
    });
    progress();
    const note = leftOutText(res);
    toast({ title: `${formatCount(res.tracks.length, 'video')} in ${res.playlist.name}`, description: note || undefined, tone: 'success', duration: note ? 9000 : 4000 });
    return res;
  } catch (err) {
    progress();
    throw err;
  }
}

async function playlistStation(pl: Pick<YtPlaylist, 'id' | 'title' | 'liked'>) {
  const { playlist } = await importPlaylist(pl);
  const source = { kind: 'youtube-playlist' as const, ref: playlist.id };
  const station = (await findStationWith(source)) ?? (await createStationFor({ name: playlist.name, description: 'From YouTube', sources: [source], seed: `youtube:${pl.id}` }));
  toast({ title: 'Station ready', description: `${station.name} on ${station.frequency}`, tone: 'success', action: { label: 'Open', onClick: () => navigate(`/stations/${station.id}`) } });
}

function VideoList({ videos, label }: { videos: YtVideo[]; label: string }) {
  const currentRef = usePlayer((s) => (s.track?.source === 'youtube' ? s.track.ref : undefined));
  return (
    <RowList label={label}>
      {videos.map((v, i) => (
        <MediaRow
          key={`${v.videoId}-${i}`}
          title={v.title}
          subtitle={v.channel}
          leading={<RemoteArt src={v.thumbnail || thumbUrl(v.videoId)} wide icon={SquarePlay} size={44} />}
          current={currentRef === v.videoId}
          onOpen={() => void runAction(() => importAndPlay(() => importVideos(videos), i))}
          actions={
            <>
              <span className="aw-svc-row__sub aw-tabular aw-svc-hide-sm">{v.durationMs ? formatDuration(v.durationMs) : ''}</span>
              <RowMenu
                label={`More for ${v.title}`}
                items={[
                  { icon: Play, label: 'Play', onSelect: () => void runAction(() => importAndPlay(() => importVideos([v]))) },
                  { icon: Plus, label: 'Add to library', onSelect: () => void runAction(() => importVideos([v]), { success: 'Added to your library' }) },
                ]}
              />
            </>
          }
        />
      ))}
    </RowList>
  );
}

function PlaylistDetail({ id, title }: { id: string; title: string }) {
  const liked = id === 'LL';
  // the first step of the list to look at; importing reads all of it
  const page = useAsync(() => ytPlaylistPage(id), [id]);
  const items = { ...page, data: page.data?.items };
  const count = page.data ? Math.max(page.data.total ?? 0, page.data.items.length) : 0;
  const pl = { id, title, liked };
  return (
    <div className="aw-svc-browse">
      <div className="aw-svc-hero">
        <RemoteArt src={items.data?.[0] ? items.data[0].thumbnail || thumbUrl(items.data[0].videoId) : undefined} size={96} icon={liked ? Heart : ListMusic} />
        <div className="aw-svc-hero__text">
          <p className="aw-svc-hero__kicker">YouTube playlist</p>
          <h2 className="aw-svc-hero__title">{liked ? 'Liked videos' : title}</h2>
          {items.data && <p className="aw-svc-hero__meta">{formatCount(count, 'video')}</p>}
        </div>
      </div>
      <div className="aw-svc-actions">
        <Button variant="primary" icon={Play} disabled={!items.data?.length} onClick={() => void runAction(() => importAndPlay(async () => (await importPlaylist(pl)).tracks, 0, `YouTube · ${liked ? 'Liked videos' : title}`))}>
          Play
        </Button>
        <BusyButton icon={Plus} disabled={!items.data?.length} onRun={() => importPlaylist(pl)}>
          Add to library
        </BusyButton>
        <BusyButton variant="ghost" icon={RadioTower} disabled={!items.data?.length} onRun={() => playlistStation(pl)}>
          Make a station
        </BusyButton>
      </div>
      {items.loading && !items.data ? (
        <RowSkeletons />
      ) : items.error ? (
        <ProblemState icon={CloudOff} title="Could not open this playlist" description={errorText(items.error)} />
      ) : items.data?.length ? (
        <VideoList videos={items.data} label="Videos" />
      ) : (
        <ProblemState icon={ListMusic} title="This playlist is empty" />
      )}
    </div>
  );
}

export function YouTubeBrowse({ query }: { query: Record<string, string> }) {
  const status = useAsync(youTubeStatus, []);
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState('');
  const lists = useAsync(async () => (status.data?.state === 'ready' ? ytPlaylists() : undefined), [status.data?.state]);
  const results = useAsync(async () => (searched ? ytSearch(searched) : undefined), [searched]);

  if (status.loading) return <RowSkeletons />;
  const st = status.data!;
  if (st.state !== 'ready') {
    const action =
      st.state === 'not-connected' ? (
        <Button variant="primary" icon={Plug} onClick={() => void runAction(() => connectYouTube(BASE))}>
          Connect YouTube
        </Button>
      ) : st.state === 'signed-out' ? (
        <Button variant="primary" icon={LogIn} onClick={() => navigate('/sign-in')}>
          Sign in
        </Button>
      ) : st.state === 'no-server' ? (
        <Button icon={Server} onClick={() => navigate('/settings/account')}>
          Set up a server
        </Button>
      ) : (
        <Button onClick={status.reload}>Try again</Button>
      );
    return <ProblemState icon={SquarePlay} title="YouTube is not connected" description={st.message} action={action} />;
  }
  if (query.playlist) return <PlaylistDetail id={query.playlist} title={query.title ?? 'Playlist'} />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSearched(q.trim());
  };

  return (
    <div className="aw-svc-browse">
      <form className="aw-svc-toolbar" onSubmit={submit} role="search">
        <TextField
          icon={Search}
          type="search"
          placeholder="Search YouTube for a song, press Enter"
          aria-label="Search YouTube"
          value={q}
          onChange={(v) => {
            setQ(v);
            if (!v.trim()) setSearched('');
          }}
        />
      </form>
      {searched ? (
        <section className="aw-svc-section" aria-label="Search results">
          <div className="aw-svc-section__head">
            <h2 className="aw-svc-section__title">Results</h2>
          </div>
          {results.loading && !results.data ? (
            <RowSkeletons />
          ) : results.error ? (
            <ProblemState icon={CloudOff} title="Search failed" description={errorText(results.error)} />
          ) : results.data?.length ? (
            <VideoList videos={results.data} label="Results" />
          ) : (
            <ProblemState icon={Search} title={`Nothing for "${searched}"`} />
          )}
        </section>
      ) : (
        <section className="aw-svc-section" aria-label="Your playlists">
          <div className="aw-svc-section__head">
            <h2 className="aw-svc-section__title">Your playlists</h2>
            {st.email && <span className="aw-svc-section__meta">{st.email}</span>}
          </div>
          {lists.loading && !lists.data ? (
            <RowSkeletons />
          ) : lists.error ? (
            <ProblemState icon={CloudOff} title="Could not load your playlists" description={errorText(lists.error)} action={<Button onClick={lists.reload}>Try again</Button>} />
          ) : (
            <RowList label="Playlists">
              {(lists.data ?? []).map((p) => (
                <MediaRow
                  key={p.id}
                  title={p.liked ? 'Liked videos' : p.title}
                  subtitle={p.count ? formatCount(p.count, 'video') : p.liked ? 'Your likes on YouTube' : undefined}
                  leading={<RemoteArt src={p.thumbnail} icon={p.liked ? Heart : ListMusic} />}
                  onOpen={() => navigate(`${BASE}?playlist=${encodeURIComponent(p.id)}&title=${encodeURIComponent(p.title)}`)}
                  actions={
                    <RowMenu
                      label={`More for ${p.title}`}
                      items={[
                        { icon: Play, label: 'Play', onSelect: () => void runAction(() => importAndPlay(async () => (await importPlaylist(p)).tracks)) },
                        { icon: Plus, label: 'Add to library', onSelect: () => void runAction(() => importPlaylist(p)) },
                        { icon: RadioTower, label: 'Make a station', onSelect: () => void runAction(() => playlistStation(p)) },
                      ]}
                    />
                  }
                />
              ))}
            </RowList>
          )}
        </section>
      )}
    </div>
  );
}
