// Follow-ups: the listener calls in (or their AI app asks) about something the hosts said: "what's that meeting
// about?", "who's coming?", "read me Dana's email", "is there a video link?", "tell me more about that story". The
// answer gets the recent breaks' items and their dossiers and may look things up live (about 20 seconds); without an
// AI brain, or when that fails, a scripted answer from the items' own fields. Specific and true to the sources; when
// something is not found, it says so.
import type { Brain, Break, CalendarEvent, ContextPacket, Dossier, EmailSummary, Headline, HeadsUp, Host, Settings } from '../types';
import { listHeadsUps } from './headsup';
import { eventSpoken } from '../radio/speakable';
import { linkedEmails, peopleWords, researchItems } from './brief';
import { runAgent } from './loop';
import { latestDossiers, lookupsOn, toolContext } from './research';
import { availableTools, runTool } from './tools';
import { db } from '../db/db';
import { cardLine, pickCards } from '../memory/brief';
import { memoryAnswer } from '../memory/search';

export interface FollowUp {
  question: string;
  /** plain spoken facts for the hosts */
  answer: string;
  /** false: the answer says it was not found */
  found: boolean;
  sources: string[];
  by: 'ai' | 'scripted';
  ms: number;
  lookups: number;
}

const ASK = /\?|^\s*(who|what|what's|whats|when|where|why|how|is|are|does|do|did|can|could|will|tell me|read me|read it|remind me|any|was|were)\b|\b(more about|details?|the link|video|zoom|meet|teams|attend|coming|agenda|about that|about the|that (meeting|event|call|story|email|message|headline|article)|who's|whos|what's in|say about)\b/i;
const NOT_A_QUESTION = /^\s*(play|put on|add|note|remember|remind me to|skip|stop|turn)\b/i;

/** Does the call ask about something (not a song request, a Notion ask or a hello)? */
export function isFollowUpQuestion(said: string): boolean {
  const s = said.trim();
  return s.length > 3 && !NOT_A_QUESTION.test(s) && ASK.test(s);
}

export interface FollowItem {
  key: string;
  kind: 'calendar' | 'email' | 'news';
  title: string;
  /** what the hosts said about it (the line, if one names it) */
  said?: string;
  event?: CalendarEvent;
  email?: EmailSummary;
  headline?: Headline;
  dossier?: Dossier;
  aired: boolean;
  /** the article behind a headline, read for this question */
  article?: string;
  /** a heads-up the hosts gave about it (what changed, what they found out) */
  headsUp?: HeadsUp;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);

/** The items of the last few breaks (newest first), then the rest of the listener's day. */
export async function followItems(packet: Pick<ContextPacket, 'calendar' | 'email' | 'news' | 'recentBreaks'>, recent: Break[] = packet.recentBreaks): Promise<FollowItem[]> {
  const out: FollowItem[] = [];
  const seen = new Set<string>();
  const heads = new Map((await listHeadsUps().catch(() => [])).map((h) => [h.id, h]));
  const add = (key: string, aired: boolean, b?: Break) => {
    if (seen.has(key)) return;
    let item: FollowItem | undefined;
    if (key.startsWith('headsup:')) {
      // "why was it cancelled?": the change, the note, and the event or mail when it is still there
      const h = heads.get(key.slice('headsup:'.length));
      if (h) {
        item = { key, kind: h.mailId ? 'email' : 'calendar', title: h.title, aired, headsUp: h, event: packet.calendar?.find((e) => e.id === h.eventId), email: packet.email?.find((m) => m.id === h.mailId) };
        if (h.eventId) seen.add(`calendar:${h.eventId}`);
        if (h.mailId) seen.add(`email:${h.mailId}`);
      }
    } else if (key.startsWith('calendar:')) {
      const e = packet.calendar?.find((x) => `calendar:${x.id}` === key);
      if (e) item = { key, kind: 'calendar', title: e.title, event: e, aired };
    } else if (key.startsWith('email:')) {
      const m = packet.email?.find((x) => `email:${x.id}` === key);
      if (m) item = { key, kind: 'email', title: m.subject, email: m, aired };
    } else if (key.startsWith('news:')) {
      const h = packet.news?.find((x) => x.id === key);
      if (h) item = { key, kind: 'news', title: h.title, headline: h, aired };
    }
    if (!item && aired && /^(calendar|email|news):/.test(key)) item = { key, kind: key.split(':')[0] as FollowItem['kind'], title: '', aired };
    if (!item) return;
    if (b) {
      const w = words(item.title).slice(0, 4);
      item.said = b.lines.map((l) => l.text).find((t) => w.some((x) => t.toLowerCase().includes(x))) ?? b.lines.map((l) => l.text).join(' ').slice(0, 300);
    }
    seen.add(key);
    out.push(item);
  };
  for (const b of recent.slice(0, 6)) for (const k of b.topics) add(k, true, b);
  for (const it of researchItems(packet)) add(it.key, false);
  const dossiers = await latestDossiers(out.map((i) => i.key));
  for (const i of out) {
    i.dossier = dossiers.get(i.key);
    if (!i.title && i.dossier) i.title = i.dossier.title;
  }
  return out.filter((i) => i.title).slice(0, 10);
}

/** The item a question is about: the one whose title it names, else the newest aired item of the kind it names. */
export function targetItem(said: string, items: FollowItem[]): FollowItem | undefined {
  const w = new Set(words(said));
  let best: FollowItem | undefined;
  let score = 0;
  for (const i of items) {
    const hits = words(`${i.title} ${i.event?.organizer ?? ''} ${i.email?.from ?? ''}`).filter((x) => w.has(x)).length;
    if (hits > score) [best, score] = [i, hits];
  }
  if (best) return best;
  const s = said.toLowerCase();
  const kind = /story|headline|article|news/.test(s) ? 'news' : /email|message|mail|wrote|said/.test(s) && !/meeting/.test(s) ? 'email' : /meeting|event|call|appointment|invite|coming|attend|agenda|link|video/.test(s) ? 'calendar' : undefined;
  return items.find((i) => i.aired && (!kind || i.kind === kind)) ?? items.find((i) => !kind || i.kind === kind);
}

const first = (t: string | undefined, n = 2) => (t ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).slice(0, n).join(' ').trim();

/** An answer from the items' own fields and dossiers (no model, no network). */
export function scriptedAnswer(said: string, items: FollowItem[], now = Date.now()): FollowUp {
  const t0 = Date.now();
  const s = said.toLowerCase();
  const it = targetItem(said, items);
  const out = (answer: string, found: boolean, sources: string[] = []): FollowUp => ({ question: said, answer, found, sources, by: 'scripted', ms: Date.now() - t0, lookups: 0 });
  if (!it) return out("I couldn't find anything about that in your calendar, email or the news we read.", false);
  const hu = it.headsUp;
  if (hu && (/why|what happened|cancel|moved|change|reason|wrote|say|what/.test(s) || !it.event)) return out(hu.note || hu.fact, true, ['The heads-up', ...(hu.note && hu.note !== hu.fact ? ['What the hosts looked up'] : [])]);
  const d = it.dossier;
  const e = it.event;
  if (e) {
    const mail = items.map((i) => i.email).filter((m): m is EmailSummary => Boolean(m));
    if (/who|coming|attend|guest|invited|going/.test(s)) {
      const who = peopleWords(e, 6) ?? d?.who?.join(', ');
      return who ? out(`For ${e.title}: ${who}.`, true, ['The calendar event']) : out(`${e.title} has no guest list in your calendar.`, false);
    }
    if (/email|message|read me|wrote|say/.test(s)) {
      const m = linkedEmails(e, mail).find((x) => x.body && !x.invite) ?? linkedEmails(e, mail)[0];
      return m ? out(`${m.from} wrote: ${first(m.body || m.snippet, 3)}`, true, [`Email from ${m.from}`]) : out(`I don't see an email about ${e.title}.`, false);
    }
    if (/link|video|zoom|meet|teams|call|join/.test(s)) {
      return e.video ? out(`Yes, ${e.title} has a ${e.video.provider} link. It's in the event in your calendar.`, true, ['The calendar event']) : out(`${e.title} has no video call link in your calendar.`, false);
    }
    if (/where/.test(s)) return e.location ? out(`${e.title} is at ${e.location}.`, true) : out(`${e.title} has no place set.`, false);
    if (/when|what time/.test(s)) return out(`${eventSpoken(e, now)}.`, true);
    const about = d?.about || first(e.description, 3);
    return about ? out(`${e.title}: ${about}`, true, d?.sources ?? ['The calendar event']) : out(`${e.title} has no description in your calendar.`, false);
  }
  if (it.email) {
    const m = it.email;
    const text = first(m.body || m.snippet, 3);
    return text ? out(`${m.from} wrote: ${text}`, true, ['The email']) : out(`It's a message from ${m.from} about ${m.subject}.`, true);
  }
  if (it.headline || d) {
    const about = d?.by === 'ai' ? d.about : '';
    return about ? out(about, true, d?.sources ?? []) : out(`All I have is the headline: ${it.title}.`, false, ['The headline']);
  }
  return out("I couldn't find more on that.", false);
}

function itemLine(i: FollowItem, n: number, now: number): string {
  const bits: string[] = [`${n}. [${i.key}] ${i.kind.toUpperCase()}: ${i.title}`];
  if (i.event) bits.push(`(${eventSpoken(i.event, now)})`);
  if (i.email) bits.push(`(from ${i.email.from})`);
  if (i.headline) bits.push(`(${i.headline.source})`);
  if (i.said) bits.push(`\n   The hosts said: "${i.said.slice(0, 220)}"`);
  const h = i.headsUp;
  if (h) bits.push(`\n   Heads-up (${h.kind}): ${h.fact}${h.source ? ` The calendar's notice says: ${h.source}` : ''}${h.note && !h.note.startsWith(h.fact) ? ` What the hosts found out: ${h.note}` : ''}${h.eventId ? ` (event id ${h.eventId})` : ''}${h.mailId ? ` (email id ${h.mailId})` : ''}`);
  if (i.headline && !i.article && i.dossier?.by !== 'ai') bits.push(`\n   (Only the headline is known: news_article with id ${i.key} reads the article.)`);
  if (i.article) bits.push(`\n   The article says: ${i.article}`);
  const d = i.dossier;
  if (d) bits.push(`\n   Notes: ${d.about}${d.who?.length ? ` Who: ${d.who.join(', ')}.` : ''}${d.prepare?.length ? ` Prepare: ${d.prepare.join('; ')}.` : ''}`);
  if (i.event) {
    const e = i.event;
    const facts = [
      e.description && `description: ${e.description.slice(0, 300)}`,
      peopleWords(e, 8) && `guests: ${peopleWords(e, 8)}`,
      e.video && `video call: ${e.video.provider}`,
      e.location && `place: ${e.location}`,
      e.invitation && 'the listener has not answered the invitation',
    ].filter(Boolean);
    if (facts.length) bits.push(`\n   Event: ${facts.join('; ')}`);
  }
  if (i.email?.body) bits.push(`\n   Email text: ${i.email.body.slice(0, 400)}`);
  return bits.join(' ');
}

/** The article's text from a news_article answer; a long one comes back cut ("...(cut)"), no longer valid JSON. */
export function articleText(content: string): string {
  try {
    const page = JSON.parse(content) as { text?: string; description?: string };
    return String(page.text || page.description || '');
  } catch {
    const m = /"(?:text|description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(content);
    if (!m) return '';
    const raw = m[1]!.replace(/\\u?[0-9a-fA-F]{0,3}$|\\$/, '');
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw.replace(/\\n/g, ' ').replace(/\\"/g, '"');
    }
  }
}

export function followUpPrompt(hostName: string, said: string, items: FollowItem[], now: number, memory: string[] = []): { system: string; user: string } {
  const system = [
    `You are ${hostName}, live on the radio. Your listener just called in with a question about something the hosts talked about, or about their day.`,
    'Find the real answer. Use the ITEMS first; look things up when they do not have it (the event in full, the email or its thread, the article behind a headline, the shared notes, what you remember about the listener and what they said on the radio lately).',
    'WHAT YOU REMEMBER is what the listener told you before (it may be out of date); use it when the question is about it.',
    'Answer in one to four short plain sentences, specific and true to the sources: names, times, what it says. If you cannot find it, say so plainly; never guess.',
    'Never read out web links, email addresses, phone numbers or codes: say "there is a Google Meet link" instead.',
    'This is spoken: no lists, no markdown. Your final answer is only what you would tell the listener, no labels.',
  ].join('\n');
  const user = [
    `THE LISTENER ASKED: "${said}"`,
    `NOW: ${new Date(now).toString().slice(0, 21)}`,
    `ITEMS (the ones on air most recently first):\n${items.map((i, n) => itemLine(i, n + 1, now)).join('\n') || '(none)'}`,
    ...(memory.length ? [`WHAT YOU REMEMBER ABOUT THE LISTENER:\n${memory.join('\n')}`] : []),
  ].join('\n\n');
  return { system, user };
}

export interface FollowUpInput {
  said: string;
  packet: ContextPacket;
  hosts: Host[];
  brains: Map<string, Brain>;
  settings: Settings;
  /** epoch ms; at most ~20 s from now */
  deadline: number;
  signal?: AbortSignal;
  /** a lookup started: the radio may air "one sec, pulling that up" */
  onLookup?: () => void;
}

/** Answers a follow-up question, or undefined when the call is not one. */
export async function answerFollowUp(input: FollowUpInput): Promise<FollowUp | undefined> {
  const { said, packet } = input;
  if (!isFollowUpQuestion(said)) return undefined;
  const items = await followItems(packet);
  const now = Date.now();
  const lead = input.hosts.find((h) => h.brainId && input.brains.has(h.brainId));
  const brain = lead?.brainId ? input.brains.get(lead.brainId) : undefined;
  // what the listener told the hosts before ("what's happening next weekend?")
  const cards = await db.memories.toArray().catch(() => []);
  const memory = pickCards(cards, { topics: '', callIn: said, now, max: 5, budget: 500 }).map(cardLine);
  const scripted = async () => {
    const a = scriptedAnswer(said, items, now);
    if (a.found) return a;
    const m = await memoryAnswer(said, now).catch(() => undefined);
    return m ? { ...a, answer: m.answer, found: true, sources: ['What your hosts remember'] } : a;
  };
  if (!lead || !brain || !lookupsOn(input.settings, brain)) return scripted();
  const t0 = Date.now();
  try {
    const headlines = items.map((i) => i.headline).filter((h): h is Headline => Boolean(h));
    const ctx = await toolContext(input.settings, { news: headlines.length ? headlines : packet.news }, lead, 'call-in');
    const tools = await availableTools({ connections: input.settings.connections, headlines: ctx.headlines });
    // "tell me more about that story": every model needs the article, so it is read first (small models skip it)
    let pre = 0;
    const story = targetItem(said, items);
    if (story?.headline?.url && story.dossier?.by !== 'ai' && /more|story|article|headline|happen|detail|what about|explain/i.test(said) && tools.includes('news_article')) {
      input.onLookup?.();
      const r = await runTool('news_article', { id: story.key }, ctx, input.signal);
      pre = 1;
      if (r.ok) story.article = articleText(r.content).replace(/\s+/g, ' ').slice(0, 1800);
    }
    const { system, user } = followUpPrompt(lead.name, said, items, now, memory);
    // the article is in the question already: no second read of it
    const offered = story?.article ? tools.filter((t) => t !== 'news_article' && t !== 'open_link') : tools;
    let told = pre > 0;
    const res = await runAgent({
      brain,
      system,
      user,
      tools: offered,
      ctx,
      maxSteps: 4,
      maxCalls: 4,
      deadline: Math.min(input.deadline, now + 22_000),
      signal: input.signal,
      answer: 'text',
      maxTokens: 400,
      onLookup: () => {
        if (!told) input.onLookup?.();
        told = true;
      },
    });
    const answer = res.text.replace(/\s+/g, ' ').trim();
    if (!answer) return scripted();
    const notFound = /\b(couldn'?t|could not|can'?t|cannot|didn'?t|don'?t|no) (find|see|have)\b/i.test(answer);
    const sources = [...(story?.article ? [`News article: ${story.title}`] : []), ...res.calls.filter((c) => c.ok).map((c) => c.what)];
    return { question: said, answer: answer.slice(0, 700), found: !notFound, sources, by: 'ai', ms: Date.now() - t0, lookups: res.calls.length + pre };
  } catch (err) {
    // out of time, the brain failed: the facts at hand still answer
    if (input.signal?.aborted) throw err;
    return scripted();
  }
}
