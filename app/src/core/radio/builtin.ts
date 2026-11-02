// The scripted fallback (never a choice): varied, charming lines composed from the same context packet the AI hosts get.
// No network, no model, and every fact it says comes from the packet.
import { lifeEventInfo } from '../context/life';
import type { BreakLine, ContextPacket, Host, PartOfDay, Station } from '../types';
import * as B from './builtinLines';
import { FUN_FACTS } from './facts';
import { notionSpoken } from './notionAsk';
import { memorySpoken } from '../memory/commands';
import { factFor, noteKey, requestIsNext, type BreakPlan } from './planner';
import { emailSpoken, eventSpoken, greetingFor, PART_OF_DAY_WORDS, fitsPartOfDay, whenSpoken } from './speakable';
import { TIME_SLOT } from './airtime';
import { scriptedSay } from '../agent/changes';

type Vars = Record<string, string | number | undefined>;

/** "Call the pharmacy" -> "call the pharmacy" inside a sentence (acronyms like "DMV" stay). */
export function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * A Notion page's note (context/notion notionNoteText: `Your Notion page "T", edited ..., says: <summary>`) as the
 * scripted hosts say it: the page and its first two items, not the whole summary with its dates and statuses.
 */
export function notionNoteSpoken(note: string): { page: string; what: string } | undefined {
  const m = /^Your Notion page "(.+?)"(?:, edited [^,]+,)? says: ([\s\S]*)$/.exec(note);
  if (!m) return undefined;
  const body = m[2]!.replace(/\s*\([^()]*\)/g, '').trim();
  const head = /^([^:;.]{1,40}):\s*/.exec(body);
  const rest = (head ? body.slice(head[0].length) : body).split(/\.(?:\s|$)/)[0]!.trim();
  const items = rest.split(/;\s*/).map((x) => x.trim()).filter(Boolean);
  if (!items.length) return undefined;
  const clip = (x: string) => (x.length > 80 ? `${x.slice(0, 77).trim()}...` : x);
  const picked = items.slice(0, 2).map(clip).join(' and ');
  const more = items.length > 2 ? `, plus ${items.length - 2} more` : '';
  return { page: m[1]!, what: `${head ? `${lowerFirst(head[1]!)}: ` : ''}${picked}${more}` };
}

export function fill(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k] ?? vars[k[0]!.toLowerCase() + k.slice(1)];
    const s = v === undefined ? '' : String(v);
    return k[0] === k[0]!.toUpperCase() && k[0] !== k[0]!.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  });
}

interface Beat {
  text: string;
  kind: 'opening' | 'callin' | 'outro' | 'topic' | 'intro' | 'filler';
}

class Composer {
  private used: string;
  constructor(
    private rand: () => number,
    recentText: string,
  ) {
    this.used = recentText.toLowerCase();
  }

  /** Picks a template, preferring ones whose fixed words did not air recently. */
  pick(bank: readonly string[], vars: Vars): string {
    const fresh = bank.filter((t) => {
      const fixed = t.split('{')[0]!.trim().toLowerCase();
      return fixed.length < 6 || !this.used.includes(fixed);
    });
    const pool = fresh.length ? fresh : bank;
    const out = fill(pool[Math.floor(this.rand() * pool.length)]!, vars);
    this.used += ` ${out.toLowerCase()}`;
    return out;
  }

  chance(p: number): boolean {
    return this.rand() < p;
  }
}

function callInBeats(c: Composer, said: string, packet: ContextPacket, now: number): Beat[] {
  const listener = packet.listener.callMe || packet.listener.name.split(' ')[0] || '';
  const beats: Beat[] = [{ kind: 'callin', text: listener ? c.pick(B.CALLIN_OPEN, { listener }) : c.pick(B.CALLIN_OPEN_ANON, {}) }];
  if (!said) return beats;
  const s = said.toLowerCase();
  const short = said.length > 120 ? `${said.slice(0, 117).trim()}...` : said;
  if (/upbeat|energy|dance|faster|pump|hype/.test(s)) beats.push({ kind: 'callin', text: c.pick(B.CALLIN_UPBEAT, {}) });
  else if (/\b(hi|hello|hey|shout|say hi)\b/.test(s)) beats.push({ kind: 'callin', text: c.pick(B.CALLIN_HELLO, {}) });
  else if (/day|calendar|schedule|today/.test(s) && packet.calendar?.length) {
    beats.push({ kind: 'callin', text: `Let me look. You have ${packet.calendar.slice(0, 2).map((e) => eventSpoken(e, now)).join(', and ')}.` });
  } else if (/fact|trivia/.test(s)) {
    beats.push({ kind: 'callin', text: `${c.pick(B.FACT_LEAD, {})} ${c.pick(FUN_FACTS, {})}` });
  } else beats.push({ kind: 'callin', text: c.pick(B.CALLIN_ECHO, { said: short.replace(/[.!?]+$/, '') }) });
  return beats;
}

