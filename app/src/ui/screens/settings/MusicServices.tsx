// Settings > Music services (owner: services builder): one card per service with status, connect/disconnect,
// what it can do, and honest notes.
import { OtherAppsCard } from '../services/cards/OtherAppsCard';
import { RadioCard } from '../services/cards/RadioCard';
import { SpotifyCard } from '../services/cards/SpotifyCard';
import { SubsonicCard } from '../services/cards/SubsonicCard';
import { YouTubeCard } from '../services/cards/YouTubeCard';
import '../services/services.css';

export default function MusicServices() {
  return (
    <div className="aw-svc-cards">
      <p className="aw-svc-intro">
        Songs you add from a service join your library and stations like any other song. Your own files always work too.
      </p>
      <SubsonicCard />
      <RadioCard />
      <YouTubeCard />
      <SpotifyCard />
      <OtherAppsCard />
    </div>
  );
}
