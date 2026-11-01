// electron-builder settings for Host-Caster desktop. The app folder is .build/stage (scripts/stage.mjs).
//   Linux:   AppImage + .deb   (npm run dist:linux, here or CI)
//   Windows: NSIS installer + portable zip (npm run dist:win; on Linux without Wine the .exe keeps Electron's icon and
//                               version info: CI on windows-latest sets HOSTCASTER_EDIT_EXE=1)
//   macOS:   universal .dmg    (npm run dist:mac on a Mac / the macos runner)
// Unsigned unless signing secrets are present (CSC_LINK + CSC_KEY_PASSWORD for Windows and macOS, APPLE_ID +
// APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID for notarization). See docs/DESKTOP.md.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const electronVersion = JSON.parse(readFileSync(join(__dirname, 'node_modules/electron/package.json'), 'utf8')).version;
const signMac = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.hostcaster.app',
  productName: 'Host-Caster',
  copyright: 'Copyright 2026 the Host-Caster project owner',
  electronVersion,
  directories: { app: '.build/stage', output: '.build/out', buildResources: 'build' },
  asar: true,
  compression: 'normal',
  artifactName: 'Host-Caster-${version}-${os}-${arch}.${ext}',
  protocols: [{ name: 'Host-Caster', schemes: ['hostcaster'] }],
  // updates are offered by the manifest notice for now; for electron-updater later add:
  //   publish: [{ provider: 'github', owner: '<owner>', repo: 'host-caster', releaseType: 'release' }]
  publish: null,
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'build/icons',
    category: 'Audio',
    synopsis: 'Your personal AI radio station',
    description: 'Host-Caster plays your music like a radio station, with AI hosts you design talking between the songs.',
    // the hostcaster:// handler comes from `protocols` above; the window class follows desktopName (scripts/stage.mjs)
    executableName: 'host-caster',
    syncDesktopName: true,
    desktop: { entry: { Keywords: 'radio;music;ai;podcast;' } },
  },
  deb: {
    packageName: 'host-caster',
    maintainer: 'Host-Caster <support@host-caster.com>',
    vendor: 'Host-Caster',
  },
  appImage: { artifactName: 'Host-Caster-${version}-linux-${arch}.AppImage' },
  win: {
    // the installer, and a zip to unpack and run without installing (Host-Caster-<version>-win-x64.zip)
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    icon: 'build/icon.png',
    // needs Wine on Linux (rcedit sets the icon and version info); the Windows CI runner does it
    signAndEditExecutable: process.env.HOSTCASTER_EDIT_EXE === '1',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Host-Caster',
    deleteAppDataOnUninstall: false,
    artifactName: 'Host-Caster-Setup-${version}-${arch}.${ext}',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    icon: 'build/icon.png',
    category: 'public.app-category.music',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // no Developer ID yet: ad-hoc signed ('-'), which Apple Silicon needs to start it at all; Gatekeeper still asks
    // (steps in docs/DESKTOP.md)
    ...(signMac ? {} : { identity: '-' }),
    notarize,
  },
  dmg: { artifactName: 'Host-Caster-${version}-mac-${arch}.${ext}' },
};