function topicBeat(c: Composer, item: BreakPlan['items'][number], plan: BreakPlan, packet: ContextPacket, now: number): Beat | undefined {
  const t = (text: string): Beat => ({ kind: 'topic', text });
  switch (item.segment) {
    case 'time':
      // the time-teller's words: the real time goes in when the break starts (core/radio/airtime.ts)
      return t(c.pick(B.TIME, { time: TIME_SLOT, weekday: packet.now.weekday, part: PART_OF_DAY_WORDS[packet.now.partOfDay] }));
    case 'headsUp': {
      const h = packet.headsUps?.find((x) => `headsup:${x.id}` === item.key);
      return h ? t(h.say ?? scriptedSay(h, now)) : undefined;
    }
    case 'weather': {
      const w = packet.weather;
      if (!w) return undefined;
      const vars = { place: w.place, temp: w.temperature, cond: w.condition, high: w.high, low: w.low, rain: w.precipitationChance };
      let text = c.pick(w.place ? B.WEATHER : B.WEATHER_NOPLACE, vars);
      if ((w.precipitationChance ?? 0) >= 40) text += ` ${c.pick(B.WEATHER_RAIN, vars)}`;
      else if (w.high !== undefined && w.low !== undefined && c.chance(0.5)) text += ` ${c.pick(B.WEATHER_RANGE, vars)}`;
      return t(text);
    }
    case 'calendar': {
      const e = packet.calendar?.find((x) => `calendar:${x.id}` === item.key);
      if (!e) return undefined;
      // "with Dana Reyes and Mike Chen", "it's about the vendor numbers": the details the scripted hosts can say
      const people = (e.attendees ?? []).filter((a) => !a.self && a.status !== 'declined').map((a) => a.name).slice(0, 3);
      const about = packet.dossiers?.find((d) => d.key === item.key)?.about;
      const extra = [
        people.length ? `It's with ${people.length > 1 ? `${people.slice(0, -1).join(', ')} and ${people.at(-1)}` : people[0]}.` : '',
        e.invitation ? `${e.organizer ?? 'Someone'} sent the invite and you haven't answered yet.` : '',
        about && about.length < 160 && !plan.rundown ? about : '',
      ].filter(Boolean);
      return t([c.pick(B.CALENDAR, { event: eventSpoken(e, now) }), ...extra].join(' '));
    }
    case 'email': {
      const m = packet.email?.find((x) => `email:${x.id}` === item.key);
      return m ? t(c.pick(B.EMAIL, { email: emailSpoken(m) })) : undefined;
    }
    case 'news': {
      const h = packet.news?.find((x) => x.id === item.key);
      return h ? t(c.pick(B.NEWS, { source: h.source, headline: h.title.replace(/[.!?]+$/, '') })) : undefined;
    }
    case 'lifeEvents': {
      const e = packet.lifeEvents?.find((x) => `lifeEvents:${x.id}` === item.key);
      const info = e && lifeEventInfo(e, now);
      if (!e || !info) return undefined;
      let text = c.pick(info.daysAway === 0 ? B.LIFE_TODAY : B.LIFE_SOON, { event: e.title, when: info.when });
      if (info.years) text += ` ${c.pick(B.LIFE_YEARS, { years: info.years })}`;
      return t(text);
    }
    case 'notes': {
      const n = packet.notes?.find((x) => noteKey(x) === item.key);
      if (!n) return undefined;
      const page = notionNoteSpoken(n);
      return t(page ? c.pick(B.NOTION_NOTE, page) : c.pick(B.NOTE, { note: n.replace(/[.!?]+$/, '') }));
    }
    case 'reminders': {
      const r = packet.reminders?.find((x) => `reminders:${x.id}` === item.key);
      return r ? t(c.pick(B.REMINDER, { text: lowerFirst(r.text.replace(/[.!?]+$/, '')), when: whenSpoken(r.at, now) })) : undefined;
    }
    case 'funFacts': {
      const f = factFor(plan);
      return f ? t(`${c.pick(B.FACT_LEAD, {})} ${f}`) : undefined;
    }
    case 'inbox': {
      const i = packet.inbox?.find((x) => `inbox:${x.id}` === item.key);
      const a = i && packet.inboxAnswers?.[i.id];
      if (i && a) return t(`Your assistant asked: ${i.text.replace(/\s+/g, ' ').trim()} ${a.answer}`);
      return i ? t(i.kind === 'segment' ? i.text : c.pick(B.NOTE, { note: i.text.replace(/[.!?]+$/, '') })) : undefined;
    }
    default:
      return undefined;
  }
}

