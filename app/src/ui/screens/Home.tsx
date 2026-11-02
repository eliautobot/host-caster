import { useMemo, type CSSProperties } from 'react';
import { AlertTriangle, AudioLines, ListMusic, Pencil, Play, Square } from 'lucide-react';
import { isNative, openExternal } from '@/core/native';
import { radio } from '@/core/radio';
import { greeting } from '@/core/util/time';
import { useHosts } from '@/state/hosts';
import { useLibrary } from '@/state/library';
import { usePlayer } from '@/state/player';
import { useProfile } from '@/state/profile';
import { useRadio } from '@/state/radio';
import { navigate } from '@/state/router';
import { useActiveStation, useStations } from '@/state/stations';
import { runAction } from '../actions';
import { Avatar, AvatarStack, Badge, Button, Card, Chip, EmptyState, IconButton, Link, OnAirBadge, SectionHeader, StationArt } from '../components';
import { Page } from '../layout/Page';
import { LikedCard, PlaylistCard } from '../library/cards';
import '../library/library.css';
import { TalkToHostsButton } from '../radio';
import { BreakCard } from '../radio/history/BreakCard';
import { useBreaks } from '../radio/history/useBreaks';
import '../radio/history/history.css';
import { lineup } from './parts/StationCard';
import { SEGMENT_META } from './parts/segments';
import type { ScreenProps } from '.';
import './Home.css';
import { UsageBanner } from '../online/parts';
import { FallbackBanner, NoAiLine } from '../radio/fallback';
import { HomeList } from '../list/HomeList';

/** External links open in the system browser on the phone app. */
function openOut(e: { preventDefault: () => void }, url: string) {
  if (!isNative) return;
  e.preventDefault();
  void openExternal(url);
}

