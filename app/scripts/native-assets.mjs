// Renders the Android + iOS app icons and splash images from public/logo.svg.
// Run: node scripts/native-assets.mjs (output is committed inside android/ and ios/).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = fileURLToPath(new URL('..', import.meta.url));
const logo = readFileSync(`${root}public/logo.svg`, 'utf8');
const BG = '#0a0a0b';

// The mark (arcs + on-air dot) without the rounded tile, as an SVG fragment in the 512 box.
const mark = logo.slice(logo.indexOf('<g '), logo.lastIndexOf('</svg>'));
const defs = logo.slice(logo.indexOf('<defs>'), logo.indexOf('</defs>') + 7);
const markWhite = mark.replace(/stroke-opacity="0.5"/g, '').replace('fill="#ff5a36"', 'fill="#ffffff"');

/** viewBox around the 512 mark; pad > 0 shrinks the mark inside the canvas. */
const svg = (body, { pad = 0, bg, w = 512, h = 512 } = {}) => {
  const vw = 512 + pad * 2;
  const vh = (vw * h) / w;
  const x = 256 - vw / 2;
  const y = 256 - vh / 2;
  const fill = bg ? `<rect x="${x}" y="${y}" width="${vw}" height="${vh}" fill="${bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${vw} ${vh}">${defs}${fill}${body}</svg>`;
};

function write(file, source, width, height) {
  const r = new Resvg(source, { fitTo: { mode: 'width', value: width } }).render();
  if (height && r.height !== height) throw new Error(`${file}: rendered ${r.width}x${r.height}, wanted ${width}x${height}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, r.asPng());
  console.log(`${file.replace(root, '')} ${r.width}x${r.height}`);
}

/** Opaque RGB PNG (no alpha channel): App Store icons must not have one. */
function writeOpaque(file, source, size) {
  const r = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render();
  const { width, height, pixels } = r;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = pixels[i]; raw[o + 1] = pixels[i + 1]; raw[o + 2] = pixels[i + 2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  console.log(`${file.replace(root, '')} ${width}x${height} rgb`);
}

const res = `${root}android/app/src/main/res`;
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

// Legacy icons (API < 26): the full tile; round = the same art on a circle.
const round = logo
  .replace(/<rect width="512" height="512" rx="116" fill="url\(#bg\)"\/>/, '<circle cx="256" cy="256" r="256" fill="url(#bg)"/>')
  .replace(/<rect x="2"[^>]*\/>/, '');
// Adaptive icon layers: 108dp canvas, 72dp visible. pad 122 => the 512 box spans 72dp, like the tile.
const fgPad = 122;
for (const [d, s] of Object.entries(densities)) {
  write(`${res}/mipmap-${d}/ic_launcher.png`, logo, 48 * s);
  write(`${res}/mipmap-${d}/ic_launcher_round.png`, round, 48 * s);
  write(`${res}/mipmap-${d}/ic_launcher_foreground.png`, svg(mark, { pad: fgPad }), 108 * s);
  write(`${res}/mipmap-${d}/ic_launcher_monochrome.png`, svg(markWhite, { pad: fgPad }), 108 * s);
}

// Legacy splash (API < 31; 31+ uses the SplashScreen theme icon): dark fill + mark.
const splashSizes = {
  'drawable': [480, 320],
  'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280],
};
for (const [dir, [w, h]] of Object.entries(splashSizes)) {
  // the 512 box ~ 55% of the short side (the visible mark is ~ 45% of that box)
  const short = Math.min(w, h);
  const vw = (512 / 0.55) * (w / short);
  write(`${res}/${dir}/splash.png`, svg(mark, { pad: (vw - 512) / 2, bg: BG, w, h }), w, h);
}

// iOS: one 1024 icon (no alpha: full-bleed tile, iOS rounds it) + 2732 splash.
const ios = `${root}ios/App/App/Assets.xcassets`;
const iosIcon = logo
  .replace(/<rect width="512" height="512" rx="116"/, '<rect width="512" height="512" rx="0"')
  .replace(/<rect x="2"[^>]*\/>/, '');
writeOpaque(`${ios}/AppIcon.appiconset/AppIcon-512@2x.png`, iosIcon, 1024);
const iosSplash = svg(mark, { pad: (2732 / 900 * 512 - 512) / 2, bg: BG, w: 2732, h: 2732 });
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  write(`${ios}/Splash.imageset/${f}`, iosSplash, 2732, 2732);
}
