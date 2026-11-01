// Writes the desktop release manifest (latest.json, read by the app's update notice and the website's Download page)
// from the built files in a folder: sizes and SHA-256 are computed, URLs are <base>/<file name>.
// Usage: node scripts/manifest.mjs --dir .build/out --base https://host-caster.com/download/desktop \
//          [--notes "Line one|Line two"] [--min 10000] [--page https://host-caster.com/download#desktop] [--out latest.json]
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionCode } from '../main/updates.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = resolve(arg('--dir', join(desktopDir, '.build/out')));
const base = arg('--base', 'https://host-caster.com/download/desktop').replace(/\/+$/, '');
const version = JSON.parse(readFileSync(join(desktopDir, '../app/package.json'), 'utf8')).version;

/** file name pattern -> manifest key (names from electron-builder.config.cjs) */
const KINDS = [
  [/^Host-Caster-Setup-.+-x64\.exe$/, 'windows-x64'],
  [/^Host-Caster-Setup-.+-arm64\.exe$/, 'windows-arm64'],
  [/^Host-Caster-.+-mac-universal\.dmg$/, 'mac-universal'],
  [/^Host-Caster-.+-mac-arm64\.dmg$/, 'mac-arm64'],
  [/^Host-Caster-.+-mac-x64\.dmg$/, 'mac-x64'],
  [/^Host-Caster-.+-linux-x86_64\.AppImage$/, 'linux-x64-appimage'],
  [/^Host-Caster-.+-linux-arm64\.AppImage$/, 'linux-arm64-appimage'],
  [/^Host-Caster-.+-linux-amd64\.deb$/, 'linux-x64-deb'],
  [/^Host-Caster-.+-linux-arm64\.deb$/, 'linux-arm64-deb'],
];

const sha256 = (file) =>
  new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });

const files = {};
for (const name of readdirSync(dir).sort()) {
  if (!name.includes(version)) continue;
  const kind = KINDS.find(([re]) => re.test(name))?.[1];
  if (!kind) continue;
  const path = join(dir, name);
  files[kind] = { url: `${base}/${encodeURIComponent(name)}`, sha256: await sha256(path), size: statSync(path).size, name };
}
if (!Object.keys(files).length) {
  console.error(`no Host-Caster ${version} builds in ${dir}`);
  process.exit(1);
}
const manifest = {
  version,
  versionCode: versionCode(version),
  released: new Date().toISOString().slice(0, 10),
  notes: String(arg('--notes', '')).split('|').map((s) => s.trim()).filter(Boolean),
  minimumSupported: Number(arg('--min', '0')),
  page: arg('--page', 'https://host-caster.com/download#desktop'),
  files,
};
const out = resolve(arg('--out', join(dir, 'latest.json')));
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${out}: ${Object.keys(files).join(', ')}`);
