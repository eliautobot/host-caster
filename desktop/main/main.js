// Host-Caster for Windows, Mac and Linux (Electron main process). The window shows the same app as app.host-caster.com,
// bundled inside (app://host-caster); the account, sync, plans and Host-Caster AI come from the online server like on
// the phones; the local helper (helper/server.js, 127.0.0.1 only) adds what only a PC can do: "Use your ChatGPT plan"
// with the tokens kept here, and brains and voices on this PC or the home network (Ollama, LM Studio, Kokoro).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } from 'electron';
import { APP_ORIGIN, handleAppProtocol, registerAppScheme } from './appProtocol.js';
import { startHelper } from './helper/server.js';
import { createDeviceMusic } from './deviceMusic.js';
import { createKeychain } from './keychain.js';
import { linksIn, registerLinkHandler } from './links.js';
import { createSettings } from './settings.js';
import { autoUpdaterHook, createUpdates } from './updates.js';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

// build-time defaults (scripts/stage.mjs): a fork can point its build at its own server and site
const built = (() => {
  try {
    return JSON.parse(readFileSync(join(here, 'build-config.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const trim = (s) => String(s ?? '').trim().replace(/\/+$/, '');
const SERVER = trim(env.HOSTCASTER_SERVER ?? built.server ?? 'https://app.host-caster.com');
const SITE = trim(env.HOSTCASTER_SITE ?? built.site ?? 'https://host-caster.com');
const UPDATE_URL = env.HOSTCASTER_UPDATE_URL ?? built.updateUrl ?? `${SITE}/download/desktop/latest.json`;

if (env.HOSTCASTER_USER_DATA) app.setPath('userData', env.HOSTCASTER_USER_DATA);
// tests and keyring-less setups: Chromium's own key store ('basic'), so a test run never writes to the real keyring
if (env.HOSTCASTER_PASSWORD_STORE) app.commandLine.appendSwitch('password-store', env.HOSTCASTER_PASSWORD_STORE);
registerAppScheme();

// ---- log (no tokens, no personal data: codes and statuses only) ----------------------------------------------------
const logFile = join(app.getPath('userData'), 'logs', 'desktop.log');
function write(level, args) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    if (existsSync(logFile) && statSync(logFile).size > 1_000_000) truncateSync(logFile, 0);
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    appendFileSync(logFile, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {
    // logging must never stop the app
  }
}
const log = { info: (...a) => write('info', a), warn: (...a) => write('warn', a), error: (...a) => write('error', a) };

// ---- one app at a time; hostcaster:// links ------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
const pendingLinks = linksIn(process.argv);
let rendererReady = false;
let win;
let helper;
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function deliverLink(url) {
  log.info(`link ${url.split('?')[0]}`);
  showWindow();
  if (rendererReady && win) win.webContents.send('desktop:deeplink', url);
  else pendingLinks.push(url);
}

app.on('second-instance', (_e, argv) => {
  const links = linksIn(argv);
  if (links.length) for (const l of links) deliverLink(l);
  else showWindow();
});
app.on('will-finish-launching', () => {
  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (linksIn([url]).length) deliverLink(url);
  });
});

// ---- settings, keychain, updates -------------------------------------------------------------------------------------
const settings = createSettings(join(app.getPath('userData'), 'desktop-settings.json'));
const musicDir = () => {
  try {
    return app.getPath('music');
  } catch {
    return null;
  }
};
// music folders: HOSTCASTER_MUSIC_PICK answers the folder picker in tests (no system dialog)
const deviceMusic = createDeviceMusic(join(app.getPath('userData'), 'music-folders.json'), {
  musicDir,
  pickFolder: async () => {
    if (env.HOSTCASTER_MUSIC_PICK) return env.HOSTCASTER_MUSIC_PICK;
    const r = await dialog.showOpenDialog(win, { title: 'Add a music folder', defaultPath: musicDir() ?? undefined, properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
});
const keychain = createKeychain();
const updates = createUpdates({
  manifestUrl: UPDATE_URL,
  version: app.getVersion(),
  fetch: (url, init) => net.fetch(url, init),
  settings,
  log,
  onUpdate: (u) => win?.webContents.send('desktop:update', u ?? null),
});

/** Only web pages and mail open outside the app. */
function openExternal(url) {
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return false;
    void shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
}

const windowState = () => ({
  visible: Boolean(win && win.isVisible() && !win.isMinimized()),
  minimized: Boolean(win?.isMinimized()),
  focused: Boolean(win?.isFocused()),
});

// ---- the window ------------------------------------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    show: false,
    title: 'Host-Caster',
    backgroundColor: '#0a0a0b',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' && existsSync(join(here, 'icon.png')) ? { icon: join(here, 'icon.png') } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      // the radio keeps preparing breaks and playing while minimized; the YouTube rule uses the window events below
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => {
    if (env.HOSTCASTER_START_HIDDEN !== '1') win.show();
  });
  // each event says what it means: on some window managers isMinimized()/isVisible() catch up a moment later
  const push = (over) => win?.webContents.send('desktop:window-state', { ...windowState(), ...over });
  win.on('minimize', () => push({ visible: false, minimized: true }));
  win.on('hide', () => push({ visible: false }));
  win.on('restore', () => push({ visible: true, minimized: false }));
  win.on('show', () => push({ visible: !win.isMinimized() }));
  win.on('focus', () => push({ focused: true }));
  win.on('blur', () => push({ focused: false }));
  win.on('close', (e) => {
    // macOS: closing the window keeps the app (and the music) going, like Music; Quit ends it
    if (process.platform === 'darwin' && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = undefined;
    rendererReady = false;
  });
  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) {
      e.preventDefault();
      openExternal(url);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('render-process-gone', (_e, d) => log.error(`renderer gone: ${d.reason}`));
  void win.loadURL(`${APP_ORIGIN}/`);
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Host-Caster website', click: () => openExternal(SITE) },
        { label: 'Get help', click: () => openExternal(`${SITE}/support`) },
        { label: 'Check for updates', click: () => void updates.check({ manual: true }).then(() => showWindow()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- bridge to the page (preload.cjs) ----------------------------------------------------------------------------------
const fromApp = (e) => {
  const url = e.senderFrame?.url ?? '';
  return url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
};
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('not allowed');
    return fn(...args);
  });
}

function bridge() {
  ipcMain.on('desktop:boot', (e) => {
    e.returnValue = fromApp(e)
      ? {
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          defaultServer: SERVER,
          site: SITE,
          helper: { url: helper.url, token: helper.token },
        }
      : null;
  });
  handle('desktop:open-external', (url) => openExternal(url));
  handle('desktop:launch-links', () => {
    rendererReady = true;
    return pendingLinks.splice(0);
  });
  handle('desktop:window-state', () => windowState());
  handle('desktop:settings', () => ({ ...settings.get(), keychain: keychain.info() }));
  handle('desktop:settings-set', (patch) => ({ ...settings.set(patch), keychain: keychain.info() }));
  handle('desktop:update-check', () => updates.check({ manual: true }));
  handle('desktop:update-last', () => updates.last ?? null);
  handle('desktop:update-snooze', () => updates.snooze());
  handle('desktop:music-folders', () => deviceMusic.folders());
  handle('desktop:music-suggested', () => deviceMusic.suggested());
  handle('desktop:music-add', (path) => deviceMusic.addFolder(typeof path === 'string' ? path : undefined));
  handle('desktop:music-remove', (id) => deviceMusic.removeFolder(String(id)));
  handle('desktop:music-scan', () => deviceMusic.scan());
  // the download page (the file for each system and how to open an unsigned build the first time); the file itself
  // only when the manifest names no page
  handle('desktop:update-open', () => {
    const u = updates.last;
    return u ? openExternal(u.page ?? u.url) : false;
  });
  settings.onChange((s) => win?.webContents.send('desktop:settings', { ...s, keychain: keychain.info() }));
}

/**
 * YouTube's embedded player must know which app it plays in, through the HTTP Referer (YouTube API Services, Required
 * Minimum Functionality, "API Client Identity": desktop apps add the header themselves). Pages on app:// send none, so
 * the player would refuse with error 153. The app is identified by its app id as a URL.
 */
export const YOUTUBE_REFERER = 'https://com.hostcaster.app/';

function guardSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/embed/*', 'https://www.youtube-nocookie.com/embed/*'] }, (d, cb) => {
    const headers = { ...d.requestHeaders };
    if (!headers.Referer && !headers.referer) headers.Referer = YOUTUBE_REFERER;
    cb({ requestHeaders: headers });
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.hostcaster.app');
  const appDir = env.HOSTCASTER_APP_DIR ?? join(app.getAppPath(), 'app-dist');
  handleAppProtocol(appDir, deviceMusic);
  guardSession();
  helper = await startHelper({
    dataDir: app.getPath('userData'),
    keychain,
    keychainInfo: () => keychain.info(),
    chatgptEnabled: () => settings.get().chatgptPlan,
    appOrigin: APP_ORIGIN,
    version: app.getVersion(),
    log,
    chatgpt: {
      ...(env.HOSTCASTER_CHATGPT_ISSUER ? { issuer: env.HOSTCASTER_CHATGPT_ISSUER } : {}),
      ...(env.HOSTCASTER_CHATGPT_API_BASE ? { apiBase: env.HOSTCASTER_CHATGPT_API_BASE } : {}),
      ...(env.HOSTCASTER_CHATGPT_CALLBACK_PORT ? { callbackPort: Number(env.HOSTCASTER_CHATGPT_CALLBACK_PORT) } : {}),
    },
  });
  bridge();
  buildMenu();
  registerLinkHandler(app, log);
  createWindow();
  if (!(await autoUpdaterHook(log))) updates.start();
  log.info(`started ${app.getVersion()} server=${SERVER}`);
});

app.on('activate', () => {
  if (win) showWindow();
  else if (app.isReady()) createWindow();
});
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  updates.stop();
  void helper?.close();
});