function songVars(s: { title: string; artist: string }) {
  return { song: s.title, artist: s.artist || 'that one' };
}

/** Writes a whole break from templates. Always returns at least one line. */
export function writeBuiltinBreak(
  station: Station,
  hosts: Host[],
  plan: BreakPlan,
  packet: ContextPacket,
  opts: { rand?: () => number; now?: number } = {},
): BreakLine[] {
  const rand = opts.rand ?? Math.random;
  const now = opts.now ?? Date.parse(packet.now.iso);
  const lead = hosts[0];
  if (!lead) return [];
  const c = new Composer(rand, packet.recentBreaks.slice(0, 8).flatMap((b) => b.lines.map((l) => l.text)).join(' '));
  const vars = { station: station.name, freq: station.frequency, host: lead.name, cohost: hosts[1]?.name, greeting: greetingFor(packet.now.partOfDay) };

  const beats: Beat[] = [];
  if (plan.kind === 'opening') {
    let text = c.pick(B.OPENING, vars);
    if (hosts.length > 1) text += ` ${c.pick(B.OPENING_DUO, vars)}`;
    beats.push({ kind: 'opening', text });
    // what the listener told the hosts: the plan coming up soonest
    if (packet.memory?.soon) beats.push({ kind: 'opening', text: `And from what you told me: ${packet.memory.soon}.` });
  }
  if (plan.callIn && plan.followUp) {
    // a question about something the hosts said: the answer, from the items' own fields and dossiers
    const listener = packet.listener.callMe || packet.listener.name.split(' ')[0] || '';
    beats.push({ kind: 'callin', text: listener ? c.pick(B.CALLIN_OPEN, { listener }) : c.pick(B.CALLIN_OPEN_ANON, {}) }, { kind: 'callin', text: plan.followUp.answer });
  } else if (plan.callIn) beats.push(...callInBeats(c, plan.request || plan.notion || plan.memory || plan.action ? '' : plan.callIn, packet, now));
  if (plan.notion) beats.push({ kind: 'callin', text: notionSpoken(plan.notion, (bank, vars) => c.pick(bank, vars), plan.kind) });
  if (plan.memory) beats.push({ kind: 'callin', text: memorySpoken(plan.memory) });
  // Your list: a reminder, a follow-up or what is due (the scripted fallback says it plainly)
  for (const text of packet.tracker?.spoken ?? []) beats.push({ kind: 'callin', text });
  if (plan.request) {
    const r = plan.request;
    const from = plan.requestFrom === 'app' ? B.REQUEST_APP_LEAD : B.REQUEST_LEAD;
    // the intro below names it when it is the next song: named once per break
    const introNamesIt = requestIsNext(plan, packet);
    beats.push(
      r.found
        ? {
            kind: 'callin',
            text: `${c.pick(from, {})} ${introNamesIt ? c.pick(B.REQUEST_SOON, {}) : c.pick(B.REQUEST_FOUND, { song: r.found.title, by: r.found.artist ? ` by ${r.found.artist}` : '' })}`,
          }
        : { kind: 'callin', text: `${c.pick(from, {})} ${c.pick(B.REQUEST_MISSING, { query: r.query })}` },
    );
  }
  if (plan.outro && packet.songBefore) {
    const bank = lead.energy >= 4 && c.chance(0.4) ? B.OUTRO_HIGH : lead.energy <= 2 && c.chance(0.5) ? B.OUTRO_LOW : B.OUTRO;
    beats.push({ kind: 'outro', text: c.pick(bank, songVars(packet.songBefore)) });
  }
  let timeCheck: Beat | undefined;
  let heads = 0;
  for (const item of plan.items) {
    const b = topicBeat(c, item, plan, packet, now);
    if (b && item.segment === 'time') timeCheck = b;
    // a heads-up opens the break (after the welcome of the first one)
    else if (b && item.segment === 'headsUp') beats.splice((plan.kind === 'opening' ? Math.min(1, beats.length) : 0) + heads++, 0, b);
    else if (b) beats.push(b);
  }
  if (plan.intro && packet.songAfter) {
    const closer = hosts[beats.length % hosts.length] ?? lead;
    const bank = closer.energy >= 4 && c.chance(0.4) ? B.INTRO_HIGH : closer.energy <= 2 && c.chance(0.5) ? B.INTRO_LOW : B.INTRO;
    beats.push({ kind: 'intro', text: c.pick(bank, songVars(packet.songAfter)) });
  } else if (plan.kind === 'callin' && !plan.request?.found) beats.push({ kind: 'filler', text: c.pick(B.CALLIN_THANKS, {}) });
  // the time check is said last, by whoever closes, just before the hand-off to the song
  const closing = beats.at(-1);
  if (timeCheck && closing && (closing.kind === 'intro' || closing.kind === 'filler')) closing.text = `${timeCheck.text} ${closing.text}`;
  else if (timeCheck) beats.push(timeCheck);
  if (!beats.length) beats.push({ kind: 'filler', text: c.pick(B.STATION_ID, vars) });

  return assign(c, beats, hosts, plan.lines, packet.now.partOfDay);
}

