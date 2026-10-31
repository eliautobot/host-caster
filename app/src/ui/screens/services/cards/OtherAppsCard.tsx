import { RadioTower, Smartphone } from 'lucide-react';
import { anyApp, platform } from '@/core/native';
import { createStationFor, findStationWith } from '@/core/services/imports';
import { navigate } from '@/state/router';
import { Button } from '../../../components';
import { runAction } from '../../../actions';
import { CardText, Note, ServiceCard } from './CardFrame';

const CLOSED_APPS = ['Amazon Music', 'Apple Music', 'Tidal', 'Deezer', 'SoundCloud', 'Pandora', 'Qobuz', 'YouTube Music app'];

/** Opens the station that uses Any music app mode, creating it the first time. */
export async function openAnyAppStation(): Promise<void> {
  const source = { kind: 'anyapp' as const };
  const station =
    (await findStationWith(source)) ??
    (await createStationFor({
      // the hosts say the station name on air ("Welcome to Any music app" sounded broken)
      name: 'Host-Caster Anywhere',
      description: 'Your hosts talk between songs from the music app you already use.',
      sources: [source],
      seed: 'anyapp',
      talkEvery: 2,
      talkLength: 'short',
      talkOverIntro: false,
      shuffle: false,
    }));
  navigate(`/stations/${station.id}`);
}

export function OtherAppsCard() {
  const android = platform === 'android' && anyApp.available;
  return (
    <ServiceCard
      tile={
        <span className="aw-svc-tile aw-svc-tile--neutral" style={{ width: 44, height: 44 }} aria-hidden>
          <Smartphone />
        </span>
      }
      id="svc-other"
      title="Other music apps"
      statusLine={android ? 'Any music app mode' : 'Any music app mode is in the Android app'}
    >
      <CardText>
        These services have no open way for other apps to play their music, so Host-Caster cannot import them:
      </CardText>
      <div className="aw-svc-apps">
        {CLOSED_APPS.map((a) => (
          <span key={a} className="aw-svc-cap aw-svc-cap--no">
            {a}
          </span>
        ))}
      </div>
      {android ? (
        <Note plain>
          <b>Any music app mode:</b> keep listening in the app you like. Host-Caster sees what is playing (with notification
          access) and your hosts break in between songs; the other app ducks or pauses, then carries on.
        </Note>
      ) : platform === 'ios' ? (
        <Note plain>iOS does not let apps see what other apps are playing, so this mode is Android only.</Note>
      ) : (
        <Note plain>
          On Android, <b>Any music app mode</b> lets your hosts talk over whatever app you already use: Host-Caster sees the song
          that is playing and breaks in between songs. Install the Android app to use it.
        </Note>
      )}
      <div className="aw-svc-actions">
        <Button
          variant={android ? 'primary' : 'secondary'}
          icon={RadioTower}
          disabled={!android}
          onClick={() => void runAction(openAnyAppStation)}
        >
          Set up an Any music app station
        </Button>
      </div>
    </ServiceCard>
  );
}
