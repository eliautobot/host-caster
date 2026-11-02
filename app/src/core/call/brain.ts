// The hosts' side of a live call or chat: every turn sees the conversation so far and everything the hosts already
// have (the day's calendar, mail, news and weather, the research desk's notes, what they remember, Your list) and
// runs the same engines as a call-in: "remember that ..." (memory/commands), song requests (radio/requests: queued
// for after the call), Notion asks, Your list and the actions engine (a proposal read back by code, the listener's
// yes runs it), then the agent loop with live lookups for the answer. Learning from the listener's words runs after.
// Without an AI brain the hosts say so honestly and still take song requests and notes.
import { isAcknowledgement } from '../agent/changes';
import { snoozeLast } from '../agent/headsup';
import { answerFollowUp, followItems, type FollowItem } from '../agent/followup';
import { peopleWords } from '../agent/brief';
import { runAgent } from '../agent/loop';
import { lookupsOn, toolContext } from '../agent/research';
import { availableTools, type ToolName } from '../agent/tools';
import { actionTask, takeActionTurn, type ActionTurn } from '../actions/callin';
import { linesAroundAction } from '../actions/echo';
import { actionHistory } from '../actions/engine';
import type { ActionRecord } from '../actions/types';
import { buildContext, summarize } from '../context/context';
import { db } from '../db/db';
import { getProfile, getSettings } from '../db';
import { learnFromWords, memoryAnswer, memoryFact, memorySpoken, memoryTask, noteGotIt, noteSaid, takeMemoryCommand, type MemoryChange } from '../memory';
import { cardLine, MEMORY_RULE, pickCards } from '../memory/brief';
import { cleanLine } from '../radio/script';
import { eventSpoken, senderName, weatherSpoken } from '../radio/speakable';
import { hostCard, songLabel } from '../radio/prompt';
import { notionFact, notionSpoken, notionTask, type NotionWrite } from '../radio/notionAsk';
import { stationBrain, takeNotionWrite } from '../radio/notionWrite';
import { isMood, isSongRequest, requestQuery, type SongRequest } from '../radio/requests';
import { listBrief, listSheet, LIST_RULE } from '../tracker/brief';
import { speakable } from '../tracker/safety';
import { loadBrains, loadLineup } from '../radio/prepare';
import type { Brain, ContextPacket, Host, Station, TrackSummary } from '../types';
import { HOLD_LINES, limitLine, limitWarningLine, LOST_LINE, noBrainLine, NO_BRAIN_REPLY, pickupLine, signOffLine, stillThereLine, wrapUpLine } from './phrases';
import type { CallBrain, CallLine, HostLine, TurnReply } from './session';

export type CallMode = 'voice' | 'text';

export interface CallHooks {
  /** a song request: queued to play right after the call (the radio's queue), or not found */
  requestSong?: (said: string) => Promise<SongRequest | undefined>;
  /** the song under the call (paused for a voice call, playing for a chat) */
  nowPlaying?: () => TrackSummary | undefined;
}

export interface HostsBrain extends CallBrain {
  hosts: Host[];
  /** the lead host's real AI brain (undefined: the scripted fallback) */
  brain?: Brain;
  listenerName?: string;
}

const VOICE_TOKENS = 260;
const TEXT_TOKENS = 380;
/** answer within this, lookups included (a phone call cannot wait long) */
const VOICE_DEADLINE_MS = 16_000;
const TEXT_DEADLINE_MS = 22_000;
const CONTEXT_WAIT_MS = 1500;
const CONTEXT_TTL_MS = 5 * 60_000;

const pickOne = <T>(bank: readonly T[]): T => bank[Math.floor(Math.random() * bank.length)]!;

