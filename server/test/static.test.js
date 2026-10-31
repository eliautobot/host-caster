import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeApp } from './helpers.js';

test('serves the built app with SPA fallback and cache headers', async (t) => {
  const dist = mkdtempSync(join(tmpdir(), 'hostcaster-dist-'));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Host-Caster</title>');
  writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(dist, 'sw.js'), '// sw');
  const { app: served } = await makeApp(t, { APP_DIST: dist });

  const root = await served.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 200);
  assert.match(root.headers['content-type'], /html/);

  const deep = await served.inject({ method: 'GET', url: '/hosts/abc' });
  assert.equal(deep.statusCode, 200);
  assert.match(deep.body, /Host-Caster/);
  assert.equal(deep.headers['cache-control'], 'no-cache');

  const asset = await served.inject({ method: 'GET', url: '/assets/app-abc.js' });
  assert.match(asset.headers['cache-control'], /immutable/);

  const sw = await served.inject({ method: 'GET', url: '/sw.js' });
  assert.equal(sw.headers['cache-control'], 'no-cache');
  assert.equal(sw.headers['service-worker-allowed'], '/');

  const missing = await served.inject({ method: 'GET', url: '/nope.js' });
  assert.equal(missing.statusCode, 404);
});
