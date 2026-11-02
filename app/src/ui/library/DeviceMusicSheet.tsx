// Find music on this device (Android) / Add a music folder (desktop app, Chrome and Edge): explain, ask, look, show
// what was found per folder with switches, add the songs where they are, keep them up to date. Opt-in; the core is
// core/library/device.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Folder, FolderPlus, Music2, RefreshCw, Settings2, Smartphone, X } from 'lucide-react';
import { deviceMusic, type DeviceMusicState } from '@/core/library/device';
import { onForeground } from '@/core/native/links';
import { Button, IconButton, Sheet, Toggle, toast } from '../components';
import { dialogs } from './dialogs';
import './deviceMusic.css';

export function useDeviceMusic(): DeviceMusicState {
  return useSyncExternalStore(
    (cb) => deviceMusic.on('change', cb),
    () => deviceMusic.state,
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The menu label for this platform (undefined: not available here). */
export function deviceMusicLabel(platform: DeviceMusicState['platform']): string | undefined {
  if (platform === 'android') return 'Find music on this device';
  if (platform === 'desktop' || platform === 'web') return 'Add a music folder';
  return undefined;
}

export function DeviceMusicSheet({ open }: { open: boolean }) {
  const s = useDeviceMusic();
  const [asked, setAsked] = useState(false);
  const phone = s.platform === 'android';
  const folders = s.platform === 'desktop' || s.platform === 'web';

  // opening: access and folders again, then a fresh look when it is allowed
  useEffect(() => {
    if (!open) return;
    setAsked(false);
    void (async () => {
      await deviceMusic.load();
      await deviceMusic.refresh();
      if (deviceMusic.state.access === 'granted') await deviceMusic.look();
    })();
    // back from the system settings: allowed now?
    return onForeground(() => {
      const was = deviceMusic.state.access;
      void (async () => {
        await deviceMusic.refresh();
        if (was !== 'granted' && deviceMusic.state.access === 'granted') await deviceMusic.look();
      })();
    });
  }, [open]);

  const allow = async () => {
    const access = await deviceMusic.requestAccess();
    setAsked(true); // after the system dialog: "No problem" only once the answer is in
    if (access === 'granted') await deviceMusic.look();
  };
  const addFolder = async (path?: string) => {
    const root = await deviceMusic.addRoot(path);
    if (root) await deviceMusic.look();
  };
  const add = async () => {
    const r = await deviceMusic.sync();
    if (!r) return;
    dialogs.close();
    const bits = [
      r.skipped && `${r.skipped} skipped (already in your library or too short)`,
      r.removed && `${r.removed} removed`,
      r.updated && `${r.updated} updated`,
    ]
      .filter(Boolean)
      .join(' · ');
    if (r.added) toast.success(`Added ${plural(r.added, 'song')}`, bits || 'They play from where they are on this device.');
    else toast({ title: 'Your library is up to date', description: bits || undefined });
  };
  const turnOff = () =>
    dialogs.confirm({
      title: 'Remove device music from your library?',
      description: 'The songs stay on this device. Playlists lose them. You can add them again any time.',
      confirm: 'Remove',
      danger: true,
      onConfirm: async () => {
        const n = await deviceMusic.turnOff();
        toast({ title: `Removed ${plural(n, 'song')} from your library`, description: 'The files are still on this device.' });
      },
    });

  const title = phone ? 'Find music on this device' : 'Music folders';
  const busy = s.phase === 'scanning' || s.phase === 'adding';
  const plan = s.plan;
  const granted = s.access === 'granted';
  const toAdd = plan?.add.length ?? 0;
  const changes = toAdd + (plan?.remove.length ?? 0) + (plan?.update.length ?? 0);
  const showResults = granted && plan && !busy;

  let body: ReactNode;
  let footer: ReactNode;
  if (s.phase === 'adding') {
    const p = s.progress;
    const pct = p?.total ? Math.round((p.done / p.total) * 100) : 0;
    body = (
      <div className="aw-devmusic__busy" role="status" aria-live="polite">
        <p className="aw-devmusic__busy-title">{p?.total ? `Adding ${Math.min(p.done + 1, p.total)} of ${p.total}` : 'Updating your library'}</p>
        <div className="aw-import__bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  } else if (s.phase === 'scanning') {
    body = (
      <div className="aw-devmusic__busy" role="status" aria-live="polite">
        <RefreshCw className="aw-devmusic__spin" aria-hidden />
        <p className="aw-devmusic__busy-title">Looking for music…</p>
      </div>
    );
  } else if (phone && !granted) {
    body = <PhoneAccess access={s.access} asked={asked} />;
    footer =
      s.access === 'blocked' ? (
        <>
          <Button variant="ghost" onClick={dialogs.close}>
            Not now
          </Button>
          <Button variant="primary" icon={Settings2} onClick={() => void deviceMusic.openSettings()}>
            Open settings
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={dialogs.close}>
            Not now
          </Button>
          <Button variant="primary" icon={Music2} onClick={() => void allow()}>
            {asked ? 'Try again' : 'Look for music'}
          </Button>
        </>
      );
  } else if (folders && !s.roots.length) {
    body = <FolderIntro suggested={s.suggested} web={s.platform === 'web'} />;
    footer = (
      <>
        {s.suggested ? (
          <>
            <Button variant="ghost" icon={FolderPlus} onClick={() => void addFolder()}>
              Choose another folder
            </Button>
            <Button variant="primary" icon={Folder} onClick={() => void addFolder(s.suggested)}>
              Use my Music folder
            </Button>
          </>
        ) : (
          <Button variant="primary" icon={FolderPlus} onClick={() => void addFolder()}>
            Choose a folder
          </Button>
        )}
      </>
    );
  } else if (folders && !granted) {
    // the browser forgot the permission after a restart: one tap gives it back
    body = (
      <div className="aw-devmusic__intro">
        <p>Your browser asks again for access to your music folder after it restarts.</p>
        <p className="aw-devmusic__muted">Choose “Allow on every visit” and it will not ask again.</p>
        <Roots roots={s.roots} />
      </div>
    );
    footer = (
      <Button variant="primary" icon={Folder} onClick={() => void allow()}>
        Allow access
      </Button>
    );
  } else {
    body = (
      <>
        {folders && <Roots roots={s.roots} onAdd={() => void addFolder()} />}
        {showResults && <Results s={s} />}
        {s.phase === 'error' && <p className="aw-devmusic__error">{s.error}</p>}
      </>
    );
    footer = showResults ? (
      <>
        {s.settings.enabled ? (
          <Button variant="ghost" onClick={turnOff}>
            Remove from library
          </Button>
        ) : (
          <Button variant="ghost" onClick={dialogs.close}>
            Cancel
          </Button>
        )}
        <Button variant="primary" disabled={!s.settings.enabled && !toAdd} onClick={() => (changes || !s.settings.enabled ? void add() : dialogs.close())}>
          {s.settings.enabled ? (changes ? 'Update library' : 'Done') : toAdd ? `Add ${plural(toAdd, 'song')}` : 'Nothing to add'}
        </Button>
      </>
    ) : undefined;
  }

  return (
    <Sheet open={open} onClose={dialogs.close} size="md" title={title} footer={footer} className="aw-devmusic">
      {body}
    </Sheet>
  );
}

function PhoneAccess({ access, asked }: { access: DeviceMusicState['access']; asked: boolean }) {
  if (access === 'blocked') {
    return (
      <div className="aw-devmusic__intro">
        <p>Music access is turned off for Host-Caster.</p>
        <p className="aw-devmusic__muted">To look for music, open Settings, then Permissions, then Music and audio, and choose Allow.</p>
        <p className="aw-devmusic__muted">You can still add songs one at a time with Add songs.</p>
      </div>
    );
  }
  // the answer to this visit's ask; a permission taken back earlier (or by Android) starts from the intro again
  if (asked && access !== 'granted') {
    return (
      <div className="aw-devmusic__intro">
        <p>No problem. Host-Caster did not look at anything.</p>
        <p className="aw-devmusic__muted">You can still add songs one at a time with Add songs, or try again and choose Allow.</p>
      </div>
    );
  }
  return (
    <div className="aw-devmusic__intro">
      <span className="aw-devmusic__badge" aria-hidden>
        <Smartphone />
      </span>
      <p>Host-Caster can look for the songs already on your phone and add them to your library. Android will ask you to allow access to music and audio.</p>
      <ul className="aw-devmusic__points">
        <li>Only music: no ringtones, recordings or voice notes.</li>
        <li>Your songs stay where they are. Nothing is copied or uploaded.</li>
        <li>You choose which folders to add.</li>
      </ul>
    </div>
  );
}

function FolderIntro({ suggested, web }: { suggested?: string; web: boolean }) {
  return (
    <div className="aw-devmusic__intro">
      <span className="aw-devmusic__badge" aria-hidden>
        <Folder />
      </span>
      <p>Add the folder where you keep your music. Host-Caster plays the songs from there and keeps your library up to date when you add or delete songs.</p>
      <ul className="aw-devmusic__points">
        <li>Nothing is copied or uploaded.</li>
        <li>Only music files are added.</li>
        {web && <li>Your browser asks once for access to the folder.</li>}
      </ul>
      {suggested && <p className="aw-devmusic__path">{suggested}</p>}
    </div>
  );
}

function Roots({ roots, onAdd }: { roots: DeviceMusicState['roots']; onAdd?: () => void }) {
  return (
    <div className="aw-devmusic__roots">
      {roots.map((r) => (
        <div key={r.id} className="aw-devmusic__root">
          <Folder aria-hidden />
          <span className="aw-devmusic__root-path aw-truncate" title={r.label}>
            {r.label}
          </span>
          {onAdd && <IconButton icon={X} size="sm" label={`Stop using ${r.label}`} onClick={() => void deviceMusic.removeRoot(r.id)} />}
        </div>
      ))}
      {onAdd && (
        <Button variant="ghost" size="sm" icon={FolderPlus} onClick={onAdd}>
          Add another folder
        </Button>
      )}
    </div>
  );
}

function Results({ s }: { s: DeviceMusicState }) {
  const plan = s.plan!;
  const songs = plan.folders.reduce((n, f) => n + f.count, 0);
  if (!songs) {
    return (
      <div className="aw-devmusic__intro">
        <p>No music found{s.platform === 'android' ? ' on this device' : ' in this folder'}.</p>
        <p className="aw-devmusic__muted">Songs you download or copy {s.platform === 'android' ? 'to your phone' : 'here'} show up the next time Host-Caster looks.</p>
      </div>
    );
  }
  const name = (key: string) => key.split('/').pop() || key || 'Top folder';
  return (
    <>
      <p className="aw-devmusic__summary">
        Found {plural(songs, 'song')} in {plural(plan.folders.length, 'folder')}
        {plan.duplicates > 0 && <span className="aw-devmusic__muted"> · {plural(plan.duplicates, 'song')} already in your library</span>}
      </p>
      <div className="aw-devmusic__folders" role="list">
        {plan.folders.map((f) => (
          <div key={f.key} className="aw-devmusic__folder" role="listitem">
            <Toggle
              checked={f.included}
              onChange={(on) => void deviceMusic.setFolder(f.key, on)}
              label={name(f.key)}
              description={`${plural(f.count, 'song')} · ${f.key || 'Top folder'}`}
            />
          </div>
        ))}
      </div>
      <div className="aw-devmusic__option">
        <Toggle
          checked={s.settings.autoUpdate}
          onChange={(on) => void deviceMusic.saveSettings({ autoUpdate: on })}
          label="Keep my music up to date"
          description="When you open Host-Caster, new songs are added and deleted ones are removed."
        />
      </div>
      <p className="aw-devmusic__note">These songs play only on this device. They are not uploaded and do not sync to your other devices.</p>
    </>
  );
}
