import { useMemo, useState } from 'react';
import { UserRound } from 'lucide-react';
import { groupArtists, sortTracks } from '@/core/library';
import { useLibrary } from '@/state/library';
import { Artwork, Button, EmptyState, SectionHeader } from '../components';
import { Page } from '../layout/Page';
import { AlbumCard } from '../library/cards';
import { CollectionHero } from '../library/CollectionHero';
import { TrackList } from '../library/TrackList';
import type { ScreenProps } from '.';

const TOP = 5;

/** An artist from your library: top songs and albums (owner: player agent). */
export default function Artist({ params }: ScreenProps) {
  const tracks = useLibrary((s) => s.tracks);
  const ready = useLibrary((s) => s.ready);
  const artist = useMemo(() => groupArtists(tracks).find((a) => a.id === params.id), [tracks, params.id]);
  const [all, setAll] = useState(false);
  const songs = useMemo(() => (artist ? sortTracks(artist.tracks, 'plays') : []), [artist]);

  if (!artist) {
    return (
      <Page back="/library?tab=artists" title="Artist">
        {ready && <EmptyState icon={UserRound} title="Artist not found" description="Their songs may have been deleted." />}
      </Page>
    );
  }
  const shown = all ? songs : songs.slice(0, TOP);
  return (
    <Page>
      <CollectionHero
        round
        kind="Artist"
        title={artist.name}
        meta={`${artist.tracks.length} song${artist.tracks.length === 1 ? '' : 's'} · ${artist.albums.length} album${artist.albums.length === 1 ? '' : 's'}`}
        cover={<Artwork artworkId={artist.artworkId} fluid radius={999} icon={UserRound} />}
        colorFrom={artist.artworkId}
        tracks={songs}
        backTo="/library?tab=artists"
      />
      <SectionHeader
        title="Songs"
        action={
          songs.length > TOP ? (
            <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)}>
              {all ? 'Show less' : `Show all ${songs.length}`}
            </Button>
          ) : undefined
        }
      />
      <TrackList tracks={shown} label={`Songs by ${artist.name}`} from={`Artist · ${artist.name}`} />
      {artist.albums.length > 0 && (
        <section className="aw-section-gap">
          <SectionHeader title="Albums" />
          <div className="aw-tiles">
            {artist.albums.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}
