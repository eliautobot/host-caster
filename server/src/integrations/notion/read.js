// What the hosts may read: the pages and databases the listener picked, as short plain text, cached ~10 minutes per
// account in memory (a break never waits on Notion twice in a row, and Notion's rate limit stays far away).
import { HttpError } from '../../errors.js';
import { notionClient } from './api.js';
import { getLink } from './store.js';
import { editedWhen, pageSummary, rowsSummary, titleOf } from './text.js';

const TTL_MS = 10 * 60 * 1000;
const TOTAL_MAX = 2400;
const cache = new Map();

export function forgetContext(userId) {
  cache.delete(userId);
}

async function readPage(client, id) {
  const page = await client.call('GET', `/v1/pages/${id}`);
  if (page.in_trash || page.archived) return undefined;
  const blocks = await client.call('GET', `/v1/blocks/${id}/children?page_size=100`);
  return { title: titleOf(page) || 'Untitled', text: pageSummary(blocks.results ?? []), editedAt: Date.parse(page.last_edited_time ?? '') || undefined };
}

async function readDataSource(client, id) {
  const ds = await client.call('GET', `/v1/data_sources/${id}`);
  if (ds.in_trash || ds.archived) return undefined;
  const rows = await client.call('POST', `/v1/data_sources/${id}/query`, {
    page_size: 10,
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
  });
  const latest = rows.results?.[0]?.last_edited_time;
  return { title: titleOf(ds) || 'Untitled', text: rowsSummary(rows.results ?? []), editedAt: Date.parse(latest ?? ds.last_edited_time ?? '') || undefined };
}

/**
 * { notes: [{ id, title, text, editedAt?, edited? }], problems: [{ id, title, message }], fetchedAt }. A page that is
 * no longer shared is reported (the card says so) and skipped; the others still go on air. `edited` ("today") is by
 * the listener's calendar (`tz`) and worked out on every call, so a cached read does not keep yesterday's word.
 */
export async function readContext(app, userId, now = Date.now(), tz) {
  const value = await readNotes(app, userId, now);
  return { ...value, notes: value.notes.map((n) => ({ ...n, edited: editedWhen(n.editedAt, now, tz) })) };
}

async function readNotes(app, userId, now) {
  const link = getLink(app, userId);
  if (!link) throw new HttpError(409, 'notion_not_connected', 'Connect Notion first');
  const key = JSON.stringify(link.settings.read.map((r) => r.id));
  const hit = cache.get(userId);
  if (hit && hit.key === key && now - hit.fetchedAt < TTL_MS) return hit.value;

  const client = notionClient(app, userId);
  const notes = [];
  const problems = [];
  let total = 0;
  for (const r of link.settings.read) {
    try {
      const got = r.type === 'data_source' ? await readDataSource(client, r.id) : await readPage(client, r.id);
      if (!got) {
        problems.push({ id: r.id, title: r.title, message: 'In the Notion trash' });
        continue;
      }
      if (!got.text || total >= TOTAL_MAX) continue;
      const text = got.text.slice(0, TOTAL_MAX - total);
      total += text.length;
      notes.push({ id: r.id, title: got.title, text, editedAt: got.editedAt });
    } catch (err) {
      if (err.code === 'notion_disconnected' || err.code === 'upstream_rate_limited') throw err;
      problems.push({ id: r.id, title: r.title, message: err.message });
    }
  }
  const value = { notes, problems, fetchedAt: now };
  cache.set(userId, { key, fetchedAt: now, value });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return value;
}
