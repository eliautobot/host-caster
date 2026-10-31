import { useMemo, useRef, useState } from 'react';
import { Disc3, Ellipsis, ListEnd, ListPlus, UserRound } from 'lucide-react';
import { VARIOUS_ARTISTS, artistIdOf, formatTotal, groupAlbums } from '@/core/library';
import { useLibrary } from '@/state/library';
import { navigate } from '@/state/router';
import { Artwork, EmptyState, IconButton } from '../components';
import { Page } from '../layout/Page';
import { ActionMenu } from '../library/ActionMenu';
import { CollectionHero } from '../library/CollectionHero';
import { dialogs } from '../library/dialogs';
import { addToQueue } from '../library/play';
import { TrackList } from '../library/TrackList';
import type { ScreenProps } from '.';

/** An album from your library (owner: player agent). */
export default function Album({ params }: ScreenProps) {
  const tracks = useLibrary((s) => s.tracks);
  const ready = useLibrary((s) => s.ready);
  const album = useMemo(() => groupAlbums(tracks).find((a) => a.id === params.id), [tracks, params.id]);
  const [menu, setMenu] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);

  if (!album) {
    return (
      <Page back="/library?tab=albums" title="Album">
        {ready && <EmptyState icon={Disc3} title="Album not found" description="Its songs may have been deleted." />}
      </Page>
    );
  }
  return (
    <Page>
      <CollectionHero
        kind="Album"
        title={album.title}
        meta={
          <>
            <strong>{album.artist}</strong>
            {album.year ? ` · ${album.year}` : ''} · {album.tracks.length} song{album.tracks.length === 1 ? '' : 's'}, {formatTotal(album.durationMs)}
          </>
        }
        cover={<Artwork artworkId={album.artworkId} fluid radius={14} icon={Disc3} />}
        colorFrom={album.artworkId}
        tracks={album.tracks}
        backTo="/library?tab=albums"
        actions={
          <>
            <IconButton ref={moreBtn} icon={Ellipsis} label="More" size="lg" variant="solid" aria-haspopup="menu" onClick={() => setMenu((m) => !m)} />
            <ActionMenu
              open={menu}
              onClose={() => setMenu(false)}
              anchor={moreBtn.current}
              label="Album actions"
              items={[
                { icon: ListEnd, label: 'Add to queue', onSelect: () => void addToQueue(album.tracks) },
                { icon: ListPlus, label: 'Add to playlist', onSelect: () => dialogs.addToPlaylist(album.tracks) },
                {
                  icon: UserRound,
                  label: 'Go to artist',
                  hidden: album.artist === VARIOUS_ARTISTS,
                  onSelect: () => navigate(`/library/artists/${artistIdOf(album.tracks[0]!.artist)}`),
                },
              ]}
            />
          </>
        }
      />
      <TrackList tracks={album.tracks} numbered label={`Songs on ${album.title}`} from={`Album · ${album.title}`} />
    </Page>
  );
}
