// Air time: a break is written before it airs (up to four minutes before its song ends, or at the start of a song
// whose length is unknown), and the listener may skip, pause or fast-forward in between. So:
//  1. its facts are planned for the moment it is expected on air (prepare.ts, the air-time anchor);
//  2. the clock time is said by ONE host, in the LAST line, written with a {TIME} slot. When the break actually
//     starts, the slot gets the real time at the moment that line will play (now + the earlier lines' clip lengths)
//     and that one line is voiced while the earlier lines play. Not ready in time: the line plays without the time
//     (voiced ahead), never a wrong time and never dead air;
//  3. "in 20 minutes" wording is checked at break start: a break airing a minute or more off plan gets it corrected
//     (voiced again) or, when that is not ready in time, an absolute time ("at 2:30 PM") voiced ahead.
import type { BreakLine, CalendarEvent, ContextPacket, Host, VoiceClip } from '../types';
import { DEVICE_VOICE_ID } from '../types';
import { clockTime, numberWords, spokenTime } from './speakable';

export const TIME_SLOT = '{TIME}';
/** the time line plays this far off the moment its time was set for: said as is; further off, said without it */
export const TIME_TOLERANCE_MS = 30_000;
/** a break that starts this far off its planned moment gets its "in N minutes" wording checked */
export const DRIFT_MS = 60_000;
/** a one-line break waits this long at its start for its timed line, then plays the line voiced ahead */
export const SINGLE_LINE_WAIT_MS = 2500;

const SLOT_RE = /\{\{?\s*time\s*\}?\}|\[\s*time\s*\]|<\s*time\s*>/gi;
export const normalizeSlot = (s: string) => s.replace(SLOT_RE, TIME_SLOT);

