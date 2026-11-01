// Notion as a context source: the pages and databases the listener chose ("Hosts can read") as short notes for the
// existing notes topic. Cached in kv (10 min) like every source, so the radio still has them offline.
import { api } from '../api/client';
import { notion, type NotionNote } from '../api/notion';
import { cached } from './cache';

export const NOTION_CONTEXT_KEY = 'notion:context';
const TTL_MS = 10 * 60_000;

/** One note line per page: what the hosts see in FACTS. */
export function notionNoteText(n: NotionNote): string {
  const when = n.edited ? `, edited ${n.edited},` : '';
  return `Your Notion page "${n.title}"${when} says: ${n.text}`;
}

/**
 * The chosen pages as notes, or [] (not signed in, not connected, nothing chosen, Notion unreachable and nothing
 * cached). `fresh`: fetch now whatever the cache holds ("What your hosts can see", Check now).
 */
export async function getNotionPages(now = Date.now(), opts: { fresh?: boolean } = {}): Promise<NotionNote[]> {
  const c = await cached(
    NOTION_CONTEXT_KEY,
    opts.fresh ? 0 : TTL_MS,
    async () => {
      if (!api.available || !api.signedIn) throw new Error('offline');
      return (await notion.context()).notes;
    },
    now,
  );
  return c.value ?? [];
}

/** Notes from Notion as the lines the hosts get. */
export async function getNotionNotes(now = Date.now()): Promise<string[]> {
  return (await getNotionPages(now)).map(notionNoteText);
}
