import { Heart, Library, ListMusic, Radio, Server, Smartphone } from 'lucide-react';
import { api } from '@/core/api';
import { anyApp } from '@/core/native';
import type { StationSource, StationSourceKind } from '@/core/types';
import { useLibrary } from '@/state/library';
import { Toggle, cx } from '../../components';
import '../station/station.css';

const PLAYLIST_KINDS: StationSourceKind[] = ['playlist', 'spotify-playlist', 'youtube-playlist'];

function playlistKind(source: string): StationSourceKind {
  return source === 'spotify' ? 'spotify-playlist' : source === 'youtube' ? 'youtube-playlist' : 'playlist';
}

/** Where the station's music comes from. A stream or "any music app" is the whole station on its own. */
export function StationSources({ sources, onChange }: { sources: StationSource[]; onChange: (s: StationSource[]) => void }) {
  const { tracks, playlists } = useLibrary();
  const songs = tracks.filter((t) => t.source !== 'stream');
  const streams = tracks.filter((t) => t.source === 'stream');
  const has = (kind: StationSourceKind, ref?: string) => sources.some((s) => s.kind === kind && (ref === undefined || s.ref === ref));
  const exclusive = sources.find((s) => s.kind === 'stream' || s.kind === 'anyapp');
  const toggle = (src: StationSource, on: boolean) => {
    const rest = sources.filter((s) => !(s.kind === src.kind && s.ref === src.ref) && s.kind !== 'stream' && s.kind !== 'anyapp');
    if (src.kind === 'stream' || src.kind === 'anyapp') onChange(on ? [src] : rest.length ? rest : [{ kind: 'library' }]);
    else onChange(on ? [...rest, src] : rest);
  };
  const serverCount = songs.filter((t) => t.source === 'server').length;

  const Row = ({ icon: Icon, title, meta, src, disabled }: { icon: typeof Library; title: string; meta: string; src: StationSource; disabled?: boolean }) => (
    <div className={cx('aw-entry', disabled && 'aw-entry--disabled')}>
      <span className="aw-preset__icon">
        <Icon aria-hidden />
      </span>
      <div className="aw-entry__text">
        <p className="aw-entry__title">{title}</p>
        <p className="aw-entry__meta">{meta}</p>
      </div>
      <Toggle aria-label={title} checked={has(src.kind, src.ref)} disabled={disabled} onChange={(on) => toggle(src, on)} />
    </div>
  );

  return (
    <div className="aw-entries">
      <Row icon={Library} title="Your whole library" meta={`${songs.length} songs`} src={{ kind: 'library' }} />
      <Row icon={Heart} title="Liked songs" meta={`${songs.filter((t) => t.liked).length} songs`} src={{ kind: 'liked' }} />
      {(serverCount > 0 || api.available) && <Row icon={Server} title="Server library" meta={serverCount ? `${serverCount} songs` : 'Songs on your Host-Caster server'} src={{ kind: 'server' }} />}
      {playlists.map((p) => (
        <Row key={p.id} icon={ListMusic} title={p.name} meta={`Playlist · ${p.trackIds.length} songs${p.source !== 'local' ? ` · ${p.source}` : ''}`} src={{ kind: playlistKind(p.source), ref: p.id }} />
      ))}
      {streams.slice(0, 12).map((t) => (
        <Row key={t.id} icon={Radio} title={t.title} meta="Internet radio · plays on its own, hosts break in on a timer" src={{ kind: 'stream', ref: t.id }} />
      ))}
      <Row
        icon={Smartphone}
        title="Any music app"
        meta={anyApp.available ? 'Spotify, YouTube Music or any player on this phone; hosts talk between its songs' : 'Android app only: hosts talk over the music app you already use'}
        src={{ kind: 'anyapp' }}
        disabled={!anyApp.available && !has('anyapp')}
      />
      {exclusive && <p className="aw-field__hint">{exclusive.kind === 'stream' ? 'A radio stream plays on its own, so other sources are off.' : 'The music comes from another app, so other sources are off.'}</p>}
      {!sources.length && <p className="aw-statusline aw-statusline--error">Pick at least one source.</p>}
      {sources.some((s) => PLAYLIST_KINDS.includes(s.kind) && !playlists.some((p) => p.id === s.ref)) && (
        <p className="aw-field__hint">A playlist on this station was deleted; it is skipped.</p>
      )}
    </div>
  );
}
