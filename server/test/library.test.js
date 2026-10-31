import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseRange } from '../src/library/routes.js';
import { localUser, makeApp } from './helpers.js';

/** A 1-second mono 16-bit WAV with RIFF INFO tags. */
function wav({ title, artist, album } = {}) {
  const sub = (id, text) => {
    const data = Buffer.from(`${text}\0`, 'utf8');
    const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, pad]);
  };
  const info = Buffer.concat([
    Buffer.from('INFO'),
    ...(title ? [sub('INAM', title)] : []),
    ...(artist ? [sub('IART', artist)] : []),
    ...(album ? [sub('IPRD', album)] : []),
  ]);
  const chunk = (id, body) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(16000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const samples = Buffer.alloc(16000);
  for (let i = 0; i < samples.length; i += 2) samples.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i);
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), ...(title || artist ? [chunk('LIST', info)] : []), chunk('data', samples)]);
  return chunk('RIFF', body);
}

async function setup(t) {
  const music = mkdtempSync(join(tmpdir(), 'hostcaster-music-'));
  t.after(() => rmSync(music, { recursive: true, force: true }));
  writeFileSync(join(music, 'song.wav'), wav({ title: 'Night Drive', artist: 'The Signals', album: 'Static' }));
  mkdirSync(join(music, 'Album'));
  writeFileSync(join(music, 'Album', '01 - Untagged Tune.wav'), wav());
  writeFileSync(join(music, 'Album', 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  writeFileSync(join(music, 'notes.txt'), 'not audio');
  const { app } = await makeApp(t, { MUSIC_DIR: music, LIBRARY_SCAN_ON_START: 'false' });
  const u = await localUser(app);
  return { app, music, ...u };
}

test('parseRange handles normal, open, suffix and bad ranges', () => {
  assert.equal(parseRange(undefined, 100), undefined);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), null);
  assert.equal(parseRange('bytes=5-1', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
});

test('library: scan tags + folder art, list, Range streaming, stream keys, rescan', async (t) => {
  const { app, music, call } = await setup(t);
  assert.deepEqual((await call('POST', '/api/library/rescan')).json(), { count: 2, changed: 2, removed: 0, failed: 0 });
  assert.equal((await call('POST', '/api/library/rescan')).json().changed, 0, 'unchanged files are skipped');

  const { tracks, streamKey } = (await call('GET', '/api/library/tracks')).json();
  assert.equal(tracks.length, 2);
  const tagged = tracks.find((x) => x.title === 'Night Drive');
  assert.equal(tagged.artist, 'The Signals');
  assert.equal(tagged.album, 'Static');
  assert.equal(tagged.durationMs, 1000);
  assert.equal(tagged.hasArt, false);
  const untagged = tracks.find((x) => x.title === 'Untagged Tune');
  assert.ok(untagged, 'title from the file name');
  assert.equal(untagged.hasArt, true);

  // no session and no key: refused; key works (audio elements cannot send headers)
  const anon = await app.inject({ method: 'GET', url: `/api/library/stream/${tagged.id}` });
  assert.equal(anon.statusCode, 401);
  const full = await app.inject({ method: 'GET', url: `/api/library/stream/${tagged.id}?k=${streamKey}` });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-type'], 'audio/wav');
  const size = Number(full.headers['content-length']);
  assert.equal(full.rawPayload.length, size);
  assert.equal(full.rawPayload.subarray(0, 4).toString(), 'RIFF');

  const part = await call('GET', `/api/library/stream/${tagged.id}`, undefined, { range: 'bytes=0-3' });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 0-3/${size}`);
  assert.equal(part.rawPayload.toString(), 'RIFF');
  const tail = await call('GET', `/api/library/stream/${tagged.id}`, undefined, { range: 'bytes=-2' });
  assert.equal(tail.rawPayload.length, 2);
  const unsat = await call('GET', `/api/library/stream/${tagged.id}`, undefined, { range: `bytes=${size + 5}-` });
  assert.equal(unsat.statusCode, 416);
  assert.equal(unsat.headers['content-range'], `bytes */${size}`);
  assert.equal((await app.inject({ method: 'GET', url: `/api/library/stream/${tagged.id}?k=forged` })).statusCode, 401);

  const art = await app.inject({ method: 'GET', url: `/api/library/art/${untagged.id}?k=${streamKey}` });
  assert.equal(art.statusCode, 200);
  assert.equal(art.headers['content-type'], 'image/jpeg');
  assert.equal((await call('GET', `/api/library/art/${tagged.id}`)).statusCode, 404);
  assert.equal((await call('GET', '/api/library/stream/nope')).statusCode, 404);

  unlinkSync(join(music, 'song.wav'));
  assert.equal((await call('POST', '/api/library/rescan')).json().removed, 1);
  assert.equal((await call('GET', '/api/library/tracks')).json().tracks.length, 1);
});

test('library off without MUSIC_DIR', async (t) => {
  const { app } = await makeApp(t);
  const { call } = await localUser(app);
  assert.equal((await call('GET', '/api/library/tracks')).json().error.code, 'library_off');
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().serverLibrary, false);
});
