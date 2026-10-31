// Prompts for AI hosts. The radio voice: short spoken sentences, facts only from the packet, natural song intros
// and outros, hosts talking to each other, persona + avoid list, no repeats of recent breaks.
import type { BreakLine, ContextPacket, Host, Station, TalkLength } from '../types';
import { lifeEventInfo } from '../context/life';
import { factFor, noteKey, requestIsNext, type BreakPlan } from './planner';
import { clockTime, emailSpoken, eventSpoken, fitsPartOfDay, PART_OF_DAY_WORDS, spokenTime, weatherSpoken, whenSpoken } from './speakable';

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

const PERSONAL = new Set(['calendar', 'reminders', 'email', 'notes', 'lifeEvents', 'inbox']);

const RULES = (packet: ContextPacket, words: number, plan?: BreakPlan) =>
  [
    'This is spoken audio, read aloud by a voice engine. Write how people talk on the radio: short sentences, contractions, natural rhythm.',
    'No markdown, no emojis, no lists, no hashtags, no stage directions, no sound effects, no (laughs) or *actions*.',
    'Use only the facts in FACTS. Never invent times, dates, weather, events, messages, headlines, chart positions or song trivia. If something is not in FACTS, do not mention it.',
    plan && !plan.items.some((i) => PERSONAL.has(i.segment))
      ? 'FACTS has nothing about the listener\'s plans: do not mention reminders, appointments, plans, messages, family or anything else in their life.'
      : '',
    'Say numbers the way a person would, in words. Say the time at most once and only with the SAY THE TIME AS wording from FACTS; never guess or round a time.',
    plan?.items.some((i) => PERSONAL.has(i.segment))
      ? "The calendar, reminders, email and notes in FACTS belong to the listener, not to the hosts: tell the listener about them (\"you have...\")."
      : '',
    'Name songs only with the exact titles and artists in JUST PLAYED, UP NEXT or PLAYING NOW. Never name any other song or artist.',
    'Email: say only who it is from and the gist in a few words. Never read addresses, numbers, codes or private details.',
    'When there are two or more hosts, they talk to each other by name, react to what was just said and hand off naturally, like a real morning show.',
    `Talk to one listener${packet.listener.callMe ? `, ${packet.listener.callMe}` : ''}, warmly. Use their name at most once per break.`,
    'Do not repeat lines, jokes or openers from RECENT BREAKS. Sound fresh every time.',
    `Keep every line under ${words} words.`,
    'Say each fact once per break: never repeat what another host already said.',
    'Never open or close a break with the same words as a recent break.',
  ]
    .filter(Boolean)
    .map((r) => `- ${r}`)
    .join('\n');

function topicFacts(plan: BreakPlan, packet: ContextPacket, now: number): string[] {
  const out: string[] = [];
  for (const item of plan.items) {
    switch (item.segment) {
      case 'time':
        out.push(`TIME: tell the listener the time (${q(spokenTime(now))}) and that it is ${packet.now.weekday} ${PART_OF_DAY_WORDS[packet.now.partOfDay]}.`);
        break;
      case 'weather':
        if (packet.weather) out.push(`WEATHER: ${weatherSpoken(packet.weather)}.`);
        break;
      case 'calendar': {
        const e = packet.calendar?.find((x) => `calendar:${x.id}` === item.key);
        if (e) out.push(`CALENDAR: ${eventSpoken(e, now)}${e.location ? ` (at ${e.location})` : ''}.`);
        const more = (packet.calendar ?? []).filter((x) => x !== e).slice(0, 2);
        if (more.length) out.push(`ALSO ON THE CALENDAR (only if it fits): ${more.map((x) => eventSpoken(x, now)).join('; ')}.`);
        break;
      }
      case 'email': {
        const m = packet.email?.find((x) => `email:${x.id}` === item.key);
        if (m) out.push(`EMAIL: ${emailSpoken(m)}${m.important ? ' (marked important)' : ''}.`);
        break;
      }
      case 'news': {
        const h = packet.news?.find((x) => x.id === item.key);
        if (h) out.push(`NEWS HEADLINE from ${h.source}: ${q(h.title)}. Mention it in one or two sentences; do not add details.`);
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
        if (i) out.push(i.kind === 'segment' ? `SEGMENT to air${i.hostName ? ` (by ${i.hostName})` : ''}: ${i.text}` : `NOTE from the listener's AI assistant: ${i.text}`);
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
    `NOW: ${packet.now.weekday} ${PART_OF_DAY_WORDS[packet.now.partOfDay]}, ${clockTime(now)}. SAY THE TIME AS: ${q(spokenTime(now))}.`,
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
    ...topicFacts(plan, packet, now),
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
  // whole breaks (the openers and the song intros are what repeats most), newest first
  const lines = packet.recentBreaks
    .slice(0, 3)
    .flatMap((b) => b.lines.slice(0, 6).map((l) => `${names.get(l.hostId) ?? 'Host'}: ${l.text.slice(0, 160)}`));
  return lines.length ? lines.join('\n') : '(none yet: this is the first break of the show)';
}

function task(plan: BreakPlan, hosts: Host[], packet: ContextPacket): string {
  const parts: string[] = [];
  const found = plan.request?.found;
  const next = requestIsNext(plan, packet);
  if (plan.kind === 'opening') parts.push('This is the first break of the show: welcome the listener and say the station name once.');
  if (plan.callIn) {
    const answer = found ? (next ? ' Say yes to their request, but keep its name for the last line.' : ' Say yes and name their song, once.') : '';
    parts.push(`The listener just called in and said: ${q(plan.callIn)}. Answer them on air first, warmly and directly.${answer} If they ask for something you cannot do, say so kindly.`);
  }
  if (plan.outro) parts.push('Say what just played (title and artist), the way a DJ does after a song.');
  if (plan.items.length) parts.push(`Then talk about: ${plan.items.map((i) => i.segment).join(', ')} (use the matching FACTS).`);
  if (found && !plan.intro && plan.kind !== 'callin') parts.push('End by introducing their request, so it can start right after this break.');
  else if (plan.intro) parts.push(next ? 'End by introducing their request as the next song, so it can start right after the last line.' : 'End by introducing the next song, so it can start right after the last line.');
  else if (plan.kind === 'callin') parts.push(found ? 'Then hand back to the music (their song was already named: do not name it again).' : 'Then hand back to the music.');
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
    `RECENT BREAKS (do not repeat):\n${recentSheet(packet, hosts)}`,
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
    `RECENT BREAKS (do not repeat):\n${recentSheet(packet, hosts)}`,
    `THE BREAK PLAN: ${task(plan, hosts, packet)}`,
    said ? `SO FAR IN THIS BREAK:\n${said}` : 'You open the break.',
    `Write line ${turn + 1} of ${plan.lines}${last ? ' (the last line' + (plan.intro ? ': introduce the next song' : '') + ')' : ''}. Reply to what was just said if anything was.${requestTurnNote(plan, packet, turn, last)}`,
  ].join('\n\n');
  return { system, user };
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
