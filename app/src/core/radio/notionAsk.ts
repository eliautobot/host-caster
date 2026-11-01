// "Add oat milk to my list", "note that idea about...", "remind me in Notion to...": the listener asks the hosts to
// put something in their Notion (a call-in, or their AI app through the inbox). Pure helpers: spotting such an ask,
// reading it without a model (the safe fallback), checking what a brain answered, and the words the hosts get.
import type { BreakPlan } from './planner';

export type NotionAskKind = 'todo' | 'note';

export interface NotionAsk {
  kind: NotionAskKind;
  /** only the item or the note, in the listener's words */
  text: string;
}

/** What happened to an ask, for the break that answers it. */
export interface NotionWrite extends NotionAsk {
  from: 'call' | 'app';
  ok: boolean;
  /** the page it went to */
  pageTitle?: string;
  /** why it did not work, in words a host can say ("adding notes is switched off in Settings") */
  problem?: string;
}

const LIST_WORDS = String.raw`(?:list|to-?dos?|todo list|to-do list|notes?|page|notion)`;
const CUES = [
  String.raw`\bnotion\b`,
  String.raw`\b(?:add|put|stick|throw|pop)\b.{1,120}?\b(?:to|on|onto|in|into)\s+(?:my|the|our)\s+(?:[\w-]+\s+){0,2}${LIST_WORDS}\b`,
  String.raw`\b(?:make|take|leave)\s+(?:a\s+)?note\b`,
  String.raw`\bnote\s+(?:that|this|down|it)\b`,
  String.raw`\b(?:write|jot)\s+(?:that\s+|this\s+|it\s+)?down\b`,
  String.raw`\bsave\s+(?:this|that|an?)\s+(?:idea|thought|note)\b`,
];
const CUE = new RegExp(CUES.join('|'), 'i');

/** Cheap first check: could these words ask for something to be written down? (No model, no network.) */
export function mightAskToWrite(said: string): boolean {
  return CUE.test(said);
}

/** Words around the item that are not part of it ("please", "in Notion", "for me"). */
function tidy(s: string): string {
  let t = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[:,\-–\s]+/, '')
    .replace(/^(?:that|to|the following)\s+/i, '');
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/[\s,.!?;:]+$/, '')
      .replace(/\s*,?\s*\b(?:please|pls|thanks|thank you|for me|for us|real quick|if you can|okay|ok)$/i, '')
      .replace(/\s+(?:in|to|on|into)\s+(?:my\s+)?notion$/i, '');
  }
  return t.trim();
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Reads an ask without a model. Only clear phrasings count; anything vague ("can you write that down?" with nothing
 * after it) is not an ask, so nothing is ever written that the listener did not say.
 */
export function parseAskOffline(said: string): NotionAsk | undefined {
  const s = said.replace(/[“”]/g, '"').replace(/[’]/g, "'");
  let m = new RegExp(
    String.raw`\b(?:add|put|stick|throw|pop)\s+(.{1,200}?)\s+(?:to|on|onto|in|into)\s+(?:my|the|our)\s+(?:notion\s+)?(?:[\w-]+\s+){0,2}?${LIST_WORDS}\b`,
    'i',
  ).exec(s);
  if (m) {
    const isNote = /\bnotes?\b/i.test(m[0]) && !/\b(?:list|to-?dos?)\b/i.test(m[0]);
    // "add this to my notes: a song about rain": the words after the colon are the note
    const after = /^\s*[:\-–]\s*(.{2,})$/.exec(s.slice(m.index + m[0].length));
    const text = after ? capital(tidy(after[1]!)) : tidy(m[1]!.replace(/^some\s+/i, ''));
    return text.length >= 2 ? { kind: isNote ? 'note' : 'todo', text } : undefined;
  }
  m = /\bremind me\s+(?:in|on|via|through|with)\s+notion\s+to\s+(.{2,300})/i.exec(s);
  if (m) {
    const text = tidy(m[1]!);
    return text.length >= 2 ? { kind: 'todo', text: capital(text) } : undefined;
  }
  m = /\b(?:in|on|to)\s+(?:my\s+)?notion\s*[,:]?\s*(?:can you\s+|could you\s+|please\s+)?(?:add|put|write|note)\s+(?:down\s+)?(.{2,300})/i.exec(s);
  if (m) {
    const text = tidy(m[1]!);
    return text.length >= 2 ? { kind: 'todo', text } : undefined;
  }
  m = /\b(?:make a note|take a note|leave a note|note down|note that|note this|write (?:this |that |it )?down|jot (?:this |that |it )?down|save (?:this|that|an?) (?:idea|thought|note))(?:\s+(?:in|to|on)\s+(?:my\s+)?notion)?\s*(?:that\b|of\b|about\b|:|,|-|–)?\s*(.*)$/i.exec(s);
  if (m) {
    const text = tidy(m[1] ?? '');
    return text.length >= 3 ? { kind: 'note', text: capital(text) } : undefined;
  }
  return undefined;
}

const MAX = { todo: 300, note: 1000 } as const;
const significant = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/**
 * A brain's answer, checked: one of the two actions, text that is not empty, not too long, and made of the
 * listener's own words (a model must not invent what goes into someone's Notion). Anything else = no ask.
 */
