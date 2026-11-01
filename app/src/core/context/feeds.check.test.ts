// Live check of every default news feed (skipped unless HC_FEEDS=1): each must fetch and parse into headlines with
// the app's own parser, directly (as the Android and iOS apps fetch, no CORS) and, with HC_FEEDS_SERVER set, through a
// Host-Caster server's /api/fetch-text (as the web app fetches when signed in).
//   HC_FEEDS=1 HC_FEEDS_SERVER=http://127.0.0.1:8671 npx vitest run src/core/context/feeds.check.test.ts
import { describe, expect, it } from 'vitest';
import { NEWS_REGIONS } from './news';
import { parseFeed } from './rss';

const ON = process.env.HC_FEEDS === '1';
const SERVER = process.env.HC_FEEDS_SERVER;
const urls = [...new Set(NEWS_REGIONS.flatMap((r) => r.feeds.map((f) => f.url)))];
const DAY = 86_400_000;

function judge(text: string) {
  const heads = parseFeed(text, 'News');
  const newest = Math.max(0, ...heads.map((h) => h.at ?? 0));
  return { count: heads.length, fresh: newest > Date.now() - 3 * DAY, sample: heads[0]?.title ?? '' };
}

/** A local account on the server, for its fetch route (signed-in users only). */
async function serverSession(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/local/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-HostCaster': '1' },
    body: JSON.stringify({ email: `feeds-${Date.now()}@example.com`, password: 'a good long password', name: 'Feed Check' }),
  });
  if (res.status !== 201) throw new Error(`signup ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe.skipIf(!ON)('default news feeds (live)', () => {
  it(`all ${urls.length} fetch and parse directly`, { timeout: 120_000 }, async () => {
    const rows = await Promise.all(
      urls.map(async (u) => {
        try {
          const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
          return { u, status: res.status, ...judge(await res.text()) };
        } catch (err) {
          return { u, status: 0, count: 0, fresh: false, sample: String(err) };
        }
      }),
    );
    for (const r of rows) console.log(`[feeds] direct ${r.status} ${String(r.count).padStart(3)} ${r.fresh ? 'fresh' : 'STALE'} ${r.u} | ${r.sample.slice(0, 70)}`);
    expect(rows.filter((r) => r.status !== 200 || r.count < 5 || !r.fresh)).toEqual([]);
  });

  it.skipIf(!SERVER)(`all ${urls.length} fetch and parse through the server`, { timeout: 120_000 }, async () => {
    const cookie = await serverSession(SERVER!);
    const rows = await Promise.all(
      urls.map(async (u) => {
        const res = await fetch(`${SERVER}/api/fetch-text`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-HostCaster': '1', cookie },
          body: JSON.stringify({ url: u }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = (await res.json()) as { text?: string; error?: { message: string } };
        return { u, status: res.status, ...(body.text ? judge(body.text) : { count: 0, fresh: false, sample: body.error?.message ?? '' }) };
      }),
    );
    for (const r of rows) console.log(`[feeds] server ${r.status} ${String(r.count).padStart(3)} ${r.fresh ? 'fresh' : 'STALE'} ${r.u} | ${r.sample.slice(0, 70)}`);
    expect(rows.filter((r) => r.status !== 200 || r.count < 5 || !r.fresh)).toEqual([]);
  });
});
