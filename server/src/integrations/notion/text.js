// Notion objects -> short plain text the hosts can talk from: open to-dos, headings, list items and a little prose,
// size-capped. Pure functions (tested without Notion).

/** Rich text array -> plain string on one line. */
export function plain(richText) {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((t) => (typeof t?.plain_text === 'string' ? t.plain_text : typeof t?.text?.content === 'string' ? t.text.content : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A page's or data source's title (pages keep it in their one 'title' property). */
export function titleOf(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (Array.isArray(obj.title)) return plain(obj.title);
  for (const prop of Object.values(obj.properties ?? {})) {
    if (prop?.type === 'title') return plain(prop.title);
  }
  return '';
}

/** An emoji icon, else nothing (file and external icons are not shown in the app). */
export function emojiOf(obj) {
  return obj?.icon?.type === 'emoji' && typeof obj.icon.emoji === 'string' ? obj.icon.emoji : undefined;
}

/** Search result -> picker item. */
export function pickerItem(obj) {
  const type = obj.object === 'data_source' || obj.object === 'database' ? 'data_source' : 'page';
  return {
    id: obj.id,
    type,
    title: titleOf(obj) || (type === 'page' ? 'Untitled' : 'Untitled database'),
    icon: emojiOf(obj),
    editedAt: obj.last_edited_time ? Date.parse(obj.last_edited_time) : undefined,
    url: typeof obj.url === 'string' && obj.url.startsWith('https://') ? obj.url : undefined,
  };
}

const TEXT_TYPES = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout'];

/**
 * The gray "  on air, Oct 31, 3:42 PM" tail writeBlock adds to what the hosts wrote: when they also read that page
 * (one shopping list for both), they say "oat milk", not "oat milk on air, Oct 31, 3:42 PM".
 */
const isStamp = (t) =>
  t?.annotations?.color === 'gray' && /^\s+(on air|via your AI app|Host-Caster recap), /.test(String(t.plain_text ?? t.text?.content ?? ''));

/** One block -> { kind, text } or undefined (images, embeds, checked to-dos, empty lines are left out). */
export function blockLine(block) {
  if (!block || block.in_trash || block.archived || !TEXT_TYPES.includes(block.type)) return undefined;
  const body = block[block.type] ?? {};
  const text = plain(Array.isArray(body.rich_text) ? body.rich_text.filter((t) => !isStamp(t)) : body.rich_text);
  if (!text) return undefined;
  if (block.type === 'to_do') return body.checked ? undefined : { kind: 'todo', text };
  if (block.type.startsWith('heading_')) return { kind: 'heading', text };
  if (block.type.endsWith('list_item')) return { kind: 'item', text };
  return { kind: 'text', text };
}

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s);

/**
 * The blocks of one page as a short summary: "To do: a; b. Shopping: milk; eggs. Notes: ...". Open to-dos first
 * (they are what a listener most likely wants to hear about), then headed sections, then a little prose.
 */
export function pageSummary(blocks, max = 600) {
  const todos = [];
  const sections = [];
  const prose = [];
  let section;
  for (const b of blocks) {
    const line = blockLine(b);
    if (!line) continue;
    if (line.kind === 'todo') todos.push(clip(line.text, 120));
    else if (line.kind === 'heading') {
      section = { head: clip(line.text, 60), items: [] };
      sections.push(section);
    } else if (line.kind === 'item') {
      if (section) section.items.push(clip(line.text, 100));
      else prose.push(clip(line.text, 100));
    } else if (section && section.items.length < 6) section.items.push(clip(line.text, 160));
    else prose.push(clip(line.text, 200));
  }
  const parts = [];
  if (todos.length) parts.push(`Open to-dos: ${todos.slice(0, 8).join('; ')}${todos.length > 8 ? ` (and ${todos.length - 8} more)` : ''}.`);
  for (const s of sections) if (s.items.length) parts.push(`${s.head}: ${s.items.slice(0, 6).join('; ')}.`);
  if (prose.length) parts.push(prose.slice(0, 3).join(' '));
  return clip(parts.join(' ').replace(/\.\./g, '.'), max);
}

/** A row's notable property values: status, select, an unchecked checkbox ("not done"), a date. */
function rowFacts(row) {
  const out = [];
  for (const [name, p] of Object.entries(row.properties ?? {})) {
    if (!p || p.type === 'title') continue;
    if (p.type === 'status' && p.status?.name) out.push(`${name}: ${p.status.name}`);
    else if (p.type === 'select' && p.select?.name) out.push(`${name}: ${p.select.name}`);
    else if (p.type === 'checkbox' && p.checkbox === false) out.push(`not ${name.toLowerCase()}`);
    else if (p.type === 'date' && p.date?.start) out.push(`${name}: ${p.date.start.slice(0, 10)}`);
    if (out.length >= 3) break;
  }
  return out;
}

const FINISHED = /^(done|complete|completed|finished|closed|archived)$/i;

/** A row the listener already finished: a Done status, or a checked "Done" box. */
function finished(row) {
  return Object.entries(row.properties ?? {}).some(
    ([name, p]) => (p?.type === 'status' && FINISHED.test(p.status?.name ?? '')) || (p?.type === 'checkbox' && p.checkbox === true && FINISHED.test(name)),
  );
}

/** Recently edited open rows of a database (data source) as one line: "Plan trip (Status: In progress); ...". */
export function rowsSummary(rows, max = 600) {
  const items = rows
    .filter((r) => !r.in_trash && !r.archived && !finished(r))
    .map((r) => {
      const title = clip(titleOf(r) || 'Untitled', 100);
      const facts = rowFacts(r);
      return facts.length ? `${title} (${facts.join(', ')})` : title;
    })
    .slice(0, 10);
  return items.length ? clip(`Recent entries: ${items.join('; ')}.`, max) : '';
}

/** The calendar day of `ms` in `tz` as a day number (the server's own zone when tz is missing or not a real zone). */
function dayIn(ms, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: tz || undefined }).formatToParts(ms);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(ms);
  }
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000;
}

/**
 * "today", "yesterday", "3 days ago" for a last-edited time, by the listener's calendar (`tz`, from the app): the
 * server runs in UTC, where a page edited on a US afternoon is "yesterday" by the evening.
 */
export function editedWhen(ms, now = Date.now(), tz) {
  if (!ms) return undefined;
  const days = dayIn(now, tz) - dayIn(ms, tz);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return undefined;
}

/** Cleans what the hosts write: one line, no control characters, capped. */
export function cleanWriteText(text, max) {
  // eslint-disable-next-line no-control-regex
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** "Oct 31, 3:42 PM" in the listener's time zone (UTC when it is unknown or not a real zone). */
export function stampOf(ms, tz) {
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || 'UTC' }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(ms);
  }
}

const rt = (content, gray) => ({ type: 'text', text: { content }, ...(gray ? { annotations: { color: 'gray' } } : {}) });

/** The one block a host adds: a to-do or a note, with when it was added (gray). */
export function writeBlock(kind, text, stamp, source) {
  const via = source === 'recap' ? 'Host-Caster recap' : source === 'app' ? 'via your AI app' : 'on air';
  const tail = rt(`  ${via}, ${stamp}`, true);
  if (kind === 'todo') return { object: 'block', type: 'to_do', to_do: { rich_text: [rt(text), tail], checked: false } };
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [rt(text), tail] } };
}
