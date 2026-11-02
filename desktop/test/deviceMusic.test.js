import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createDeviceMusic, folderId, parseRange, serveFile, walk } from '../main/deviceMusic.js';

const tmp = mkdtempSync(join(tmpdir(), 'hc-music-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const music = join(tmp, 'Music');
const song = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
for (const [path, body] of [
  ['Albums/Blue/01 Sky.mp3', song],
  ['Albums/Blue/cover.jpg', 'jpg'],
  ['Albums/Blue/02 Sea.FLAC', 'flac'],
  ['loose.m4a', 'm4a'],
  ['.hidden/secret.mp3', 'no'],
  ['notes.txt', 'no'],
]) {
  mkdirSync(join(music, path, '..'), { recursive: true });
  writeFileSync(join(music, path), body);
}
const other = join(tmp, 'Other');
mkdirSync(other);
writeFileSync(join(other, 'private.mp3'), 'not in a music folder');

describe('walk', () => {
  it('lists song files only, skips hidden folders, paths with /', async () => {
    const files = await walk(music);
    assert.deepEqual(
      files.map((f) => f.rel),
      ['Albums/Blue/01 Sky.mp3', 'Albums/Blue/02 Sea.FLAC', 'loose.m4a'],
    );
    assert.equal(files[0].size, 1000);
    assert.ok(files[0].modifiedAt > 0);
  });

  it('stops at the file limit', async () => {
    assert.equal((await walk(music, { maxFiles: 1 })).length, 1);
  });
});

describe('ranges', () => {
  it('parses the forms media players send', () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'invalid');
    assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  });

  it('serves the asked bytes (seeking) and the whole file', async () => {
    const file = join(music, 'Albums/Blue/01 Sky.mp3');
    const part = await serveFile(new Request('app://x/s', { headers: { range: 'bytes=500-509' } }), file);
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 500-509/1000');
    assert.equal(part.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [...song.subarray(500, 510)]);
    const whole = await serveFile(new Request('app://x/s'), file);
    assert.equal(whole.status, 200);
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);
    const out = await serveFile(new Request('app://x/s', { headers: { range: 'bytes=5000-' } }), file);
    assert.equal(out.status, 416);
  });
});

describe('music folders', () => {
  const state = join(tmp, 'state', 'music-folders.json');
  let picked = null;
  const dm = createDeviceMusic(state, { musicDir: () => music, pickFolder: async () => picked });

  it('suggests the system Music folder and adds it without a picker', async () => {
    assert.equal(await dm.suggested(), music);
    const f = await dm.addFolder(music);
    assert.deepEqual(f, { id: folderId(music), path: music });
    assert.equal(await dm.suggested(), null); // added: no longer suggested
  });

  it('any other path goes through the picker (cancelled = nothing added)', async () => {
    picked = null;
    assert.equal(await dm.addFolder(other), null);
    assert.equal((await dm.folders()).length, 1);
  });

  it('scans every folder and remembers them across starts', async () => {
    const files = await dm.scan();
    assert.equal(files.length, 3);
    assert.equal(files[0].folder, folderId(music));
    const again = createDeviceMusic(state, { musicDir: () => music, pickFolder: async () => null });
    assert.deepEqual(await again.folders(), await dm.folders());
  });

  it('serves song files inside a picked folder only', async () => {
    const id = folderId(music);
    const ok = await dm.serve(new Request('app://host-caster/x'), `/_device/${id}/Albums/Blue/01 Sky.mp3`);
    assert.equal(ok.status, 200);
    for (const bad of [`/_device/${id}/../Other/private.mp3`, `/_device/${id}/notes.txt`, `/_device/${id}/.hidden/secret.mp3`, `/_device/nope/loose.m4a`, `/_device/${id}/Albums/Blue/cover.jpg`]) {
      assert.equal((await dm.serve(new Request('app://host-caster/x'), bad)).status, 404, bad);
    }
  });

  it('removing a folder stops scanning and serving it', async () => {
    await dm.removeFolder(folderId(music));
    assert.deepEqual(await dm.scan(), []);
    const r = await dm.serve(new Request('app://host-caster/x'), `/_device/${folderId(music)}/loose.m4a`);
    assert.equal(r.status, 404);
  });
});
