// Sync engine against an in-memory fake server (fetch stubbed). Two "devices" = the same IndexedDB reset between them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDb, saveBrain, saveHost, deleteHost, listHosts, SEED_IDS, getHost } from '../db';
import { kvDelete } from '../db/kv';
import type { Brain, Host, SyncDoc } from '../types';
import { api } from './client';
import { sync } from './sync';

interface FakeServer {
  rev: number;
  doc: SyncDoc | null;
  secrets: Map<string, string>;
  puts: number;
  conflicts: number;
}

function installServer(): FakeServer {
  const s: FakeServer = { rev: 0, doc: null, secrets: new Map(), puts: 0, conflicts: 0 };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://x').pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/sync' && method === 'GET') return json(200, { rev: s.rev, doc: s.doc });
    if (path === '/api/sync' && method === 'PUT') {
      if (body.rev !== s.rev) {
        s.conflicts++;
        return json(409, { error: { code: 'conflict', message: 'stale' }, rev: s.rev });
      }
      expect(JSON.stringify(body.doc)).not.toMatch(/sk-live/);
      s.rev++;
      s.doc = body.doc;
      s.puts++;
      return json(200, { rev: s.rev });
    }
    const sec = /^\/api\/secrets\/(.+)$/.exec(path);
    if (sec && method === 'PUT') {
      s.secrets.set(decodeURIComponent(sec[1]!), body.value);
      return json(200, { ref: sec[1] });
    }
    return json(404, { error: { code: 'not_found', message: path } });
  });
  return s;
}

async function freshDevice() {
  await sync.stop();
  db.close();
  await db.delete();
  await initDb();
}

const signIn = () => {
  api.available = true;
  api.configure({ baseUrl: '', session: { user: { id: 'u1', name: 'Sam', providers: ['google'] }, kind: 'web' } });
};

describe('sync engine', () => {
  let server: FakeServer;
  beforeEach(async () => {
    await freshDevice();
    server = installServer();
    signIn();
  });
  afterEach(async () => {
    await sync.stop();
    vi.unstubAllGlobals();
  });

  it('first sign-in pushes the local doc; keys go to secrets and leave server-transport records', async () => {
    await saveBrain({ name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-live-1', model: 'gpt-4o-mini', transport: 'server' } as Brain);
    await saveBrain({ id: 'dev', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'sk-live-2', model: 'x', transport: 'device' } as Brain);
    await sync.start();
    expect(sync.state.status).toBe('idle');
    expect(server.rev).toBe(1);
    expect(server.doc!.hosts.map((h) => h.name).sort()).toEqual(['Jules', 'Maya', 'Rex']);
    expect(server.doc!.brains.every((b) => !b.apiKey && b.secretRef)).toBe(true);
    expect([...server.secrets.values()].sort()).toEqual(['sk-live-1', 'sk-live-2']);
    const local = await db.brains.toArray();
    expect(local.find((b) => b.transport === 'server')?.apiKey).toBeUndefined();
    expect(local.find((b) => b.id === 'dev')?.apiKey).toBe('sk-live-2');
    // nothing changed: syncing again does not push
    await sync.syncNow();
    expect(server.puts).toBe(1);
  });

  it('pulls another device\'s edits and additions', async () => {
    await sync.start();
    const maya = server.doc!.hosts.find((h) => h.id === SEED_IDS.maya)!;
    server.doc = {
      ...server.doc!,
      hosts: [...server.doc!.hosts.map((h) => (h.id === maya.id ? { ...h, name: 'Maya B', updatedAt: Date.now() + 1000 } : h)), { ...maya, id: 'new-host', name: 'Nova' }],
    };
    server.rev++;
    await sync.syncNow();
    expect((await getHost(SEED_IDS.maya))?.name).toBe('Maya B');
    expect((await getHost('new-host'))?.name).toBe('Nova');
  });

  it('a conflicting push (409) pulls, merges both edits and pushes again', async () => {
    await sync.start();
    // another device adds a host behind our back
    const any = server.doc!.hosts[0]!;
    server.doc = { ...server.doc!, hosts: [...server.doc!.hosts, { ...any, id: 'remote-host', name: 'Remote', updatedAt: Date.now() }] };
    server.rev++;
    // we add one locally; the debounced push uses our stale rev -> 409 -> pull, merge, push
    await saveHost({ ...(any as Host), id: 'local-host', name: 'Local' });
    await vi.waitFor(() => expect(server.doc!.hosts.map((h) => h.name)).toContain('Local'), { timeout: 6000, interval: 100 });
    expect(server.conflicts).toBe(1);
    const names = server.doc!.hosts.map((h) => h.name);
    expect(names).toContain('Remote');
    expect(names).toContain('Local');
    expect((await listHosts()).map((h) => h.name)).toContain('Remote');
  });

  it('local changes push by themselves after a short delay', async () => {
    await sync.start();
    await deleteHost(SEED_IDS.rex);
    await vi.waitFor(() => expect(server.doc!.hosts.some((h) => h.id === SEED_IDS.rex)).toBe(false), { timeout: 6000, interval: 100 });
    expect(server.doc!.deleted?.[`hosts:${SEED_IDS.rex}`]).toBeGreaterThan(0);
  });

  it('a fresh device does not bring back seeds the account deleted', async () => {
    await sync.start();
    await deleteHost(SEED_IDS.jules);
    await sync.syncNow();
    expect(server.doc!.hosts.some((h) => h.id === SEED_IDS.jules)).toBe(false);

    // device two: fresh seeds (incl. Jules), first sync
    const saved = { rev: server.rev, doc: server.doc };
    await freshDevice();
    server.rev = saved.rev;
    server.doc = saved.doc;
    signIn();
    await kvDelete('sync:base');
    await sync.start();
    expect((await listHosts()).map((h) => h.id)).not.toContain(SEED_IDS.jules);
    expect(server.doc!.hosts.some((h) => h.id === SEED_IDS.jules)).toBe(false);
  });

  it('signed out = local only: start does nothing', async () => {
    api.configure({ session: undefined });
    await sync.start();
    expect(server.puts).toBe(0);
    expect(sync.state.status).toBe('off');
  });
});
