// The desktop update notice: manifest checks, the file for this computer, required updates, "Later".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpdates, decide, isDownloadUrl, parseManifest, platformKeys, versionCode } from '../main/updates.js';

const manifest = (over = {}) => ({
  version: '0.2.0',
  versionCode: 20000,
  notes: ['Better breaks', 7, 'x'.repeat(400)],
  minimumSupported: 0,
  page: 'https://host-caster.com/download#desktop',
  files: {
    'windows-x64': { url: 'https://host-caster.com/d/Host-Caster-Setup-0.2.0-x64.exe', sha256: 'A'.repeat(64), size: 90 },
    'linux-x64-appimage': { url: 'https://host-caster.com/d/Host-Caster-0.2.0-linux-x86_64.AppImage' },
    'linux-x64-deb': { url: 'https://host-caster.com/d/Host-Caster-0.2.0-linux-amd64.deb' },
    'mac-universal': { url: 'http://evil.example/Host-Caster.dmg' },
  },
  ...over,
});

test('versionCode follows the Android scheme', () => {
  assert.equal(versionCode('0.1.0'), 10000);
  assert.equal(versionCode('1.2.3', 4), 1020304);
  assert.equal(versionCode('nope'), 0);
});

test('downloads only over https (http only on this computer)', () => {
  assert.equal(isDownloadUrl('https://host-caster.com/a.exe'), true);
  assert.equal(isDownloadUrl('http://127.0.0.1:9/a.exe'), true);
  assert.equal(isDownloadUrl('http://host-caster.com/a.exe'), false);
  assert.equal(isDownloadUrl('https://u:p@host-caster.com/a.exe'), false);
  assert.equal(isDownloadUrl('file:///etc/passwd'), false);
});

test('manifest is checked and trimmed', () => {
  const m = parseManifest(manifest());
  assert.equal(m.files['mac-universal'], undefined); // plain http elsewhere is dropped
  assert.equal(m.files['windows-x64'].sha256, 'a'.repeat(64));
  assert.deepEqual(m.notes.slice(0, 1), ['Better breaks']);
  assert.equal(m.notes[1].length, 300);
  assert.equal(parseManifest({ version: 'x', versionCode: 1 }), undefined);
  assert.equal(parseManifest(null), undefined);
});

test('the file for this computer, best first', () => {
  assert.deepEqual(platformKeys('win32', 'x64', {}), ['windows-x64', 'windows-x64']);
  assert.deepEqual(platformKeys('darwin', 'arm64', {}), ['mac-arm64', 'mac-universal']);
  assert.deepEqual(platformKeys('linux', 'x64', { APPIMAGE: '/a' }), ['linux-x64-appimage', 'linux-x64-deb']);
  assert.deepEqual(platformKeys('linux', 'x64', {}), ['linux-x64-deb', 'linux-x64-appimage']);
  const m = parseManifest(manifest());
  assert.match(decide(m, 10000, { keys: platformKeys('linux', 'x64', { APPIMAGE: '/a' }) }).url, /AppImage$/);
  // no file for this computer (the mac file was dropped): the download page
  assert.equal(decide(m, 10000, { keys: platformKeys('darwin', 'arm64', {}) }).url, 'https://host-caster.com/download#desktop');
});

test('newer only; required below minimumSupported; Later hides an optional one for a while', () => {
  const m = parseManifest(manifest());
  const keys = ['windows-x64'];
  assert.equal(decide(m, 20000, { keys }), undefined);
  assert.equal(decide(m, 30000, { keys }), undefined);
  const u = decide(m, 10000, { keys });
  assert.equal(u.required, false);
  assert.equal(u.size, 90);
  const now = 1_000_000;
  assert.equal(decide(m, 10000, { keys, snooze: { versionCode: 20000, until: now + 1 }, now }), undefined);
  assert.ok(decide(m, 10000, { keys, snooze: { versionCode: 19999, until: now + 1 }, now }));
  const req = parseManifest(manifest({ minimumSupported: 15000 }));
  assert.equal(decide(req, 10000, { keys, snooze: { versionCode: 20000, until: now + 1 }, now }).required, true);
});

test('createUpdates: checks, tells, snoozes, stays quiet when turned off', async () => {
  let saved = { checkUpdates: true, updateSnooze: null };
  const settings = { get: () => saved, set: (p) => (saved = { ...saved, ...p }) };
  const told = [];
  let body = manifest();
  const updates = createUpdates({
    manifestUrl: 'https://host-caster.com/download/desktop/latest.json',
    version: '0.1.0',
    fetch: async () => ({ ok: true, json: async () => body }),
    settings,
    onUpdate: (u) => told.push(u),
  });
  const res = await updates.check();
  assert.equal(res.checked, true);
  assert.equal(res.latest, '0.2.0');
  assert.equal(told.at(-1).version, '0.2.0');
  updates.snooze();
  assert.equal(saved.updateSnooze.versionCode, 20000);
  assert.equal(told.at(-1), undefined);
  assert.equal((await updates.check()).update, undefined); // put off
  assert.equal((await updates.check({ manual: true })).update.version, '0.2.0'); // asked by hand
  saved = { ...saved, checkUpdates: false };
  assert.equal(await updates.check(), undefined);
  body = { nope: true };
  const bad = await updates.check({ manual: true });
  assert.equal(bad.checked, false);
});
