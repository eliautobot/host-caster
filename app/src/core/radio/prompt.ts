// Prompts for AI hosts. The radio voice: short spoken sentences, facts only from the packet, natural song intros
// and outros, hosts talking to each other, persona + avoid list, no repeats of recent breaks.
import type { BreakLine, ContextPacket, Host, Station, TalkLength } from '../types';
import { emailDetailFacts, eventDetailFacts, newsDetailFacts } from '../agent/brief';
import { lifeEventInfo } from '../context/life';
import { notionFact, notionTask } from './notionAsk';
import { memoryFact, memoryTask } from '../memory/commands';
import { actionFact, actionTask } from '../actions/callin';
import { MEMORY_RULE, memorySheet } from '../memory/brief';
import { LIST_RULE, listSheet } from '../tracker/brief';
import { DAY_SEGMENTS, factFor, noteKey, requestIsNext, type BreakPlan } from './planner';
import { emailSpoken, eventSpoken, fitsPartOfDay, PART_OF_DAY_WORDS, weatherSpoken, whenSpoken } from './speakable';
import { TIME_SLOT } from './airtime';

const LEVEL = ['very low', 'low', 'medium', 'high', 'very high'];
const VERBOSE = ['one short sentence', 'one or two short sentences', 'two short sentences', 'two or three sentences', 'up to three sentences'];
const WORDS: Record<TalkLength, number> = { short: 28, normal: 40, long: 50 };

const q = (s: string) => `"${s}"`;

export function songLabel(s: { title: string; artist: string } | undefined): string | undefined {
  if (!s) return undefined;
  return s.artist ? `${q(s.title)} by ${s.artist}` : q(s.title);
}

export function hostCard(h: Host, role: 'lead' | 'co-host'): string {
  const bits = [
    `${h.name} (${role})${h.tagline ? `, "${h.tagline}"` : ''}.`,
    h.personality && `Who: ${h.personality.trim()}`,
    h.style && `Voice: ${h.style.trim()}`,
    `Energy ${LEVEL[h.energy - 1]}, humor ${LEVEL[h.humor - 1]}. Each line: ${VERBOSE[h.verbosity - 1]}.`,
    h.topics.length ? `Loves talking about: ${h.topics.join(', ')}.` : '',
    h.catchphrases.length ? `Catchphrases (at most one per break, only when it fits, worked into a sentence, never in quotes): ${h.catchphrases.join(' / ')}.` : '',
    h.avoid.length ? `${h.name} never talks about: ${h.avoid.join(', ')}.` : '',
    h.language && !h.language.startsWith('en') ? `${h.name} speaks ${h.language}.` : '',
  ];
  return '- ' + bits.filter(Boolean).join(' ');
}

const PERSONAL = new Set(['calendar', 'reminders', 'email', 'notes', 'lifeEvents', 'inbox', 'headsUp']);

/** How much the songs get at each talk mix step (core/radio/planner.ts). */
const MIX_SONGS = [
  'This is a music-first show: the songs are the main thing to talk about.',
  '',
  'Keep the song talk short: the listener tuned in for their day as much as the music.',
  "Keep the song talk to one short sentence (title and artist); spend the rest of the break on the listener's day.",
  "The listener's day comes first: the song gets one short sentence, title and artist only.",
];

