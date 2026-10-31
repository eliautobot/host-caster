// Renders the PWA icons from public/logo.svg. Run: npm run icons (output is committed).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const root = new URL('..', import.meta.url);
const svg = readFileSync(new URL('public/logo.svg', root), 'utf8');

// Maskable: full-bleed square background; the mark already sits inside the 80% safe zone.
const maskable = svg
  .replace(/<rect width="512" height="512" rx="116"[^>]*\/>/, '<rect width="512" height="512" fill="#0a0a0b"/>')
  .replace(/<rect x="2"[^>]*\/>/, '');
// Monochrome (Android themed icons / notification): white mark on transparent.
const mono = svg
  .replace(/<rect[^>]*\/>/g, '')
  .replace(/stroke-opacity="0.5"/g, '')
  .replace('fill="#ff5a36"', 'fill="#ffffff"');

const out = new URL('public/icons/', root);
mkdirSync(out, { recursive: true });

function render(source, size, name) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(new URL(name, out), png);
  console.log(`icons/${name} ${size}px`);
}

render(svg, 192, 'icon-192.png');
render(svg, 512, 'icon-512.png');
render(maskable, 192, 'maskable-192.png');
render(maskable, 512, 'maskable-512.png');
render(maskable, 180, 'apple-touch-icon.png');
render(mono, 96, 'monochrome-96.png');
render(svg, 32, 'favicon-32.png');

writeFileSync(new URL('public/icons/maskable.svg', root), maskable);
mkdirSync(new URL('../docs/', root), { recursive: true });
copyFileSync(new URL('public/logo.svg', root), new URL('../docs/logo.svg', root));
console.log('docs/logo.svg');