/** Spreads beats over `target` lines and hosts: merges when there are too many, adds reactions when too few. */
/** Two lines said as one: a filler the first already used ("Mm", "Oh") is not said twice. */
export function joinLines(a: string, b: string): string {
  const m = /^(mm+|oh|ooh|wow|okay|alright|yeah)[.,!]?\s+/i.exec(b);
  const rest = m && new RegExp(`\\b${m[1]}\\b`, 'i').test(a) ? b.slice(m[0].length) : b;
  return `${a} ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

function assign(c: Composer, beats: Beat[], hosts: Host[], target: number, part: PartOfDay): BreakLine[] {
  const lines: { host: Host; text: string }[] = [];
  let turn = 0;
  for (const beat of beats) {
    const host = hosts[turn % hosts.length]!;
    lines.push({ host, text: beat.text });
    turn++;
  }
  // too few lines: the other host reacts after a topic (or the lead adds a station ID)
  for (let i = 0; lines.length < target && i < 4; i++) {
    const at = Math.min(lines.length - 1, 1 + i * 2);
    const prev = lines[at - 1] ?? lines[0]!;
    const other = hosts.find((h) => h.id !== prev.host.id);
    if (other) {
      const bank = other.humor >= 4 ? B.REACT_FUNNY : other.energy <= 2 ? B.REACT_CALM : B.REACT;
      lines.splice(at, 0, { host: other, text: c.pick(bank, { name: prev.host.name }) });
    } else {
      lines.splice(Math.max(0, lines.length - 1), 0, { host: prev.host, text: c.pick(B.STATION_ID, {}) });
    }
  }
  // too many: merge neighbours (keeps the final intro on its own)
  while (lines.length > target && lines.length > 1) {
    const i = Math.max(0, lines.length - 3);
    const a = lines[i]!;
    const b = lines[i + 1]!;
    lines.splice(i, 2, { host: a.host, text: joinLines(a.text, b.text) });
  }
  // fix host order after inserts: no host twice in a row when there are several
  for (let i = 1; i < lines.length && hosts.length > 1; i++) {
    if (lines[i]!.host.id === lines[i - 1]!.host.id) {
      lines[i - 1]!.text = `${lines[i - 1]!.text} ${lines[i]!.text}`;
      lines.splice(i, 1);
      i--;
    }
  }
  // the lead's catchphrase, sometimes
  const lead = hosts[0]!;
  const first = lines[0];
  const phrases = lead.catchphrases.filter((p) => fitsPartOfDay(p, part));
  if (first && first.host.id === lead.id && phrases.length && c.chance(B.CATCH_CHANCE)) {
    const cp = phrases[Math.floor(c.chance(0.5) ? 0 : phrases.length - 1)]!.replace(/[.!?]*$/, '');
    first.text = `${cp}! ${first.text}`;
  }
  return lines.map((l) => ({ hostId: l.host.id, text: l.text.replace(/\s+/g, ' ').trim() }));
}

/** One scripted line for a host with no AI brain in a turn-by-turn break (next to an AI host). */
export function builtinTurn(
  station: Station,
  hosts: Host[],
  speaker: Host,
  plan: BreakPlan,
  packet: ContextPacket,
  turn: number,
  opts: { rand?: () => number } = {},
): string {
  const lines = writeBuiltinBreak(station, hosts, plan, packet, opts);
  const mine = lines.filter((l) => l.hostId === speaker.id);
  return (mine[Math.floor(turn / Math.max(1, hosts.length))] ?? mine[0] ?? lines[turn % lines.length] ?? lines[0]!).text;
}
