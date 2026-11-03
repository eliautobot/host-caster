// The listener's Google Tasks for the tools (read through the server, kept 20 s so a turn that reads and then
// changes a task asks Google once), and finding a task or a list by id or by the listener's words.
import { trackerApi, type GoogleTask } from '../../../tracker/api';
import { contentWords } from './needs';

let cache: { at: number; value: { lists: { id: string; title: string }[]; tasks: GoogleTask[] } } | undefined;

export async function googleTasks(maxAgeMs = 20_000): Promise<{ lists: { id: string; title: string }[]; tasks: GoogleTask[] }> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  const value = await trackerApi.tasks();
  cache = { at: Date.now(), value };
  return value;
}

/** After a change: the next read asks Google again. */
export function forgetGoogleTasks(): void {
  cache = undefined;
}

export type Found<T> = { one: T } | { many: T[] } | { none: true };

/** By id, else by words: the best match when it is clear, several when they tie. */
export function pick<T>(ref: string, items: T[], idOf: (t: T) => string, textOf: (t: T) => string): Found<T> {
  const r = ref.trim();
  if (!r) return { none: true };
  // an id as the model saw it: whole, or only its last part ("cal@x:evt1" -> "evt1", from a look-up)
  const byId = items.find((t) => idOf(t) === r || idOf(t).endsWith(`:${r}`));
  if (byId) return { one: byId };
  const exact = items.filter((t) => textOf(t).trim().toLowerCase() === r.toLowerCase());
  if (exact.length === 1) return { one: exact[0]! };
  const words = contentWords(r);
  if (!words.length) return { none: true };
  const scored = items
    .map((t) => {
      const hay = contentWords(textOf(t));
      return { t, hits: words.filter((w) => hay.some((h) => h === w || (w.length > 3 && (h.startsWith(w) || w.startsWith(h))))).length };
    })
    .filter((x) => x.hits > 0 && x.hits >= Math.ceil(words.length / 2))
    .sort((a, b) => b.hits - a.hits);
  if (!scored.length) return { none: true };
  const best = scored.filter((x) => x.hits === scored[0]!.hits);
  return best.length === 1 ? { one: best[0]!.t } : { many: best.slice(0, 4).map((x) => x.t) };
}

export const findTask = (ref: string, tasks: GoogleTask[]) =>
  pick(
    ref,
    tasks.filter((t) => t.status !== 'completed'),
    (t) => t.id,
    (t) => t.title,
  );

export const findList = (ref: string, lists: { id: string; title: string }[]) =>
  pick(
    ref.replace(/\blist\b/gi, ' '),
    lists,
    (l) => l.id,
    (l) => l.title,
  );
