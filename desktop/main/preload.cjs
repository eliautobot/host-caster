// The page's only way into the desktop app (sandboxed preload, context isolation): window.hostcasterDesktop.
// No Node and no raw IPC reach the page; every call is a fixed channel the main process checks.
const { contextBridge, ipcRenderer } = require('electron');

const boot = ipcRenderer.sendSync('desktop:boot');

const listen = (channel) => (cb) => {
  const h = (_e, value) => cb(value);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

if (boot) {
  contextBridge.exposeInMainWorld(
    'hostcasterDesktop',
    Object.freeze({
      version: boot.version,
      platform: boot.platform,
      arch: boot.arch,
      defaultServer: boot.defaultServer,
      site: boot.site,
      helper: Object.freeze({ url: boot.helper.url, token: boot.helper.token }),
      openExternal: (url) => ipcRenderer.invoke('desktop:open-external', String(url)),
      launchLinks: () => ipcRenderer.invoke('desktop:launch-links'),
      onDeepLink: listen('desktop:deeplink'),
      windowState: () => ipcRenderer.invoke('desktop:window-state'),
      onWindowState: listen('desktop:window-state'),
      getSettings: () => ipcRenderer.invoke('desktop:settings'),
      setSettings: (patch) => ipcRenderer.invoke('desktop:settings-set', patch),
      onSettings: listen('desktop:settings'),
      checkForUpdate: () => ipcRenderer.invoke('desktop:update-check'),
      lastUpdate: () => ipcRenderer.invoke('desktop:update-last'),
      snoozeUpdate: () => ipcRenderer.invoke('desktop:update-snooze'),
      openUpdate: () => ipcRenderer.invoke('desktop:update-open'),
      onUpdate: listen('desktop:update'),
    }),
  );
}