/** The facts the hosts have at hand, compact (a call turn should be quick to read). */
export function callFacts(packet: ContextPacket, items: FollowItem[], now = Date.now()): string[] {
  const out: string[] = [];
  const soon = (packet.calendar ?? []).filter((e) => (e.end ?? e.start) > now && e.start < now + 36 * 3600_000).slice(0, 8);
  if (soon.length) {
    const row = (e: (typeof soon)[number]) => {
      const who = peopleWords(e, 5);
      return `- ${speakable(e.title, 80)}: ${eventSpoken(e, now)}${e.location ? `, at ${speakable(e.location, 60)}` : ''}${who ? `; people: ${speakable(who, 160)}` : ''}`;
    };
    out.push(`CALENDAR (next 36 hours, complete):\n${soon.map(row).join('\n')}`);
  }
  const mail = (packet.email ?? []).filter((m) => m.important).slice(0, 5);
  if (mail.length) out.push(`IMPORTANT MAIL:\n${mail.map((m) => `- from ${senderName(m.from)}: ${speakable(m.subject, 90)}`).join('\n')}`);
  if (packet.weather) out.push(`WEATHER: ${weatherSpoken(packet.weather)}`);
  const news = (packet.news ?? []).slice(0, 3);
  if (news.length) out.push(`HEADLINES: ${news.map((h) => speakable(h.title, 100)).join(' / ')}`);
  const notes = items.filter((i) => i.dossier?.about).slice(0, 4);
  if (notes.length) out.push(`WHAT YOU FOUND OUT EARLIER:\n${notes.map((i) => `- ${speakable(i.title, 70)}: ${speakable(i.dossier!.about, 260)}`).join('\n')}`);
  const aired = packet.recentBreaks.slice(0, 2).flatMap((b) => b.lines.map((l) => l.text)).join(' ');
  if (aired) out.push(`LAST ON AIR: ${aired.slice(0, 400)}`);
  return out;
}

const STATUS_WORDS: Partial<Record<ActionRecord['status'], string>> = {
  proposed: "waiting for the listener's yes, NOT done",
  confirmed: 'being done now',
  executing: 'being done now',
  done: 'done',
  failed: 'NOT done (it failed)',
  cancelled: 'NOT done (the listener said no)',
  expired: 'NOT done (nobody said yes in time)',
  undone: 'undone by the listener',
  undo_failed: 'done (an undo failed)',
};

/** The real state of the things the hosts offered to do in this conversation (the model never guesses it). */
export function actionsSheet(actions: Pick<ActionRecord, 'summary' | 'status'>[]): string {
  if (!actions.length) return '';
  return `WHAT YOU OFFERED TO DO IN THIS CONVERSATION (the app's real status):\n${actions.map((a) => `- ${speakable(a.summary, 160)}: ${STATUS_WORDS[a.status] ?? a.status}`).join('\n')}`;
}

/** The call so far as a script the model reads (newest last). */
export function transcript(history: CallLine[], names: Map<string, string>, listener: string, max = 14): string {
  return history
    .slice(-max)
    .map((l) => `${l.who === 'you' ? listener : (names.get(l.hostId ?? '') ?? 'Host')}: ${l.text}`)
    .join('\n');
}

