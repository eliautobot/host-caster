import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeApp } from './helpers.js';

test('GET /api/health answers ok', async (t) => {
  const { app } = await makeApp(t);
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
});

test('GET /api/config reports sign-ins', async (t) => {
  const { app } = await makeApp(t);
  const body = (await app.inject({ method: 'GET', url: '/api/config' })).json();
  assert.deepEqual(body.signIn, { google: false, x: false, local: true });
  assert.equal(body.serverLibrary, false);
  assert.equal(body.appScheme, 'hostcaster');
});

test('unknown API routes return a JSON error', async (t) => {
  const { app } = await makeApp(t);
  const res = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'not_found');
});

test('first start writes a secret key and migrates the db', async (t) => {
  const { app, dataDir } = await makeApp(t);
  assert.ok(existsSync(join(dataDir, 'secret.key')));
  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const name of ['users', 'identities', 'sessions', 'sync_docs', 'secrets', 'inbox', 'connector_tokens', 'server_tracks']) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }
});

test('logged URLs hide the connector secret and one-time OAuth values', async () => {
  const { redactUrl } = await import('../src/index.js');
  assert.equal(redactUrl('/mcp/aw_secret123'), '/mcp/***');
  assert.equal(redactUrl('/mcp/aw_secret123?x=1'), '/mcp/***?x=1');
  assert.equal(redactUrl('/auth/google/callback?state=s1&code=c2&scope=a'), '/auth/google/callback?state=***&code=***&scope=a');
  assert.equal(redactUrl('/auth/google/start?link=t3&returnTo=/'), '/auth/google/start?link=***&returnTo=/');
  assert.equal(redactUrl('/api/health'), '/api/health');
});
