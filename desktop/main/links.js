// hostcaster:// links: the account sign-in and Stripe hand back to the app with them (the same links as the phone
// apps), and the ChatGPT callback page links back with hostcaster://chatgpt. Windows and Linux pass a link as a
// command-line argument (first launch, or to the running app through the single-instance lock); macOS sends open-url.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LINK_SCHEME = 'hostcaster';
const MAX_LINK = 4096;

/** The hostcaster:// links in a command line (or any list of strings). */
export function linksIn(argv) {
  return (Array.isArray(argv) ? argv : []).filter((a) => typeof a === 'string' && a.length <= MAX_LINK && a.toLowerCase().startsWith(`${LINK_SCHEME}://`));
}

/**
 * Makes this app the handler of hostcaster:// links. Packaged builds only: a development or test run must not change
 * the computer's default handler. The Windows installer and the .deb register it too; an AppImage has no installer, so
 * it adds a hidden desktop entry for itself (and updates it when the AppImage moves).
 */
export function registerLinkHandler(app, log) {
  if (!app.isPackaged || process.env.HOSTCASTER_NO_PROTOCOL === '1') return false;
  if (process.platform === 'linux' && process.env.APPIMAGE) return registerAppImage(process.env.APPIMAGE, log);
  return app.setAsDefaultProtocolClient(LINK_SCHEME);
}

function registerAppImage(appImage, log) {
  try {
    const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'applications');
    const name = 'host-caster-links.desktop';
    const file = join(dir, name);
    const quoted = `"${appImage.replace(/(["`$\\])/g, '\\$1')}"`;
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Host-Caster',
      `Exec=${quoted} %u`,
      'NoDisplay=true',
      'Terminal=false',
      `MimeType=x-scheme-handler/${LINK_SCHEME};`,
      '',
    ].join('\n');
    const same = existsSync(file) && readFileSync(file, 'utf8') === entry;
    if (!same) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, entry, { mode: 0o644 });
    }
    execFile('xdg-mime', ['default', name, `x-scheme-handler/${LINK_SCHEME}`], { timeout: 5000 }, (err) => {
      if (err) log?.warn(`xdg-mime could not register ${LINK_SCHEME}:// (${err.code ?? err.message})`);
    });
    return true;
  } catch (err) {
    log?.warn(`could not register ${LINK_SCHEME}:// for the AppImage: ${err.message}`);
    return false;
  }
}
