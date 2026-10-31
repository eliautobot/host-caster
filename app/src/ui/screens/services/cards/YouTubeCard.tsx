import { Library, LogIn, Plug, Server } from 'lucide-react';
import { api } from '@/core/api';
import { connectYouTube, youTubeStatus } from '@/core/services/youtube';
import { navigate } from '@/state/router';
import { Button } from '../../../components';
import { runAction } from '../../../actions';
import { useAsync } from '../parts';
import { CardText, Caps, Note, ServiceCard } from './CardFrame';

export function YouTubeCard() {
  const status = useAsync(youTubeStatus, [api.available, api.session?.user.id]);
  const st = status.data;
  const ready = st?.state === 'ready';
  // web: the page goes to Google and comes back; native: resolves when the app is back, then re-check
  const connect = () =>
    void runAction(async () => {
      await connectYouTube();
      status.reload();
    });
  const line = !st ? 'Checking…' : st.state === 'ready' ? `Connected${st.email ? ` as ${st.email}` : ''}` : st.message;

  let action = null;
  if (st?.state === 'ready') {
    action = (
      <Button variant="primary" icon={Library} onClick={() => navigate('/services/youtube')}>
        Browse YouTube
      </Button>
    );
  } else if (st?.state === 'not-connected') {
    action = (
      <Button variant="primary" icon={Plug} onClick={connect}>
        Connect YouTube
      </Button>
    );
  } else if (st?.state === 'signed-out') {
    action = api.config?.signIn.google ? (
      <>
        <Button variant="primary" icon={LogIn} onClick={connect}>
          Sign in with Google
        </Button>
        <Button variant="ghost" onClick={() => navigate('/sign-in')}>
          Other ways to sign in
        </Button>
      </>
    ) : (
      <Button variant="primary" icon={LogIn} onClick={() => navigate('/sign-in')}>
        Sign in
      </Button>
    );
  } else if (st?.state === 'no-server') {
    action = (
      <Button icon={Server} onClick={() => navigate('/settings/account')}>
        Set up a server
      </Button>
    );
  }

  return (
    <ServiceCard
      kind="youtube"
      id="svc-youtube"
      title="YouTube Music"
      status={ready ? 'connected' : st && st.state !== 'error' && st.state !== 'rate-limited' ? 'off' : undefined}
      statusLine={line}
    >
      <CardText>
        Import your YouTube playlists and Liked videos, or search for a song. Music plays in YouTube&apos;s own player and the
        video shows in Now Playing. Sign-in goes through your Host-Caster server, which keeps the Google permission.
      </CardText>
      <Caps items={[['Your playlists + Liked videos'], ['Search'], ['Video in Now Playing'], ['Offline', false]]} />
      <Note plain>
        Some videos do not allow playback outside YouTube, and YouTube may show ads in its player. YouTube Music&apos;s own
        &ldquo;Liked music&rdquo; list is not open to other apps, so Host-Caster uses your YouTube Liked videos.
      </Note>
      {action && <div className="aw-svc-actions">{action}</div>}
    </ServiceCard>
  );
}
