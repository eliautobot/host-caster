// "A new version is ready": in the Android APK downloaded from the website (core/update/directUpdate.ts) and in the
// desktop app (its main process reads the site's desktop manifest, state/desktop.ts). Download opens the browser:
// Android's installer or the desktop installer puts the new version over this one, data kept. Nothing installs by itself.
import { useEffect, useId, useState } from 'react';
import { App } from '@capacitor/app';
import { Download } from 'lucide-react';
import { desktop, distribution, isNative, onAppResume, openExternal, platform } from '@/core/native';
import { checkForUpdate, snoozeUpdate, type ReleaseManifest, type UpdateDecision } from '@/core/update/directUpdate';
import { snoozeDesktopUpdate, useDesktop } from '@/state/desktop';
import { Button } from '../components';
import './UpdateNotice.css';

export const checksForUpdates = isNative && platform === 'android' && distribution === 'direct';

// the versionCode put away in this session ("Later", "Not now" or Download); kept outside the component because the
// shell mounts it again when the layout changes (sign-in screen to the app)
let putAwayCode = 0;

/** Mount once (AppShell). Renders nothing outside a direct Android build and the desktop app. */
export function UpdateNotice() {
  const [decision, setDecision] = useState<UpdateDecision>({ kind: 'none' });
  const [putAway, setPutAwayState] = useState(putAwayCode);
  const setPutAway = (code: number) => {
    putAwayCode = code;
    setPutAwayState(code);
  };
  const desktopUpdate = useDesktop((s) => s.update);

  useEffect(() => {
    if (!checksForUpdates) return;
    let live = true;
    let installed = 0;
    const run = async () => {
      try {
        if (!installed) installed = Number((await App.getInfo()).build) || 0;
        const d = await checkForUpdate({ installedCode: installed });
        if (live) setDecision(d);
      } catch {
        // quiet: the next launch or resume tries again
      }
    };
    // after the first screen is up, then whenever the app comes back (checkForUpdate asks the site every few hours)
    const first = setTimeout(() => void run(), 4000);
    const off = onAppResume(() => void run());
    return () => {
      live = false;
      clearTimeout(first);
      off();
    };
  }, []);

  if (desktop && desktopUpdate) {
    if (desktopUpdate.versionCode === putAway) return null;
    const bridge = desktop;
    return (
      <UpdateCard
        release={{ ...desktopUpdate, sha256: desktopUpdate.sha256 ?? '', minimumSupported: 0 }}
        required={desktopUpdate.required}
        hint="It opens the download page in your browser. Install it over this version: your stations, hosts and sign-in stay."
        onDownload={() => {
          void bridge.openUpdate();
          setPutAway(desktopUpdate.versionCode);
        }}
        onLater={() => {
          if (!desktopUpdate.required) void snoozeDesktopUpdate();
          setPutAway(desktopUpdate.versionCode);
        }}
      />
    );
  }
  if (decision.kind === 'none' || decision.release.versionCode === putAway) return null;
  return (
    <UpdateCard
      release={decision.release}
      required={decision.kind === 'required'}
      onDownload={() => {
        void openExternal(decision.release.url);
        setPutAway(decision.release.versionCode);
      }}
      onLater={() => {
        if (decision.kind === 'available') void snoozeUpdate(decision.release.versionCode);
        setPutAway(decision.release.versionCode);
      }}
    />
  );
}

export function UpdateCard({
  release,
  required,
  onDownload,
  onLater,
  hint = 'It opens in your browser. Install it over this app: your stations, hosts and settings stay.',
}: {
  release: ReleaseManifest;
  required: boolean;
  onDownload: () => void;
  onLater: () => void;
  hint?: string;
}) {
  const titleId = useId();
  return (
    <section className="aw-update" role="status" aria-labelledby={titleId} data-update-notice={required ? 'required' : 'available'}>
      <span className="aw-update__icon" aria-hidden>
        <Download />
      </span>
      <div className="aw-update__body">
        <h2 id={titleId} className="aw-update__title">
          {required ? 'Please update Host-Caster' : 'A new version is ready'}
        </h2>
        <p className="aw-update__text">
          {required
            ? `This version is no longer supported. Download Host-Caster ${release.version} to keep listening.`
            : `Host-Caster ${release.version} is ready to download.`}
        </p>
        {release.notes.length > 0 && (
          <ul className="aw-update__notes">
            {release.notes.slice(0, 3).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <p className="aw-update__hint">{hint}</p>
        <div className="aw-update__actions">
          <Button variant="primary" size="sm" icon={Download} onClick={onDownload}>
            Download
          </Button>
          <Button variant="ghost" size="sm" onClick={onLater}>
            {required ? 'Not now' : 'Later'}
          </Button>
        </div>
      </div>
    </section>
  );
}