export function checkAsk(raw: unknown, said: string): NotionAsk | 'none' | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.action === 'none') return 'none';
  const kind = r.action === 'add_todo' ? 'todo' : r.action === 'add_note' ? 'note' : undefined;
  if (!kind || typeof r.text !== 'string') return undefined;
  const text = tidy(r.text);
  if (text.length < 2 || text.length > MAX[kind]) return undefined;
  const heard = significant(said);
  const words = [...significant(text)];
  const shared = words.filter((w) => heard.has(w)).length;
  if (!words.length || shared / words.length < 0.5) return undefined;
  return { kind, text };
}

/** The brain's instructions: one action from a fixed set, as JSON, or none. */
export const ASK_SYSTEM = [
  "You read what a radio listener said and decide if they asked to put something in their Notion. Reply with one JSON object only, no prose:",
  '{"action": "add_todo" | "add_note" | "none", "text": string}',
  '- add_todo: they ask to add an item to a list or a task to do. text = just the item ("add oat milk to my list" -> "oat milk"; "remind me in Notion to call the plumber" -> "Call the plumber").',
  '- add_note: they ask to note, write down or save an idea or a thought. text = the note in their own words, max 200 characters.',
  '- none: anything else, including questions about their notes, or asking to change, check off, move or delete anything (that is not possible).',
  'Never add words they did not say. text has no "add", no "to my list", no "Notion".',
].join('\n');

// ---- on air ---------------------------------------------------------------------------------------------------------

const who = (w: NotionWrite) => (w.from === 'app' ? "the listener's AI assistant asked for it" : 'the listener asked for it on the call');

/** The FACTS line about what was (or was not) added. */
export function notionFact(plan: Pick<BreakPlan, 'notion'>): string {
  const w = plan.notion;
  if (!w) return '';
  if (w.ok) {
    const what = w.kind === 'todo' ? `the to-do "${w.text}"` : `the note "${w.text}"`;
    return `NOTION: you just added ${what} to the listener's Notion page "${w.pageTitle ?? 'Host-Caster'}" (${who(w)}). It is done.`;
  }
  return `NOTION: ${w.from === 'app' ? "the listener's AI assistant" : 'the listener'} asked to add "${w.text}" to their Notion, but it did not work: ${w.problem ?? 'Notion could not be reached'}. Nothing was added.`;
}

/** The sentence for the break plan. */
export function notionTask(plan: Pick<BreakPlan, 'notion' | 'kind'>): string {
  const w = plan.notion;
  if (!w) return '';
  const lead = w.from === 'app' && plan.kind !== 'callin' ? "Mention that their AI assistant asked you to add something to their Notion, and " : '';
  return w.ok
    ? `${lead}${lead ? 'c' : 'C'}onfirm the Notion note in a few words, once (like "Done, it's in your Notion."). Never read out the rest of their Notion.`
    : `${lead}${lead ? 's' : 'S'}ay kindly, in one short sentence, that it did not make it into their Notion and why.`;
}

export const NOTION_DONE_TODO = ['Done, {text} is on your list in Notion.', 'Got it. {Text} is in your Notion now.', 'Added {text} to your Notion. Done.'];
export const NOTION_DONE_NOTE = ['Done, it’s in your Notion.', 'Noted. It’s saved in your Notion.', 'Got it, that’s in your Notion now.'];
export const NOTION_APP_LEAD = ['Your assistant asked me to add something to your Notion.', 'A note came in from your assistant for your Notion.'];
export const NOTION_FAILED = ['I tried to put that in your Notion, but {problem}.', 'Sorry, that didn’t make it into your Notion: {problem}.'];

/** The scripted fallback's line (and a safe default for any host). */
export function notionSpoken(w: NotionWrite, pick: (bank: readonly string[], vars: Record<string, string>) => string, kind?: BreakPlan['kind']): string {
  const lead = w.from === 'app' && kind !== 'callin' ? `${pick(NOTION_APP_LEAD, {})} ` : '';
  if (!w.ok) return `${lead}${pick(NOTION_FAILED, { problem: w.problem ?? 'I couldn’t reach it right now' })}`;
  const short = w.text.length > 60 ? `${w.text.slice(0, 57).replace(/\s+\S*$/, '')}...` : w.text;
  return `${lead}${w.kind === 'todo' ? pick(NOTION_DONE_TODO, { text: short }) : pick(NOTION_DONE_NOTE, {})}`;
}

/** A server or network failure as something a host can say. */
export function spokenProblem(code: string | undefined): string {
  switch (code) {
    case 'notion_no_page':
      return 'no page is picked for me yet, you can pick one in Settings';
    case 'notion_writes_off':
      return 'adding notes is switched off in Settings';
    case 'notion_disconnected':
    case 'notion_not_connected':
      return 'Notion needs to be connected again in Settings';
    case 'notion_not_shared':
      return 'I can’t see that page anymore';
    case 'rate_limited':
      return 'that’s a lot of notes this hour, so try again a bit later';
    case 'not_configured':
      return 'Notion isn’t connected yet, you can connect it in Settings';
    default:
      return 'I couldn’t reach Notion just now';
  }
}
