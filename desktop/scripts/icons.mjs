// Renders the desktop icons from the app's logo (app/public/logo.svg) into build/: icon.png (1024, electron-builder
// makes the Windows .ico and macOS .icns from it) and icons/<size>x<size>.png for Linux. Output is committed.
// Run: node scripts/icons.mjs (uses @resvg/resvg-js from app/node_modules).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const require = createRequire(new URL('../../app/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
const svg = readFileSync(new URL('../app/public/logo.svg', root), 'utf8');

const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
mkdirSync(new URL('build/icons/', root), { recursive: true });
writeFileSync(new URL('build/icon.png', root), render(1024));
for (const size of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(new URL(`build/icons/${size}x${size}.png`, root), render(size));
console.log(`icons in ${fileURLToPath(new URL('build/', root))}`);