const RULES = (packet: ContextPacket, words: number, plan?: BreakPlan) =>
  [
    'This is spoken audio, read aloud by a voice engine. Write how people talk on the radio: short sentences, contractions, natural rhythm.',
    'No markdown, no emojis, no lists, no hashtags, no stage directions, no sound effects, no (laughs) or *actions*.',
    'Use only the facts in FACTS. Never invent times, dates, weather, events, messages, headlines, chart positions or song trivia. If something is not in FACTS, do not mention it.',
    plan && !plan.items.some((i) => PERSONAL.has(i.segment))
      ? packet.memory?.facts.length
        ? 'Apart from WHAT YOU KNOW ABOUT THE LISTENER, FACTS has nothing about the listener\'s plans: do not invent reminders, appointments, plans, messages or family.'
        : 'FACTS has nothing about the listener\'s plans: do not mention reminders, appointments, plans, messages, family or anything else in their life.'
      : '',
    packet.memory?.facts.length || packet.memory?.recently.length ? MEMORY_RULE : '',
    packet.tracker?.lines.length ? LIST_RULE : '',
    'Say numbers the way a person would, in words.',
    plan?.items.some((i) => i.segment === 'time')
      ? `Never say the clock time yourself: only the last line says it, written exactly as ${TIME_SLOT} (the real time is put in on air). Times of events and reminders from FACTS are fine.`
      : 'Never say what time it is now (times of events and reminders from FACTS are fine).',
    plan?.items.some((i) => PERSONAL.has(i.segment))
      ? "The calendar, reminders, email and notes in FACTS belong to the listener, not to the hosts: tell the listener about them (\"you have...\")."
      : '',
    'Name songs only with the exact titles and artists in JUST PLAYED, UP NEXT or PLAYING NOW. Never name any other song or artist.',
    'Email: say only who it is from and the gist in a few words. Never read addresses, numbers, codes or private details.',
    plan?.items.some((i) => i.segment === 'calendar' || i.segment === 'email')
      ? 'WHAT IT IS ABOUT, WHO, ALSO, TO PREPARE and RELATED EMAIL are true details: work in the one or two that matter most, in your own words. Never read out links, addresses or codes.'
      : '',
    'When there are two or more hosts, they talk to each other by name, react to what was just said and hand off naturally, like a real morning show.',
    `Talk to one listener${packet.listener.callMe ? `, ${packet.listener.callMe}` : ''}, warmly. Use their name at most once per break.`,
    'Do not repeat lines, jokes or openers from RECENT BREAKS, and never take facts from them: their times are out of date. Facts come only from FACTS. Sound fresh every time.',
    `Keep every line under ${words} words.`,
    'Say each fact once per break: never repeat what another host already said.',
    'Never open or close a break with the same words as a recent break.',
  ]
    .filter(Boolean)
    .map((r) => `- ${r}`)
    .join('\n');

const dossierOf = (packet: ContextPacket, key: string) => packet.dossiers?.find((d) => d.key === key);