export function callSystem(mode: CallMode, station: Station, lead: Host, listener: string, coHost?: Host): string {
  const how =
    mode === 'voice'
      ? [
          `You are ${lead.name}, a host on the radio station ${station.name}. ${listener} called the station and you are live on the phone with them right now. The music is paused while you talk.`,
          'Talk like a radio host on a phone call: warm, quick and natural, in your own style. Reply in one to three short sentences (under 45 words). Only when they ask for details, up to five. It is a conversation: one thing at a time, and a short question back is fine.',
          'This is spoken: no lists, no markdown, no emojis, no stage directions, no name labels.',
        ]
      : [
          `You are ${lead.name}, a host on the radio station ${station.name}. ${listener} is messaging the hosts in the station's chat while the music plays.`,
          'Reply like a friendly host texting back: one to four short sentences, plain text, no markdown, no lists, no emojis, no em dashes, no name labels.',
        ];
  return [
    ...how,
    `YOU: ${hostCard(lead, 'lead').slice(2)}`,
    'The facts below (calendar, mail, weather, what you found out earlier, memory, Your list) are fresh: answer from them right away when they have it. Look things up only for what they do not have (an email\'s text, a thread, notes, an article, the web). Never make up facts, times or names: if you cannot find it, say so plainly.',
    'Never say you will check, look into or get back to something: answer now from the facts, or do the lookup first and then answer.',
    'Never say something was added, booked, scheduled, sent or done unless WHAT JUST HAPPENED or WHAT YOU OFFERED TO DO says it is done.',
    'Never read out web links, email addresses, phone numbers or codes.',
    mode === 'voice' ? 'Never say goodbye or end the call yourself: the listener hangs up when they are done.' : '',
    coHost ? `Your co-host ${coHost.name} is in the studio too. ${hostCard(coHost, 'co-host').slice(2)}` : '',
    MEMORY_RULE,
    LIST_RULE,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The model's reply as host lines: "Name: ..." lines belong to that host, the rest to the lead. */
export function replyLines(raw: string, lead: Host, hosts: Host[], maxLines = 4): HostLine[] {
  const names = hosts.map((h) => h.name);
  const out: HostLine[] = [];
  for (const row of raw.replace(/\r/g, '').split(/\n+/)) {
    const m = /^\s*\**\s*([A-Z][\w .'-]{0,30}?)\s*\**\s*:\s*(.+)$/.exec(row);
    const host = m ? hosts.find((h) => h.name.toLowerCase() === m[1]!.trim().toLowerCase()) : undefined;
    const text = cleanLine(host ? m![2]! : row, names).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const hostId = host?.id ?? lead.id;
    const prev = out.at(-1);
    if (prev && prev.hostId === hostId) prev.text = `${prev.text} ${text}`;
    else out.push({ hostId, text });
  }
  return out.slice(0, maxLines);
}

interface Done {
  facts: string[];
  tasks: string[];
  /** said without a brain */
  scripted: string[];
  /** code's exact last line (the actions engine), spoken by the lead */
  exact?: string;
  action?: ActionTurn;
  memory?: MemoryChange;
}

/** Builds the hosts' side of a call (voice) or chat (text) for the station. */
export async function hostsBrain(station: Station, mode: CallMode, hooks: CallHooks = {}): Promise<HostsBrain> {
  const hosts = await loadLineup(station);
  if (!hosts.length) throw new Error('This station has no hosts yet. Add a host in the station settings.');
  const lead = hosts[0]!;
  const brains = await loadBrains(hosts);
  const brain = await stationBrain(station).catch(() => undefined);
  const leadBrain = lead.brainId ? brains.get(lead.brainId) : undefined;
  // the lead speaks; when the lead has no AI brain, the first host with one answers through the lead's voice
  const answerBrain = leadBrain && leadBrain.kind !== 'builtin' ? leadBrain : brain;
  const profile = await getProfile();
  const listenerName = profile.callMe || profile.name || undefined;
  const listener = listenerName ?? 'the listener';
  const names = new Map(hosts.map((h) => [h.id, h.name]));
  const coHost = hosts[1];
  let turns = 0;
  const since = Date.now() - (mode === 'text' ? 2 * 3600_000 : 60_000);

  // what the hosts have at hand: loaded once (a call starts while the phone rings), refreshed every few minutes
  let packetAt = 0;
  let packetP: Promise<{ packet: ContextPacket; items: FollowItem[] } | undefined> = Promise.resolve(undefined);
  const loadPacket = () => {
    packetAt = Date.now();
    packetP = buildContext(station, { songBefore: hooks.nowPlaying?.() ? summarize(hooks.nowPlaying()) : undefined }, { budgetMs: 6000 })
      .then(async (packet) => ({ packet, items: await followItems(packet).catch(() => []) }))
      .catch(() => undefined);
  };
  loadPacket();
  const context = async () => {
    if (Date.now() - packetAt > CONTEXT_TTL_MS) loadPacket();
    return Promise.race([packetP, new Promise<undefined>((r) => setTimeout(r, CONTEXT_WAIT_MS))]);
  };

  const line = (text: string, host = lead): HostLine => ({ hostId: host.id, text });

  /** What the listener's words make happen before anyone answers (same engines as a call-in). */
  async function act(said: string, signal: AbortSignal): Promise<Done> {
    const d: Done = { facts: [], tasks: [], scripted: [] };
    if (isAcknowledgement(said)) {
      await snoozeLast().catch(() => undefined);
      void noteGotIt(said);
    }
    void noteSaid(said, 'call');
    const memory = await takeMemoryCommand(said, 'call').catch(() => undefined);
    if (memory) {
      d.memory = memory;
      d.facts.push(memoryFact(memory));
      d.tasks.push(memoryTask(memory));
      d.scripted.push(memorySpoken(memory));
      return d;
    }
    const request = isSongRequest(said) && !isMood(requestQuery(said)) ? await hooks.requestSong?.(said).catch(() => undefined) : undefined;
    if (request) {
      const when = mode === 'voice' ? 'right after this call' : 'next';
      if (request.found) {
        d.facts.push(`SONG REQUEST: ${songLabel(request.found)} is queued and plays ${when}.`);
        d.tasks.push('Say in a few words that the song is coming up.');
        d.scripted.push(`You got it. ${songLabel(request.found)} plays ${when}.`);
      } else {
        d.facts.push(`SONG REQUEST: "${request.query}" is NOT in their music library, so it cannot play.`);
        d.tasks.push('Say kindly that you could not find it in their music.');
        d.scripted.push(`I looked for ${request.query}, but it is not in your music, sorry.`);
      }
      return d;
    }
    // words about the calendar, Google Tasks or an invitation are for the actions engine, never a Notion note
    const forActions = /\b(calendar|google tasks?|invite|invitation|rsvp)\b/i.test(said) && !/\bnotion\b/i.test(said);
    const notion: NotionWrite | undefined = forActions ? undefined : await takeNotionWrite(said, station, signal).catch(() => undefined);
    if (notion) {
      d.facts.push(notionFact({ notion }));
      d.tasks.push(notionTask({ notion, kind: 'callin' }));
      d.scripted.push(notionSpoken(notion, (bank, vars) => pickOne(bank).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? vars[k.toLowerCase()] ?? '')));
      return d;
    }
    const action = await takeActionTurn({ said, origin: 'call-in', brain, signal }).catch(() => undefined);
    if (action) {
      d.action = action;
      d.exact = action.line;
      d.facts.push(action.fact);
      d.tasks.push(actionTask(action));
    }
    return d;
  }

  async function scriptedReply(said: string, d: Done): Promise<string> {
    if (d.scripted.length) return d.scripted.join(' ');
    if (d.exact) return '';
    const ctx = await context();
    // the weather the hosts already have answers a weather question without a brain
    if (ctx?.packet.weather && /\b(weather|rain|raining|sunny|temperature|hot|cold|forecast|umbrella|degrees)\b/i.test(said)) return `Right now it's ${weatherSpoken(ctx.packet.weather)}.`;
    if (ctx) {
      const settings = await getSettings();
      const a = await answerFollowUp({ said, packet: ctx.packet, hosts, brains: new Map(), settings, deadline: Date.now() + 3000 }).catch(() => undefined);
      if (a?.found) return a.answer;
    }
    const m = await memoryAnswer(said).catch(() => undefined);
    return m?.answer ?? NO_BRAIN_REPLY;
  }

  async function aiReply(said: string, history: CallLine[], d: Done, opts: { signal: AbortSignal; onLookup: () => void }): Promise<string> {
    const settings = await getSettings();
    const ctx = await context();
    const now = Date.now();
    const cards = await db.memories.toArray().catch(() => []);
    const recent = history.filter((l) => l.who === 'you').slice(-3).map((l) => l.text).join(' ');
    const memory = pickCards(cards, { topics: recent, callIn: said, now, max: 6, budget: 600 }).map(cardLine);
    const list = await listBrief({ now, callIn: true }).catch(() => undefined);
    // a chat goes on for hours, a call starts now: the actions offered in this conversation, with their real status
    const offered = (await actionHistory(8).catch(() => [] as ActionRecord[])).filter((a) => a.createdAt >= since).reverse();
    const playing = hooks.nowPlaying?.();
    const user = [
      `NOW: ${new Date(now).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
      `LISTENER: ${listener}${ctx?.packet.listener.about ? `. ${speakable(ctx.packet.listener.about, 200)}` : ''}${ctx?.packet.listener.interests.length ? `. Interests: ${ctx.packet.listener.interests.join(', ')}` : ''}`,
      playing ? `${mode === 'voice' ? 'PAUSED FOR THE CALL' : 'PLAYING NOW'}: ${songLabel(playing)}` : '',
      ...(ctx ? callFacts(ctx.packet, ctx.items, now) : []),
      memory.length ? `WHAT YOU REMEMBER ABOUT THE LISTENER:\n${memory.join('\n')}` : '',
      listSheet(list),
      actionsSheet(offered),
      d.facts.length ? `WHAT JUST HAPPENED (done by the app, true):\n${d.facts.join('\n')}` : '',
      d.tasks.length ? `FOR THIS REPLY: ${d.tasks.join(' ')}` : '',
      `THE ${mode === 'voice' ? 'CALL' : 'CHAT'} SO FAR:\n${transcript(history.slice(0, -1), names, listenerName ?? 'Listener') || '(it just started)'}`,
      `${(listenerName ?? 'THE LISTENER').toUpperCase()} JUST ${mode === 'voice' ? 'SAID' : 'WROTE'}: "${said}"`,
      coHost && mode === 'voice' && turns % 4 === 2 && !d.exact
        ? `Only if it truly fits (a quick joke or a useful add), you may end with ONE short line from ${coHost.name}, on its own line as "${coHost.name}: ...". Otherwise reply alone.`
        : `Reply as ${lead.name}${mode === 'voice' ? ', spoken words only' : ''}.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const system = callSystem(mode, station, lead, listener, coHost);
    // an action's own line is the answer's end: no lookups needed for the reaction before it
    const lookups = !d.exact && !d.memory && lookupsOn(settings, answerBrain);
    const tools: ToolName[] = lookups ? await availableTools({ connections: settings.connections, headlines: ctx?.packet.news ?? [] }) : [];
    const res = await runAgent({
      brain: answerBrain!,
      system,
      user,
      tools,
      ctx: await toolContext(settings, { news: ctx?.packet.news ?? [] }, lead, 'call-in'),
      maxSteps: tools.length ? 3 : 1,
      maxCalls: 3,
      deadline: now + (mode === 'voice' ? VOICE_DEADLINE_MS : TEXT_DEADLINE_MS),
      signal: opts.signal,
      answer: 'text',
      maxTokens: mode === 'voice' ? VOICE_TOKENS : TEXT_TOKENS,
      onLookup: () => opts.onLookup(),
    });
    return res.text;
  }

  return {
    hosts,
    brain: answerBrain,
    listenerName,
    lead: { id: lead.id, name: lead.name },
    greeting: () => [line(answerBrain ? pickupLine(listenerName, station.name) : noBrainLine(listenerName))],
    holdLine: () => line(pickOne(HOLD_LINES)),
    stillThere: () => line(stillThereLine(listenerName)),
    wrapUp: () => line(wrapUpLine(listenerName)),
    signOff: () => line(signOffLine(listenerName)),
    limitWarning: (m) => line(limitWarningLine(m)),
    limit: () => line(limitLine(listenerName)),
    async reply(said, history, opts): Promise<TurnReply> {
      turns++;
      const d = await act(said, opts.signal);
      let lines: HostLine[];
      let notice: string | undefined;
      if (!answerBrain) {
        lines = [line(await scriptedReply(said, d))];
      } else if (d.action?.kind === 'asked') {
        // a read-back that waits for a yes: a word of acknowledgement, then code's exact question (no model step)
        lines = [line(pickOne(['Sure.', 'You got it.', 'Okay.', 'Sure thing.']))];
      } else {
        try {
          lines = replyLines(await aiReply(said, history, d, opts), lead, hosts);
          if (!lines.length) throw new Error('The brain gave an empty answer');
        } catch (err) {
          if (opts.signal.aborted) throw err;
          notice = `Your hosts' AI did not answer (${err instanceof Error ? err.message : String(err)}).`;
          const s = d.scripted.length ? d.scripted.join(' ') : d.exact ? '' : LOST_LINE;
          lines = s ? [line(s)] : [];
        }
      }
      // the action's exact words come last, said once (the model's lines never repeat or claim them)
      if (d.action && d.exact) lines = [...linesAroundAction(lines, d.action), line(d.exact)];
      lines = lines.filter((l) => l.text.trim());
      // anything else worth remembering: learned while the answer is spoken (never in its way)
      if (!d.memory) void learnFromWords(said, 'call', { stationId: station.id }).catch(() => undefined);
      const remembered = d.memory && (d.memory.op === 'remembered' || d.memory.op === 'updated') ? d.memory.text : undefined;
      return {
        lines,
        ...(d.action?.kind === 'asked' && d.action.action ? { actionId: d.action.action.id } : {}),
        ...(notice ? { notice } : {}),
        ...(remembered ? { remembered } : {}),
      };
    },
  };
}