/** Sentences with their punctuation and trailing space ("It's {TIME}. Here's ..." -> two). */
export const sentencesOf = (t: string): string[] => t.match(/[^.!?]+(?:[.!?]+["”’']?|$)\s*/g) ?? [t];

const HOUR_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const MINUTE_WORD = "(?:o'?clock|oh\\s+(?:one|two|three|four|five|six|seven|eight|nine)|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)";
/** "it's 9:28", "the time is nine twenty-eight", "right now it's ten o'clock": the clock, said by a line that may not */
const CLOCK_RE = new RegExp(
  `\\b(?:it'?s|it is|time is|time check|we'?re at|coming up on)\\b[^.!?]{0,24}?(?:\\b\\d{1,2}:\\d{2}\\b|\\b\\d{1,2}\\s*[ap]\\.?m\\b|\\bnoon\\b|\\bmidnight\\b|\\b${HOUR_WORD}\\s+${MINUTE_WORD}\\b(?!\\s*(?:degrees|percent|minutes|hours|miles|points|dollars)))`,
  'i',
);
export const saysClock = (s: string) => CLOCK_RE.test(s);

const tidy = (s: string) => s.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One sentence without its time: "It's {TIME}, here's Harbor Lights." -> "Here's Harbor Lights." ('' when nothing is left). */
function dropSlot(sentence: string): string {
  if (!sentence.includes(TIME_SLOT)) return sentence;
  const clauses = sentence.split(/(?<=,|;|\s[-–])\s+/);
  if (clauses.length < 2) return '';
  const kept = tidy(clauses.filter((c) => !c.includes(TIME_SLOT)).join(' ').replace(/^[\s,;–-]*(?:(?:and|so|but)\s+)?/i, '').replace(/[,;\s–-]+$/, ''));
  if (kept.split(/\s+/).length < 3) return '';
  return `${upperFirst(kept)}${/[.!?]["”’']?$/.test(kept) ? '' : '.'} `;
}

/** The text without the time slot or a clock time (the line said when its timed version is not ready). */
export function withoutTime(text: string): string {
  return tidy(sentencesOf(normalizeSlot(text)).map((s) => (s.includes(TIME_SLOT) ? dropSlot(s) : saysClock(s) ? '' : s)).join(''));
}

export interface TimeLine {
  /** the line's index in the break (always the last) */
  index: number;
  /** the time-teller's words, with {TIME} */
  template: string;
  /** the same line without the time ('' = nothing left: the line is skipped) */
  plain: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * One time-teller per break: the {TIME} slot goes in the LAST line only (once), no other line says the clock time.
 * `wantTime` = the plan has a time check; `next` = the song this break introduces (kept when the time is dropped).
 */
export function placeTimeLine(lines: BreakLine[], wantTime: boolean, next?: { title: string; artist: string }): { lines: BreakLine[]; time?: TimeLine } {
  if (!lines.length) return { lines };
  let moved = '';
  const out = lines.map((l, i) => {
    const last = i === lines.length - 1;
    let slotSeen = false;
    const text = sentencesOf(normalizeSlot(l.text))
      .map((s) => {
        if (s.includes(TIME_SLOT)) {
          if (last && !slotSeen && wantTime) {
            slotSeen = true;
            return s.split(TIME_SLOT).map((part, n) => (n === 0 ? part : n === 1 ? TIME_SLOT + part : part)).join('');
          }
          // a time check in another line moves to the last one
          if (!last && !moved && wantTime) moved = tidy(s);
          return dropSlot(s);
        }
        return saysClock(s) ? '' : s;
      })
      .join('');
    return { ...l, text: tidy(text) };
  });
  const lastIdx = out.length - 1;
  const named = (t: string) => Boolean(next && norm(next.title) && norm(t).includes(norm(next.title)));
  const handOff = next ? (next.artist ? `Here's ${next.title} by ${next.artist}.` : `Here's ${next.title}.`) : '';
  const kept = out.filter((l, i) => i === lastIdx || l.text);
  const lastLine = kept[kept.length - 1]!;
  if (next && !kept.some((l) => named(l.text))) lastLine.text = tidy(`${lastLine.text} ${handOff}`);
  if (!wantTime) return { lines: kept.filter((l) => l.text) };
  if (!lastLine.text.includes(TIME_SLOT)) lastLine.text = tidy(`${moved && moved.includes(TIME_SLOT) ? moved : `It's ${TIME_SLOT}.`} ${lastLine.text}`);
  let plain = withoutTime(lastLine.text);
  if (next && named(lastLine.text) && !named(plain)) plain = tidy(`${plain} ${handOff}`);
  return { lines: kept, time: { index: kept.length - 1, template: lastLine.text, plain } };
}

/** The time-teller's words with the real time in. */
export function fillTime(template: string, at: number): string {
  return template.replace(TIME_SLOT, spokenTime(at)).replace(/(^|[.!?]\s+)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

// ------------------------------------------------------------------------------------------------ clip lengths

/** How long a line takes to say (an estimate: about 2.6 words a second at normal speed). */
export function estimateSpeechMs(text: string, speed = 1): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(((words / 2.6) * 1000) / Math.max(0.5, Math.min(2, speed || 1)) + 250);
}

const MP3_KBPS = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const MP3_RATES = [
  [11025, 12000, 8000],
  [0, 0, 0],
  [22050, 24000, 16000],
  [44100, 48000, 32000],
];
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** The length of a WAV or MP3 voice clip from its header (undefined for other formats). */
export async function audioLengthMs(blob: Blob): Promise<number | undefined> {
  try {
    const head = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
    if (head.length < 12) return undefined;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') {
      const byteRate = view.getUint32(28, true);
      let at = 12;
      while (at + 8 <= head.length) {
        const size = view.getUint32(at + 4, true);
        if (ascii(head, at, 4) === 'data') return byteRate ? Math.round(((Math.min(size, blob.size - at - 8) / byteRate) * 1000)) : undefined;
        at += 8 + size + (size % 2);
      }
      return byteRate ? Math.round(((blob.size - 44) / byteRate) * 1000) : undefined;
    }
    let off = 0;
    if (ascii(head, 0, 3) === 'ID3') off = 10 + ((head[6]! & 0x7f) << 21) + ((head[7]! & 0x7f) << 14) + ((head[8]! & 0x7f) << 7) + (head[9]! & 0x7f);
    const frame = off + 4 <= head.length ? head.subarray(off) : new Uint8Array(await blob.slice(off, off + 4096).arrayBuffer());
    if (frame.length < 4 || frame[0] !== 0xff || (frame[1]! & 0xe0) !== 0xe0 || ((frame[1]! >> 1) & 3) !== 1) return undefined;
    const version = (frame[1]! >> 3) & 3;
    const kbps = MP3_KBPS[version === 3 ? 0 : 1]![frame[2]! >> 4];
    const rate = MP3_RATES[version]![(frame[2]! >> 2) & 3];
    if (!kbps || !rate) return undefined;
    // a Xing/Info header gives the exact frame count (variable bitrate)
    const xing = ascii(frame, 0, Math.min(frame.length, 200)).search(/Xing|Info/);
    if (xing > 0 && frame.length >= xing + 12 && frame[xing + 7]! & 1) {
      const frames = new DataView(frame.buffer, frame.byteOffset + xing + 8, 4).getUint32(0);
      if (frames > 0) return Math.round(((frames * (version === 3 ? 1152 : 576)) / rate) * 1000);
    }
    return Math.round(((blob.size - off) * 8) / kbps);
  } catch {
    return undefined;
  }
}

/** A clip's length: read from the audio when it can be, else estimated from the words. */
export async function clipLengthMs(clip: VoiceClip | undefined, text: string, speed = 1): Promise<number> {
  if (clip?.kind === 'audio') return (await audioLengthMs(clip.blob)) ?? estimateSpeechMs(text, speed);
  return estimateSpeechMs(text, clip?.kind === 'device' ? clip.rate || speed : speed);
}

// ------------------------------------------------------------------------------------------------ voice speed

const voiceTimes = new Map<string, number[]>();
const voiceKey = (h: Host) => (h.voice.voiceProviderId && h.voice.voiceProviderId !== DEVICE_VOICE_ID ? h.voice.voiceProviderId : '');

/** Remembers how long a host's voice took for one line. */
export function noteVoiceMs(host: Host, ms: number): void {
  const key = voiceKey(host);
  if (key) voiceTimes.set(key, [...(voiceTimes.get(key) ?? []), ms].slice(-6));
}

/** How long this host's voice usually takes for a line (0 = this device's voice; undefined = not measured yet). */
export function voiceMs(host: Host): number | undefined {
  const key = voiceKey(host);
  if (!key) return 0;
  const list = [...(voiceTimes.get(key) ?? [])].sort((a, b) => a - b);
  return list.length ? list[Math.floor(list.length / 2)] : undefined;
}

// ------------------------------------------------------------------------------------------------ "in 20 minutes"

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const NUM = `(?:\\d{1,3}|a|an|one|${ONES.slice(2).join('|')}|(?:twenty|thirty|forty|fifty)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)`;

function parseNum(s: string): number | undefined {
  const t = s.toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t === 'a' || t === 'an') return 1;
  const [tens, ones] = t.split(/[- ]/);
  if (tens && TENS[tens] !== undefined) return TENS[tens]! + (ones ? Math.max(0, ONES.indexOf(ones)) : 0);
  const i = ONES.indexOf(t);
  return i >= 0 ? i : undefined;
}

/** "in twenty minutes", "in about 5 mins", "in half an hour", "ten minutes from now", "fifteen minutes ago", "starts now" */
const REL_RE = new RegExp(
  `\\b(?:in|within)\\s+(?:about\\s+|around\\s+|roughly\\s+|just\\s+|only\\s+|another\\s+)?(?:(${NUM})\\s+(?:minutes?|mins?)\\b|(half an hour|an hour)\\b)|\\b(${NUM})\\s+(?:minutes?|mins?)\\s+(from now|ago)\\b|\\b(starts|starting|begins|beginning|kicks off|is up)\\s+(?:right\\s+)?now\\b`,
  'gi',
);

export interface RelativeTime {
  phrase: string;
  /** the moment it points at (an event's start when one matches) */
  at: number;
  past: boolean;
  /** "starts now": the verb kept in front of the new wording */
  verb?: string;
  /** it matched an event or reminder start, so an absolute time can stand in */
  exact: boolean;
}

/** The relative times in a line, planned at `at` (the moment the line was written for). */
export function relativeTimes(text: string, at: number, packet?: Pick<ContextPacket, 'calendar' | 'reminders'>): RelativeTime[] {
  const starts = [
    ...(packet?.calendar ?? []).filter((e: CalendarEvent) => !e.allDay).map((e) => e.start),
    ...(packet?.reminders ?? []).map((r) => r.at),
  ];
  const out: RelativeTime[] = [];
  for (const m of text.matchAll(REL_RE)) {
    const mins = m[1] ? parseNum(m[1]) : m[2] ? (m[2].toLowerCase() === 'an hour' ? 60 : 30) : m[3] ? parseNum(m[3]) : m[5] ? 0 : undefined;
    if (mins === undefined) continue;
    const past = m[4]?.toLowerCase() === 'ago';
    const guess = at + (past ? -mins : mins) * 60_000;
    const near = starts.filter((s) => Math.abs(s - guess) <= 3 * 60_000).sort((a, b) => Math.abs(a - guess) - Math.abs(b - guess))[0];
    out.push({ phrase: m[0], at: near ?? guess, past, ...(m[5] ? { verb: m[5] } : {}), exact: near !== undefined });
  }
  return out;
}

const minutesWords = (n: number) => (n === 1 ? 'a minute' : `${numberWords(Math.min(59, n))} minutes`);

/** Wording that is right whenever it is said: the absolute time, else a vague one. */
function safeWords(r: RelativeTime): string {
  if (r.verb) return r.exact ? `${r.verb} at ${clockTime(r.at)}` : `${r.verb} soon`;
  if (r.past) return r.exact ? `at ${clockTime(r.at)}` : 'a little while ago';
  return r.exact ? `at ${clockTime(r.at)}` : 'soon';
}

/** The wording for a line said at `when`: "in N minutes" recounted; the absolute time once it is not ahead any more. */
function wordsAt(r: RelativeTime, when: number): string {
  const mins = Math.round((r.at - when) / 60_000);
  if (r.past) return mins <= -1 && mins > -60 ? `${minutesWords(-mins)} ago` : safeWords(r);
  if (r.verb) return mins >= 2 ? `${r.verb} in ${minutesWords(mins)}` : mins >= -1 ? `${r.verb} right about now` : safeWords(r);
  if (mins >= 1 && mins < 60) return `in ${minutesWords(mins)}`;
  return mins >= -1 && mins < 1 ? 'right about now' : safeWords(r);
}

const replaceEach = (text: string, rel: RelativeTime[], words: (r: RelativeTime) => string) =>
  rel.reduce((t, r) => t.replace(r.phrase, words(r)), text);

/** The line with its relative times made safe to say at any moment (voiced ahead, said when a fix is late). */
export const safeRelative = (text: string, rel: RelativeTime[]) => replaceEach(text, rel, safeWords);

/** The line with its relative times counted from `when`, the moment it will actually be said. */
export const relativeAt = (text: string, rel: RelativeTime[], when: number) => replaceEach(text, rel, (r) => wordsAt(r, when));

// ------------------------------------------------------------------------------------------------ a written break

export interface AirTimed {
  /** the lines to show; the time line shows its time-free words (or the time it was planned for) until it airs */
  lines: BreakLine[];
  /** the same lines as they are voiced ahead (the time line without its time) */
  voiced: BreakLine[];
  timeLine?: TimeLine & { rel: RelativeTime[] };
  /** lines with "in N minutes": their wording that is right whenever it airs */
  relative: Record<number, { rel: RelativeTime[]; safe: string }>;
}

/** A written break made ready for air: one time-teller with a {TIME} slot, safe versions of "in N minutes". */
export function planAirTime(
  written: BreakLine[],
  opts: { wantTime: boolean; next?: { title: string; artist: string }; airAt: number; packet?: Pick<ContextPacket, 'calendar' | 'reminders'>; stationName: string },
): AirTimed {
  const placed = placeTimeLine(written, opts.wantTime, opts.next);
  const lines = placed.lines;
  let timeLine: AirTimed['timeLine'];
  if (placed.time) {
    const t = placed.time;
    // a one-line break says at least the station when its timed line is late
    const plain = t.plain || (lines.length === 1 ? `You're listening to ${opts.stationName}.` : '');
    timeLine = { ...t, plain: safeRelative(plain, relativeTimes(plain, opts.airAt, opts.packet)), rel: relativeTimes(t.template, opts.airAt, opts.packet) };
    lines[t.index] = { ...lines[t.index]!, text: timeLine.plain || fillTime(t.template, opts.airAt) };
  }
  const relative: AirTimed['relative'] = {};
  lines.forEach((line, i) => {
    if (i === timeLine?.index) return;
    const rel = relativeTimes(line.text, opts.airAt, opts.packet);
    const safe = rel.length ? safeRelative(line.text, rel) : line.text;
    if (safe !== line.text) relative[i] = { rel, safe };
  });
  const voiced = lines.map((l, i) => (i === timeLine?.index ? { ...l, text: timeLine.plain } : l));
  return { lines, voiced, ...(timeLine ? { timeLine } : {}), relative };
}
