// Builds the desktop app's folder, .build/stage, which electron-builder packs (and the tests launch as is):
//   package.json             name, version (the app's), main = desktop/main/main.js
//   desktop/main/**          the Electron main process, preload and local helper (+ icon.png, build-config.json)
//   server/src/<few files>   the server modules the local helper runs (the ChatGPT plan service), same paths as the repo
//   app-dist/**              the web app (scripts/build-app.sh)
// Usage: node scripts/stage.mjs [--app-dist <dir>]. Build-time defaults for forks: HOSTCASTER_SERVER, HOSTCASTER_SITE,
// HOSTCASTER_UPDATE_URL (written to build-config.json; the running app's own environment still wins).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktopDir, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const appDist = resolve(arg('--app-dist', join(desktopDir, '.build/app-dist')));
const stage = join(desktopDir, '.build/stage');

/** Everything the local helper imports from the server (checked below by importing it with plain Node). */
export const SERVER_FILES = [
  'crypto.js',
  'errors.js',
  'auth/flows.js',
  'chatgpt/errors.js',
  'chatgpt/host.js',
  'chatgpt/loopback.js',
  'chatgpt/oidc.js',
  'chatgpt/responses.js',
  'chatgpt/service.js',
  'chatgpt/store.js',
];

if (!existsSync(join(appDist, 'index.html'))) {
  console.error(`No web app build in ${appDist}: run scripts/build-app.sh first`);
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(desktopDir, 'main'), join(stage, 'desktop/main'), { recursive: true });
for (const f of SERVER_FILES) {
  mkdirSync(dirname(join(stage, 'server/src', f)), { recursive: true });
  cpSync(join(repo, 'server/src', f), join(stage, 'server/src', f));
}
cpSync(appDist, join(stage, 'app-dist'), { recursive: true });
cpSync(join(desktopDir, 'build/icon.png'), join(stage, 'desktop/main/icon.png'));

const built = Object.fromEntries(
  [
    ['server', process.env.HOSTCASTER_SERVER],
    ['site', process.env.HOSTCASTER_SITE],
    ['updateUrl', process.env.HOSTCASTER_UPDATE_URL],
  ].filter(([, v]) => v),
);
writeFileSync(join(stage, 'desktop/main/build-config.json'), `${JSON.stringify(built, null, 2)}\n`);

const appPkg = JSON.parse(readFileSync(join(repo, 'app/package.json'), 'utf8'));
const desktopPkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'host-caster',
      productName: 'Host-Caster',
      version: appPkg.version,
      description: desktopPkg.description,
      main: 'desktop/main/main.js',
      type: 'module',
      // Linux: the window's app id / WM_CLASS, so the dock links it to the installed host-caster.desktop
      desktopName: 'host-caster.desktop',
      author: { name: 'Host-Caster', email: 'support@host-caster.com' },
      homepage: 'https://host-caster.com',
      license: 'AGPL-3.0-only',
    },
    null,
    2,
  )}\n`,
);

// the helper must load with nothing but the staged files (no server dependencies, no missing module)
const check = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(stage, 'desktop/main/helper/server.js'))})`], {
  encoding: 'utf8',
});
if (check.status !== 0) {
  console.error(`staged helper does not load:\n${check.stderr.split('\n').slice(0, 8).join('\n')}`);
  process.exit(1);
}
console.log(`staged ${appPkg.version} in ${stage}`);
