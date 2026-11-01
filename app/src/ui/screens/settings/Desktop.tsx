import { useEffect, useState } from 'react';
import { Download, HardDrive, KeyRound, Monitor, RefreshCw } from 'lucide-react';
import { desktop, desktopOsName, helperFetch } from '@/core/native';
import { checkForDesktopUpdate, setDesktopSettings, snoozeDesktopUpdate, useDesktop } from '@/state/desktop';
import { navigate } from '@/state/router';
import { Button, Toggle, toast } from '../../components';
import { ChatGPTMark } from '../../radio/settings/chatgpt/ChatGPTMark';
import { Actions, formatBytes, Hint, SectionCard } from './account/parts';
import './account/account.css';
import './Desktop.css';

const KEYCHAIN: Record<string, string> = {
  keychain: 'the macOS Keychain',
  dpapi: 'Windows (DPAPI)',
  gnome_libsecret: 'your keyring (Secret Service)',
  kwallet: 'KWallet',
  kwallet5: 'KWallet',
  kwallet6: 'KWallet',
};

/** Is the local helper answering (127.0.0.1, this launch's secret)? */
function useHelperUp(): boolean | undefined {
  const [up, setUp] = useState<boolean>();
  useEffect(() => {
    let alive = true;
    void helperFetch('/health')
      .then((r) => alive && setUp(r.ok))
      .catch(() => alive && setUp(false));
    return () => {
      alive = false;
    };
  }, []);
  return up;
}

/** Settings -> Desktop app (desktop app only): updates, the ChatGPT plan on this computer, local AI. */
export default function DesktopSettings() {
  const settings = useDesktop((s) => s.settings);
  const update = useDesktop((s) => s.update);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string>();
  const helperUp = useHelperUp();
  if (!desktop) return null;
  const os = desktopOsName();
  const keychain = settings?.keychain;
  const keychainName = keychain ? (KEYCHAIN[keychain.backend] ?? 'this computer') : 'this computer';

  const check = async () => {
    setChecking(true);
    setNote(undefined);
    const res = await checkForDesktopUpdate().catch(() => undefined);
    setChecking(false);
    if (!res?.checked) setNote(res?.error ?? 'Could not check for updates right now.');
    else if (!res.update) setNote(`You have the latest version (${desktop?.version}).`);
  };

  const setPlan = async (on: boolean) => {
    await setDesktopSettings({ chatgptPlan: on });
    toast(on ? { tone: 'success', title: 'ChatGPT plan is on', description: 'Add it in Settings, Brains: Use your ChatGPT plan.' } : { title: 'ChatGPT plan is off' });
  };

  return (
    <div className="aw-desktop-settings">
      <SectionCard
        icon={Monitor}
        tone="warm"
        title={`Host-Caster for ${os}`}
        status={`Version ${desktop.version}. Your account, stations and hosts sync with Host-Caster on the web and your phone.`}
        badge={update ? { label: update.required ? 'Update needed' : 'Update ready', tone: 'warm', dot: true } : undefined}
      >
        {update ? (
          <>
            <p className="aw-acct-card__status">
              Host-Caster {update.version} is ready{update.size ? ` (${formatBytes(update.size)})` : ''}. Download opens the download page
              in your browser; install it over this version and your stations and sign-in stay.
            </p>
            {update.notes.length > 0 && (
              <ul className="aw-desktop-settings__notes">
                {update.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <Actions>
              <Button variant="primary" icon={Download} onClick={() => void desktop?.openUpdate()}>
                Download
              </Button>
              {!update.required && <Button onClick={() => void snoozeDesktopUpdate()}>Later</Button>}
            </Actions>
          </>
        ) : (
          <Actions>
            <Button icon={RefreshCw} loading={checking} onClick={() => void check()}>
              Check for updates
            </Button>
          </Actions>
        )}
        {note && <Hint>{note}</Hint>}
        <Toggle
          label="Look for updates by itself"
          description="At start and every few hours. Host-Caster tells you; it never installs anything on its own."
          checked={settings?.checkUpdates ?? true}
          onChange={(checkUpdates) => void setDesktopSettings({ checkUpdates })}
        />
      </SectionCard>

      <SectionCard
        icon={KeyRound}
        tone="neutral"
        title={
          <span className="aw-desktop-settings__cgpt">
            <ChatGPTMark /> Use your ChatGPT plan
          </span>
        }
        status="Let your hosts think with your own ChatGPT plan instead of an API key. Only in the desktop app."
        badge={settings?.chatgptPlan ? { label: 'On', tone: 'ok', dot: true } : { label: 'Off', tone: 'neutral' }}
      >
        <Toggle
          label="ChatGPT plan brains on this computer"
          description={`The ChatGPT sign-in stays on this computer, locked by ${keychainName}. Host-Caster's servers never see it.`}
          checked={settings?.chatgptPlan ?? false}
          onChange={(on) => void setPlan(on)}
        />
        <Hint>
          Off unless you turn it on. OpenAI lets open-source apps that run on your own computer use Sign in with ChatGPT and
          asks paid apps to apply first. Until OpenAI confirms that Host-Caster may offer it, this stays your choice.
        </Hint>
        {keychain?.weak && (
          <Hint>
            This computer has no keyring, so the ChatGPT sign-in would be kept with basic protection only. Install and unlock a
            keyring (GNOME Keyring or KWallet) for full protection.
          </Hint>
        )}
        {settings?.chatgptPlan && (
          <Actions>
            <Button onClick={() => navigate('/settings/brains')}>Open Brains</Button>
          </Actions>
        )}
      </SectionCard>

      <SectionCard
        icon={HardDrive}
        tone="ok"
        title="AI on this computer or your network"
        status="Ollama, LM Studio, Kokoro and other models and voices on this computer or your home network work here, without the browser's limits."
        badge={helperUp === undefined ? undefined : helperUp ? { label: 'Ready', tone: 'ok', dot: true } : { label: 'Not running', tone: 'danger' }}
      >
        <Hint>Add them in Brains and Voices with their address (for example http://localhost:11434 for Ollama). They work while this computer can reach them.</Hint>
        <Actions>
          <Button onClick={() => navigate('/settings/brains')}>Brains</Button>
          <Button onClick={() => navigate('/settings/voices')}>Voices</Button>
        </Actions>
      </SectionCard>
    </div>
  );
}
