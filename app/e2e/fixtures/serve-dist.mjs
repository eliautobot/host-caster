// Serves a built app folder for e2e runs, plus /e2e-tone.wav (a quiet 3 minute tone: a non-YouTube "song" the
// player can stream without a server library). node e2e/fixtures/serve-dist.mjs <dist> <port>
// Listens on localhost only: YouTube needs a host NAME origin (http://localhost:PORT), see youtube-radio.e2e.mjs.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const port = Number(process.argv[3] ?? 8721);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wav': 'audio/wav' };

function tone(seconds = 180, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 1500), 44 + i * 2);
  return b;
}
const wav = tone();

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/e2e-tone.wav') {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : wav.length - 1;
      res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': end - start + 1 });
      return res.end(wav.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length });
    return res.end(wav);
  }
  let file = normalize(join(dist, path));
  if (!file.startsWith(normalize(dist))) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(dist, 'index.html');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, 'localhost', () => console.log(`serving ${dist} on http://localhost:${port}`));
