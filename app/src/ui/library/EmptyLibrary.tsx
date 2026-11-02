// First-run library: invites you to bring your music in.
import { FileMusic, FolderOpen, FolderSearch, ListMusic, Plug, Radio, Server } from 'lucide-react';
import { serverLibraryAvailable } from '@/core/library';
import { devicePlatform } from '@/core/library/device';
import { navigate } from '@/state/router';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { dialogs } from './dialogs';
import { syncServer, type usePickers } from './importUi';

export function EmptyLibrary({ pickers }: { pickers: ReturnType<typeof usePickers> }) {
  const desktop = useIsDesktop();
  const server = serverLibraryAvailable();
  const device = devicePlatform();
  const options = [
    { icon: FileMusic, title: 'Songs from this device', desc: 'MP3, M4A, FLAC, OGG, WAV', onClick: pickers.pickFiles, primary: true },
    ...(device === 'android'
      ? [{ icon: FolderSearch, title: 'Music on this phone', desc: 'Finds the songs already here', onClick: dialogs.deviceMusic }]
      : device
        ? [{ icon: FolderSearch, title: 'Your music folder', desc: 'Plays from where it is, kept up to date', onClick: dialogs.deviceMusic }]
        : []),
    ...(pickers.canPickFolder ? [{ icon: FolderOpen, title: 'A whole folder', desc: 'Keeps albums and playlists', onClick: pickers.pickFolder }] : []),
    { icon: Plug, title: 'Music services', desc: 'Spotify, YouTube Music, Subsonic', onClick: () => navigate('/settings/music-services') },
    { icon: Radio, title: 'Internet radio', desc: 'Any stream address', onClick: dialogs.addStream },
    { icon: ListMusic, title: 'A playlist file', desc: 'M3U, M3U8 or PLS', onClick: pickers.pickPlaylist },
    ...(server ? [{ icon: Server, title: 'Your music server', desc: 'Songs on your Host-Caster server', onClick: () => void syncServer() }] : []),
  ];
  return (
    <section className="aw-emptylib" aria-labelledby="emptylib-title">
      <div className="aw-emptylib__art" aria-hidden>
        <span className="aw-emptylib__ring aw-emptylib__ring--3" />
        <span className="aw-emptylib__ring aw-emptylib__ring--2" />
        <span className="aw-emptylib__ring aw-emptylib__ring--1" />
        <span className="aw-emptylib__disc">
          <span className="aw-emptylib__label" />
        </span>
        <span className="aw-emptylib__dot" />
      </div>
      <h2 id="emptylib-title" className="aw-emptylib__title">
        Bring your music
      </h2>
      <p className="aw-emptylib__desc">
        Your songs stay on this device and play offline. Your hosts will talk about them between tracks.
      </p>
      <div className="aw-emptylib__options">
        {options.map((o) => (
          <button key={o.title} type="button" className={`aw-emptylib__opt${o.primary ? ' is-primary' : ''}`} onClick={o.onClick}>
            <span className="aw-emptylib__opt-icon">
              <o.icon aria-hidden />
            </span>
            <span className="aw-emptylib__opt-text">
              <span className="aw-emptylib__opt-title">{o.title}</span>
              <span className="aw-emptylib__opt-desc">{o.desc}</span>
            </span>
          </button>
        ))}
      </div>
      {desktop && <p className="aw-emptylib__hint">or drop files and folders anywhere in this window</p>}
    </section>
  );
}
