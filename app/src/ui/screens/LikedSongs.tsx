import { useMemo } from 'react';
import { Heart } from 'lucide-react';
import { formatTotal } from '@/core/library';
import { useLibrary } from '@/state/library';
import { navigate } from '@/state/router';
import { Button, EmptyState } from '../components';
import { Page } from '../layout/Page';
import { CollectionHero } from '../library/CollectionHero';
import { LikedCover } from '../library/covers';
import { TrackList } from '../library/TrackList';
import type { ScreenProps } from '.';

/** Liked songs (owner: player agent). Newest likes first. */
export default function LikedSongs(_: ScreenProps) {
  const all = useLibrary((s) => s.tracks);
  const tracks = useMemo(() => all.filter((t) => t.liked).sort((a, b) => b.updatedAt - a.updatedAt), [all]);
  const total = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  return (
    <Page>
      <CollectionHero
        kind="Playlist"
        title="Liked songs"
        meta={
          <>
            <strong>{tracks.length} song{tracks.length === 1 ? '' : 's'}</strong>
            {total > 0 && `, ${formatTotal(total)}`}
          </>
        }
        cover={<LikedCover fluid radius={14} />}
        tracks={tracks}
        backTo="/library?tab=playlists"
      />
      <TrackList
        tracks={tracks}
        label="Liked songs"
        from="Liked songs"
        empty={
          <EmptyState
            icon={Heart}
            title="Songs you like show up here"
            description="Tap the heart on any song, in the player or in your library."
            actions={
              <Button variant="primary" onClick={() => navigate('/library')}>
                Browse your library
              </Button>
            }
          />
        }
      />
    </Page>
  );
}