function topicFacts(plan: BreakPlan, packet: ContextPacket, now: number): string[] {
  const out: string[] = [];
  for (const item of plan.items) {
    switch (item.segment) {
      case 'time':
        out.push(
          `TIME CHECK: the LAST line of the break gives the time, written exactly as ${TIME_SLOT} (the real time is put in on air), in that host's own words, e.g. "It's ${TIME_SLOT} on this ${packet.now.weekday} ${PART_OF_DAY_WORDS[packet.now.partOfDay]}"${plan.intro ? ', then the hand-off to the next song' : ''}. ${TIME_SLOT} appears once in the whole break; no other line mentions the clock time.`,
        );
        break;
      case 'headsUp': {
        const h = packet.headsUps?.find((x) => `headsup:${x.id}` === item.key);
        if (h)
          out.push(
            `HEADS-UP (it just changed: open the break with it, plainly, like "Quick heads-up: ..."): ${h.fact}${h.start && h.kind !== 'cancelled' ? ` It starts ${whenSpoken(h.start, now)}.` : ''}${h.note && !h.note.startsWith(h.fact) ? ` What the hosts found out: ${h.note}` : ''}`,
          );
        break;
      }
      case 'weather':
        if (packet.weather) out.push(`WEATHER: ${weatherSpoken(packet.weather)}.`);
        break;
      case 'calendar': {
        const e = packet.calendar?.find((x) => `calendar:${x.id}` === item.key);
        if (e) out.push(`CALENDAR: ${eventSpoken(e, now)}${e.location ? ` (at ${e.location})` : ''}.`);
        // what it is about and who is in it (a rundown keeps to one detail line per event)
        if (e) out.push(...eventDetailFacts(e, packet.email, dossierOf(packet, item.key)).slice(0, plan.rundown ? 1 : 4));
        if (plan.rundown || item !== plan.items.find((i) => i.segment === 'calendar')) break;
        const more = (packet.calendar ?? []).filter((x) => x !== e).slice(0, 2);
        if (more.length) out.push(`ALSO ON THE CALENDAR (only if it fits): ${more.map((x) => eventSpoken(x, now)).join('; ')}.`);
        break;
      }
      case 'email': {
        const m = packet.email?.find((x) => `email:${x.id}` === item.key);
        if (m) out.push(`EMAIL: ${emailSpoken(m)}${m.important ? ' (marked important)' : ''}.`, ...emailDetailFacts(m, dossierOf(packet, item.key)).slice(0, plan.rundown ? 1 : 3));
        break;
      }
      case 'news': {
        const h = packet.news?.find((x) => x.id === item.key);
        const more = h ? newsDetailFacts(dossierOf(packet, item.key)) : [];
        if (h) out.push(`NEWS HEADLINE from ${h.source}: ${q(h.title)}. Mention it in one or two sentences; ${more.length ? 'add only details from WHAT THE ARTICLE SAYS' : 'do not add details'}.`, ...more.slice(0, plan.rundown ? 0 : 1));
        break;
      }
      case 'lifeEvents': {
        const e = packet.lifeEvents?.find((x) => `lifeEvents:${x.id}` === item.key);
        const info = e && lifeEventInfo(e, now);
        if (info)
          out.push(
            `LIFE EVENT the listener saved: ${q(e!.title)} is ${info.when}${info.years ? ` (${info.years} years)` : ''}${e!.notes ? `. Note: ${e!.notes}` : ''}. Tell the listener about it; a name in it may be someone they know, not the listener.`,
          );
        break;
      }
      case 'notes': {
        const n = packet.notes?.find((x) => noteKey(x) === item.key);
        if (n) out.push(`NOTE the listener left for the hosts: ${q(n)}.`);
        break;
      }
      case 'reminders': {
        const r = packet.reminders?.find((x) => `reminders:${x.id}` === item.key);
        if (r) out.push(`REMINDER for the listener: ${r.text}, ${whenSpoken(r.at, now)}.`);
        break;
      }
      case 'funFacts': {
        const f = factFor(plan);
        if (f) out.push(`FUN FACT (true, you may share it): ${f}`);
        break;
      }
      case 'inbox': {
        const i = packet.inbox?.find((x) => `inbox:${x.id}` === item.key);
        const a = i && packet.inboxAnswers?.[i.id];
        if (i && a) out.push(`QUESTION from the listener's AI assistant: ${q(i.text)}. ANSWER (${a.found ? 'checked in their own data and lookups' : 'looked for, not found'}): ${a.answer} Tell the listener the answer plainly; add nothing that is not in it.`);
        else if (i) out.push(i.kind === 'segment' ? `SEGMENT to air${i.hostName ? ` (by ${i.hostName})` : ''}: ${i.text}` : `NOTE from the listener's AI assistant: ${i.text}`);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Where a found request is named, once per break (live QA: a call-in named it in lines 1 and 4). */
function requestPlace(plan: BreakPlan, packet: ContextPacket): string {
  if (requestIsNext(plan, packet)) return 'in the last line, as the next song';
  return plan.kind === 'callin' ? 'in your answer to the call' : 'at the end of the break';
}

/** The FACTS sheet: songs, time, listener and the facts for the chosen topics. */
export function factsSheet(plan: BreakPlan, packet: ContextPacket, station: Station, now = Date.parse(packet.now.iso)): string {
  const L = packet.listener;
  const lines = [
    `STATION: ${station.name}, ${station.frequency} FM.`,
    `NOW: ${packet.now.weekday} ${PART_OF_DAY_WORDS[packet.now.partOfDay]}.`,
    L.callMe || L.about || L.interests.length
      ? `LISTENER: ${[L.callMe && `call them ${L.callMe}`, L.about, L.interests.length && `Interests: ${L.interests.join(', ')}`].filter(Boolean).join('. ')}.`
      : '',
    plan.outro && packet.songBefore ? `JUST PLAYED: ${songLabel(packet.songBefore)}.` : '',
    plan.intro && packet.songAfter && !requestIsNext(plan, packet) ? `UP NEXT: ${songLabel(packet.songAfter)}.` : '',
    (plan.kind === 'callin' || plan.kind === 'stream') && packet.songBefore ? `PLAYING NOW, quietly under your voices: ${songLabel(packet.songBefore)}.` : '',
    plan.request?.found
      ? `SONG REQUEST ${plan.requestFrom === 'app' ? "from the listener's AI assistant" : 'from the listener'}: ${songLabel(plan.request.found)}. It plays ${plan.kind === 'callin' ? 'after the song that is on now' : 'right after this break'}. Name it ONCE in the whole break, ${requestPlace(plan, packet)}; never name it twice.`
      : plan.request
        ? `SONG REQUEST ${plan.requestFrom === 'app' ? "from the listener's AI assistant" : 'from the listener'}: ${q(plan.request.query)}. It is NOT in their music library, so it cannot play. Say so kindly; they can add it to their library.`
        : '',
    notionFact(plan),
    memoryFact(plan.memory),
    actionFact(plan.action),
    plan.followUp
      ? `ANSWER TO THE LISTENER'S QUESTION (${plan.followUp.found ? 'checked in their own calendar, email, notes and lookups' : 'it was looked for and not found'}): ${plan.followUp.answer}`
      : '',
    ...topicFacts(plan, packet, now),
    memorySheet(packet.memory),
    listSheet(packet.tracker),
  ];
  return lines.filter(Boolean).join('\n');
}

const plain = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Catchphrases already heard in the last few breaks are left out of the host card, so a small model cannot say the
 * same one every break.
 */
export function freshHosts(hosts: Host[], packet: ContextPacket): Host[] {
  const heard = plain(packet.recentBreaks.slice(0, 3).flatMap((b) => b.lines.map((l) => l.text)).join(' '));
  return hosts.map((h) => {
    const fresh = h.catchphrases.filter((c) => !heard.includes(plain(c)) && fitsPartOfDay(c, packet.now.partOfDay));
    return fresh.length === h.catchphrases.length ? h : { ...h, catchphrases: fresh };
  });
}

function avoidList(hosts: Host[], packet: ContextPacket): string[] {
  return [...new Set([...packet.listener.avoid, ...hosts.flatMap((h) => h.avoid)].map((s) => s.trim()).filter(Boolean))];
}

function recentSheet(packet: ContextPacket, hosts: Host[]): string {
  const names = new Map(hosts.map((h) => [h.id, h.name]));
  // the openers and the song intros are what repeats most; the rest of a break holds its facts, and a small model
  // reads those back later with times that are out of date ("the stand-up in eight minutes", an hour on): only the
  // opening sentence and the closing one are shown
  const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean);
  const lines = packet.recentBreaks.slice(0, 3).flatMap((b) => {
    const first = b.lines[0];
    const last = b.lines.length > 1 ? b.lines[b.lines.length - 1] : undefined;
    return [
      first && `${names.get(first.hostId) ?? 'Host'}: ${(sentences(first.text)[0] ?? '').slice(0, 140)}`,
      last && `${names.get(last.hostId) ?? 'Host'}: ${(sentences(last.text).at(-1) ?? '').slice(0, 140)}`,
    ].filter((x): x is string => Boolean(x));
  });
  return lines.length ? lines.join('\n') : '(none yet: this is the first break of the show)';
}

function task(plan: BreakPlan, hosts: Host[], packet: ContextPacket): string {
  const parts: string[] = [];
  const found = plan.request?.found;
  const next = requestIsNext(plan, packet);
  if (plan.kind === 'opening') parts.push('This is the first break of the show: welcome the listener and say the station name once.');
  if (plan.items.some((i) => i.segment === 'headsUp')) parts.push('Open the break with the HEADS-UP, before anything else (even before the song that just played).');
  if (plan.rundown) {
    parts.push(
      `${plan.kind === 'opening' ? 'Then give' : 'This is the top-of-the-hour rundown: give'} a quick rundown of the listener's day from FACTS, in this order: ${plan.items.filter((i) => i.segment !== 'time' && i.segment !== 'headsUp').map((i) => i.segment).join(', ')}. One short sentence per item, soonest first.`,
    );
  }
  if (plan.callIn) {
    const answer = found ? (next ? ' Say yes to their request, but keep its name for the last line.' : ' Say yes and name their song, once.') : '';
    parts.push(
      plan.followUp
        ? `The listener just called in and asked: ${q(plan.callIn)}. Answer them on air first with ANSWER TO THE LISTENER'S QUESTION: plainly and completely, in your own words, adding nothing that is not in it.${plan.followUp.found ? '' : ' Say kindly that you could not find it.'}`
        : `The listener just called in and said: ${q(plan.callIn)}. Answer them on air first, warmly and directly.${answer} If they ask for something you cannot do, say so kindly.`,
    );
  }
  if (plan.notion) parts.push(notionTask(plan));
  if (plan.memory) parts.push(memoryTask(plan.memory));
  if (plan.action) parts.push(actionTask(plan.action));
  if (plan.outro) parts.push(plan.mix >= 2 ? 'Name what just played (title and artist) in a few words.' : 'Say what just played (title and artist), the way a DJ does after a song.');
  const topics = plan.items.filter((i) => i.segment !== 'time' && i.segment !== 'headsUp');
  if (topics.length && !plan.rundown) {
    const day = topics.some((i) => DAY_SEGMENTS.has(i.segment));
    parts.push(`Then talk about: ${topics.map((i) => i.segment).join(', ')} (use the matching FACTS)${day && plan.mix >= 2 ? '; this is the heart of the break' : ''}.`);
  }
  if (plan.mix >= 2 && (plan.intro || plan.outro)) parts.push(MIX_SONGS[plan.mix]!);
  else if (plan.mix === 0 && plan.intro) parts.push(MIX_SONGS[0]!);
  if (found && !plan.intro && plan.kind !== 'callin') parts.push('End by introducing their request, so it can start right after this break.');
  else if (plan.intro) parts.push(next ? 'End by introducing their request as the next song, so it can start right after the last line.' : 'End by introducing the next song, so it can start right after the last line.');
  else if (plan.kind === 'callin') parts.push(found ? 'Then hand back to the music (their song was already named: do not name it again).' : 'Then hand back to the music.');
  if (plan.items.some((i) => i.segment === 'time')) parts.push(`The last line gives the time check with ${TIME_SLOT} (see TIME CHECK)${plan.intro ? ' and then introduces the next song' : ''}.`);
  if (hosts.length > 1) parts.push(`${hosts[0]!.name} opens. Every host speaks at least once.`);
  return parts.join(' ');
}

export interface Prompt {
  system: string;
  user: string;
}

/** One call writes the whole break as JSON lines (all hosts share one brain). */
export function buildScriptPrompt(station: Station, lineup: Host[], plan: BreakPlan, packet: ContextPacket): Prompt {
  const hosts = freshHosts(lineup, packet);
  const avoid = avoidList(hosts, packet);
  const example = hosts.slice(0, 2).map((h) => `{"host":"${h.name}","text":"..."}`).join(',');
  const system = [
    `You write the spoken script for a live break on the music radio station ${station.name} (${station.frequency} FM).`,
    `HOSTS:\n${hosts.map((h, i) => hostCard(h, i === 0 ? 'lead' : 'co-host')).join('\n')}`,
    `RULES:\n${RULES(packet, WORDS[station.talkLength], plan)}`,
    avoid.length ? `NEVER MENTION: ${avoid.join(', ')}.` : '',
    `OUTPUT: JSON only, exactly ${plan.lines} lines in total, in this shape: {"lines":[${example}]}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const user = [
    `FACTS:\n${factsSheet(plan, packet, station)}`,
    `RECENT BREAKS (already on air, out of date: do not repeat them or reuse their facts):\n${recentSheet(packet, hosts)}`,
    `TASK: Write ${plan.lines} lines. ${task(plan, hosts, packet)}`,
  ].join('\n\n');
  return { system, user };
}

/** Turn by turn: one host's next line, with the transcript so far (each host thinks with its own brain). */
export function buildTurnPrompt(
  station: Station,
  hosts: Host[],
  speaker: Host,
  plan: BreakPlan,
  packet: ContextPacket,
  transcript: BreakLine[],
  turn: number,
): Prompt {
  speaker = freshHosts([speaker], packet)[0]!;
  const avoid = avoidList([speaker], packet);
  const others = hosts.filter((h) => h.id !== speaker.id);
  const names = new Map(hosts.map((h) => [h.id, h.name]));
  const system = [
    `You are ${speaker.name}, a host on the music radio station ${station.name} (${station.frequency} FM), live on air.`,
    hostCard(speaker, speaker.id === hosts[0]?.id ? 'lead' : 'co-host'),
    others.length ? `On the mic with you: ${others.map((h) => `${h.name} (${h.tagline || 'co-host'})`).join(', ')}.` : '',
    `RULES:\n${RULES(packet, WORDS[station.talkLength], plan)}`,
    avoid.length ? `NEVER MENTION: ${avoid.join(', ')}.` : '',
    `OUTPUT: only the words ${speaker.name} says next, nothing else (no name label, no quotes).`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const last = turn === plan.lines - 1;
  const said = transcript.map((l) => `${names.get(l.hostId) ?? 'Host'}: ${l.text}`).join('\n');
  const user = [
    `FACTS:\n${factsSheet(plan, packet, station)}`,
    `RECENT BREAKS (already on air, out of date: do not repeat them or reuse their facts):\n${recentSheet(packet, hosts)}`,
    `THE BREAK PLAN: ${task(plan, hosts, packet)}`,
    said ? `SO FAR IN THIS BREAK:\n${said}` : 'You open the break.',
    `Write line ${turn + 1} of ${plan.lines}${last ? ' (the last line' + (plan.intro ? ': introduce the next song' : '') + ')' : ''}. Reply to what was just said if anything was.${requestTurnNote(plan, packet, turn, last)}${timeTurnNote(plan, last)}`,
  ].join('\n\n');
  return { system, user };
}

/** Turn by turn: the time-teller speaks last, the others never say the clock. */
function timeTurnNote(plan: BreakPlan, last: boolean): string {
  if (!plan.items.some((i) => i.segment === 'time')) return '';
  return last ? ` You give the time check here: write ${TIME_SLOT} where the time goes (it is put in on air), once.` : ' Do not say the time (the last line does).';
}

/** Turn by turn, each host only sees its own line: say where the request's name goes so it is said once. */
function requestTurnNote(plan: BreakPlan, packet: ContextPacket, turn: number, last: boolean): string {
  if (!plan.request?.found) return '';
  const atEnd = requestIsNext(plan, packet) || plan.kind !== 'callin';
  if (atEnd) return last ? ' Name their requested song here (the only time in this break).' : ' Do not name the requested song in this line (the last line does).';
  return turn === 0 ? ' Name their requested song here, once.' : ' Their requested song was already named: do not name it again.';
}

/** Rough token budget for a script of `lines` lines. */
export function scriptMaxTokens(lines: number, talkLength: TalkLength): number {
  return Math.min(1600, 120 + lines * (WORDS[talkLength] * 2 + 20));
}
