import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { groupAlbums, groupArtists, matchesName, searchTracks } from '@/core/library';
import { useLibrary } from '@/state/library';
import { navigate } from '@/state/router';
import { EmptyState, SectionHeader, TextField } from '../components';
import { Page } from '../layout/Page';
import { AlbumCard, ArtistCard, PlaylistCard } from '../library/cards';
import { TrackList } from '../library/TrackList';
import type { ScreenProps } from '.';
import './Library.css';

/** Search across songs, albums, artists and playlists (owner: player agent). */
export default function LibrarySearch({ query }: ScreenProps) {
  const [q, setQ] = useState(query.q ?? '');
  const { tracks, playlists } = useLibrary();
  const r = useMemo(() => {
    if (!q.trim()) return undefined;
    return {
      songs: searchTracks(tracks, q).slice(0, 50),
      albums: groupAlbums(tracks).filter((a) => matchesName(`${a.title} ${a.artist}`, q)).slice(0, 12),
      artists: groupArtists(tracks).filter((a) => matchesName(a.name, q)).slice(0, 12),
      playlists: playlists.filter((p) => matchesName(p.name, q)).slice(0, 12),
    };
  }, [q, tracks, playlists]);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const nothing = r && !r.songs.length && !r.albums.length && !r.artists.length && !r.playlists.length;

  return (
    <Page back="/library" title="Search">
      <form
        className="aw-search__form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/library/search?q=${encodeURIComponent(q)}`, { replace: true });
        }}
      >
        <TextField
          icon={Search}
          type="search"
          placeholder="Songs, albums, artists, playlists"
          value={q}
          onChange={setQ}
          aria-label="Search your library"
          autoFocus
        />
      </form>
      {!r && <EmptyState size="compact" icon={Search} title="Search your library" description="Find songs, albums, artists and playlists." />}
      {nothing && <EmptyState size="compact" icon={Search} title={`Nothing for "${q}"`} description="Check the spelling or try fewer words." />}
      {r && r.artists.length > 0 && (
        <section className="aw-search__section">
          <SectionHeader title="Artists" />
          <div className="aw-tiles">
            {r.artists.map((a) => (
              <ArtistCard key={a.id} artist={a} />
            ))}
          </div>
        </section>
      )}
      {r && r.songs.length > 0 && (
        <section className="aw-search__section">
          <SectionHeader title="Songs" />
          <TrackList tracks={r.songs} from={`Search · ${q}`} />
        </section>
      )}
      {r && r.albums.length > 0 && (
        <section className="aw-search__section">
          <SectionHeader title="Albums" />
          <div className="aw-tiles">
            {r.albums.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </div>
        </section>
      )}
      {r && r.playlists.length > 0 && (
        <section className="aw-search__section">
          <SectionHeader title="Playlists" />
          <div className="aw-tiles">
            {r.playlists.map((p) => (
              <PlaylistCard key={p.id} playlist={p} tracks={() => p.trackIds.flatMap((id) => byId.get(id) ?? [])} />
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}