export default function Home(_: ScreenProps) {
  const station = useActiveStation();
  const stations = useStations((s) => s.stations);
  const hosts = useHosts((s) => s.hosts);
  const profile = useProfile((s) => s.profile);
  const r = useRadio();
  const live = usePlayer((p) => Boolean(p.live));
  const onAir = r.onAir && r.stationId === station?.id;
  const onMic = useMemo(() => (station ? lineup(hosts, station.hostIds) : []), [hosts, station]);
  const others = hosts.filter((h) => !station?.hostIds.includes(h.id));
  const name = profile.callMe || profile.name;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const recent = useBreaks(3);
  const byStation = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);

  const status = onAir
    ? r.phase === 'talking'
      ? `${hosts.find((h) => h.id === r.speakingHostId)?.name ?? onMic[0]?.name ?? 'Your host'} is on the mic`
      : r.phase === 'preparing'
        ? 'The hosts are getting ready'
        : live
          ? 'The hosts break in every few minutes'
          : r.nextBreakIn <= 1
          ? 'The hosts are on after this song'
          : `The hosts are on in ${r.nextBreakIn} songs`
    : undefined;

  return (
    <Page eyebrow={today} title={name ? `${greeting()}, ${name}` : greeting()} tint={station?.color}>
      <UsageBanner />
      <FallbackBanner hosts={onMic} />
      {station && (
        <section className="aw-hero" style={{ '--c': station.color } as CSSProperties} aria-label="Your station">
          <div className="aw-hero__art">
            <StationArt color={station.color} frequency={station.frequency} fluid radius={18} />
          </div>
          <div className="aw-hero__head">
            <div className="aw-hero__badges">
              <OnAirBadge onAir={onAir} />
              <Badge>{station.frequency} FM</Badge>
            </div>
            <h2 className="aw-hero__name">{station.name}</h2>
          </div>
          <div className="aw-hero__details">
            {station.description && <p className="aw-hero__desc">{station.description}</p>}
            {onMic.length > 0 && (
              <div className="aw-hero__hosts">
                <AvatarStack people={onMic} size={30} speakingId={r.speakingHostId} />
                <span>
                  <strong>{onMic.map((h) => h.name).join(' & ')}</strong> {status ? `· ${status}` : `on the mic · talks every ${station.talkEvery === 1 ? 'song' : `${station.talkEvery} songs`}`}
                </span>
              </div>
            )}
            {onAir && r.notice && r.phase !== 'talking' && (
              <p className="aw-hero__notice" role="status">
                <AlertTriangle aria-hidden />
                <span>
                  {r.notice.replace(/[.!]+$/, '')}.{r.notice.startsWith('Break skipped') ? ' The music plays on.' : ''}{' '}
                  {r.noticeLink?.url.startsWith('/') ? (
                    // the fix is in the app (the Host-Caster plan page)
                    <Link to={r.noticeLink.url} className="aw-textlink">
                      {r.noticeLink.label}
                    </Link>
                  ) : r.noticeLink ? (
                    // the fix is elsewhere (ChatGPT usage settings)
                    <a className="aw-textlink" href={r.noticeLink.url} target="_blank" rel="noopener noreferrer" onClick={(e) => openOut(e, r.noticeLink!.url)}>
                      {r.noticeLink.label}
                    </a>
                  ) : (
                    <>
                      Check{' '}
                      <Link to="/settings/brains" className="aw-textlink">
                        Brains
                      </Link>{' '}
                      and{' '}
                      <Link to="/settings/voices" className="aw-textlink">
                        Voices
                      </Link>
                      .
                    </>
                  )}
                </span>
              </p>
            )}
            {onAir && r.phase === 'talking' && r.caption && (
              <p className="aw-hero__caption" aria-live="polite">
                “{r.caption}”
              </p>
            )}
            <div className="aw-hero__actions">
              {onAir ? (
                <Button variant="primary" size="lg" icon={AudioLines} onClick={() => navigate('/now-playing')}>
                  Now playing
                </Button>
              ) : (
                <Button variant="primary" size="lg" icon={Play} onClick={() => runAction(() => radio.start(station.id))}>
                  Go on air
                </Button>
              )}
              <TalkToHostsButton
                size="lg"
                label={
                  <>
                    <span className="aw-hero__long">Talk to the hosts</span>
                    <span className="aw-hero__short">Call in</span>
                  </>
                }
              />
              {onAir && <IconButton icon={Square} label="Stop the station" size="lg" onClick={() => radio.stop()} />}
              <IconButton icon={Pencil} label="Edit station" size="lg" onClick={() => navigate(`/stations/${station.id}`)} />
            </div>
          </div>
        </section>
      )}

      <HomeList />

      {recent && recent.length > 0 && (
        <section className="aw-home__section">
          <SectionHeader
            title="Recently on air"
            subtitle="What your hosts just said."
            action={
              <Button variant="ghost" size="sm" onClick={() => navigate('/on-air')}>
                History
              </Button>
            }
          />
          <div className="aw-recent">
            {recent.map((b) => (
              <BreakCard key={b.id} brk={b} hosts={hosts} station={byStation.get(b.stationId)} compact onOpen={() => navigate(`/on-air?station=${b.stationId}`)} />
            ))}
          </div>
        </section>
      )}

      <section className="aw-home__section">
        <SectionHeader
          title="Your hosts"
          subtitle="They read the room, the weather and your day."
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate('/hosts')}>
              Show all
            </Button>
          }
        />
        <div className="aw-hostrow">
          {[...onMic, ...others].slice(0, 6).map((h) => (
            <Card key={h.id} padding="compact" className="aw-hostpill" onClick={() => navigate(`/hosts/${h.id}`)}>
              <Avatar avatar={h.avatar} name={h.name} size={48} speaking={h.id === r.speakingHostId} />
              <span className="aw-hostpill__text">
                <span className="aw-hostpill__name">{h.name}</span>
                <span className="aw-hostpill__tagline aw-truncate" style={{ display: 'block' }}>
                  {h.tagline}
                </span>
                <NoAiLine host={h} />
              </span>
              {station?.hostIds[0] === h.id && <Badge tone="warm">Lead</Badge>}
            </Card>
          ))}
        </div>
      </section>

      {station && (
        <section className="aw-home__section">
          <SectionHeader
            title="On the show"
            subtitle={`What ${onMic[0]?.name ?? 'your hosts'} can bring up between songs.`}
            action={
              <Button variant="ghost" size="sm" onClick={() => navigate(`/stations/${station.id}`)}>
                Edit
              </Button>
            }
          />
          <div className="aw-segments">
            {SEGMENT_META.filter((s) => station.segments[s.key]).map((s) => (
              <Chip key={s.key} icon={s.icon} onClick={() => navigate(`/stations/${station.id}`)}>
                {s.label}
              </Chip>
            ))}
          </div>
        </section>
      )}

      <JumpBackIn />
    </Page>
  );
}

function JumpBackIn() {
  const { tracks, playlists, ready } = useLibrary();
  const songs = useMemo(() => tracks.filter((t) => t.source !== 'stream'), [tracks]);
  const liked = useMemo(() => songs.filter((t) => t.liked), [songs]);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  if (!ready) return null;
  const lists = [...playlists].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, liked.length ? 5 : 6);
  return (
    <section className="aw-home__section">
      <SectionHeader
        title="Your music"
        subtitle={songs.length ? `${songs.length} song${songs.length === 1 ? '' : 's'} your hosts can play.` : undefined}
        action={
          songs.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => navigate('/library')}>
              Library
            </Button>
          )
        }
      />
      {songs.length === 0 ? (
        <EmptyState
          card
          size="compact"
          icon={ListMusic}
          title="No songs yet"
          description="Add music from this device, your own server or a streaming app, and your hosts take it from there."
          actions={
            <Button variant="primary" onClick={() => navigate('/library')}>
              Add music
            </Button>
          }
        />
      ) : (
        <div className="aw-tiles aw-home__tiles">
          {liked.length > 0 && <LikedCard tracks={liked} />}
          {lists.map((p) => (
            <PlaylistCard key={p.id} playlist={p} tracks={() => p.trackIds.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t))} />
          ))}
          {!lists.length && !liked.length && (
            <Card className="aw-home__lib" onClick={() => navigate('/library')}>
              <ListMusic aria-hidden />
              <span>
                <strong>Your library</strong>
                <span>{songs.length} songs · tap to browse</span>
              </span>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}
