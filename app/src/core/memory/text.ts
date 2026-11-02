// Words for memory cards (pure): the day key, content words and how alike two texts are, "I" -> "you", a first
// guess at a card's kind, and the dates people say ("next weekend", "on Friday", "November 7") turned into real
// dates, so a card never says "next weekend" a week later.
import type { MemoryKind } from '../types';

const DAY = 86_400_000;

/** YYYY-MM-DD in local time. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STOP = new Set(
  (
    'a an the and or but so of to in on at for with from by about as is are was were be been being am it its this that these those ' +
    'i im me my mine myself you youre your yours yourself we our us they them their he she him her his hers do does did done have has had ' +
    'will would can could should just really very too also not no yes there here what when where who how which than then if into out up ' +
    'down over again some any all every each more most much many one get got gets going go goes listener listeners'
  ).split(' '),
);

/** A rough stem: "skipped", "skips" and "skipping" all give "skip". */
export function stem(w: string): string {
  let s = w;
  for (const suf of ['ing', 'ies', 'ied', 'ed', 'es', 's', 'ly']) {
    if (s.length > suf.length + 3 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s.slice(0, 5);
}

/** Content words (lower case, stemmed), no small words. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** How alike two texts are, 0..1 (shared content words). */
export function similarity(a: string, b: string): number {
  const A = new Set(contentWords(a));
  const B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** "I'm vegetarian" -> "You're vegetarian": a card is told to the listener in the app. */
export function toSecondPerson(text: string): string {
  const swaps: [RegExp, string][] = [
    [/\bI'?m\b/gi, "you're"],
    [/\bI am\b/gi, 'you are'],
    [/\bI'?ve\b/gi, "you've"],
    [/\bI'?ll\b/gi, "you'll"],
    [/\bI'?d\b/gi, "you'd"],
    [/\bmyself\b/gi, 'yourself'],
    [/\bmine\b/gi, 'yours'],
    [/\bmy\b/gi, 'your'],
    [/\bme\b/gi, 'you'],
    [/\bI\b/g, 'you'],
    [/\bwe'?re\b/gi, "you're"],
    [/\bour\b/gi, 'your'],
  ];
  let out = text.trim().replace(/[’]/g, "'");
  for (const [re, to] of swaps) out = out.replace(re, to);
  out = out.replace(/\byou was\b/gi, 'you were');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Trims a card's text to `max` characters at a word. */
export function clip(text: string, max = 200): string {
  // plain punctuation: "November 7-8", never a long dash
  const t = text
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1-$2')
    .replace(/\s*[\u2013\u2014]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 3);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).replace(/[,;: ]+$/, '')}...`;
}

const PEOPLE = /\b(sister|brother|mom|mum|mother|dad|father|wife|husband|partner|son|daughter|kids?|children|friend|boss|cousin|aunt|uncle|grandma|grandmother|grandpa|grandfather|girlfriend|boyfriend|fianc[eé]e?|roommate|colleague|co-?worker|neighbou?r|niece|nephew|baby|dog|cat|puppy)\b/i;
const PREFERS = /\b(like|likes|love|loves|hate|hates|prefer|prefers|favou?rite|can'?t stand|enjoy|enjoys|vegetarian|vegan|allergic|don'?t eat|doesn'?t eat|fan of|into)\b/i;
const ROUTINE = /\b(every|usually|always|each|most) (morning|day|night|evening|week|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|\bon (mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekdays|weekends)\b|\b(commute|workout|gym|run|jog|walk the dog)\b/i;
const PLANS = /\b(visit|visiting|trip|travel|travelling|traveling|flying|fly|flight|appointment|interview|wedding|party|birthday|anniversary|deadline|exam|concert|vacation|holiday|moving|move|meeting|game|match|show|dinner)\b/i;
const JOKE = /\b(running joke|inside joke|running gag|joke)\b/i;

/** A first guess at the kind of a card from its words (the brain picks it when there is one). */
export function guessKind(text: string, hasDate: boolean): MemoryKind {
  if (JOKE.test(text)) return 'jokes';
  if (hasDate && (PLANS.test(text) || PEOPLE.test(text))) return 'plans';
  if (hasDate) return 'plans';
  if (ROUTINE.test(text)) return 'routines';
  if (PREFERS.test(text)) return 'preferences';
  if (PEOPLE.test(text)) return 'people';
  return 'about';
}

// ---- dates ------------------------------------------------------------------------------------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const endOfDay = (ms: number) => startOfDay(ms) + DAY - 1;
const addDays = (ms: number, n: number) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
/** Monday of the week `ms` is in (weeks start on Monday). */
const mondayOf = (ms: number) => addDays(startOfDay(ms), -((new Date(ms).getDay() + 6) % 7));
const monthDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
const weekdayMonthDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export interface DateWords {
  /** the words as said ("next weekend") */
  said: string;
  /** the same as a real date ("the weekend of November 7") */
  absolute: string;
  /** the first day it is about (start of day) */
  start: number;
  /** the end of the last day it is about: a plan is over after this */
  end: number;
}

/** The first date phrase in `text`, as real dates; undefined when it names no day. */
export function findDate(text: string, now: number): DateWords | undefined {
  const s = text.toLowerCase();
  const out = (said: string, start: number, end: number, absolute: string): DateWords => ({ said, start: startOfDay(start), end: endOfDay(end), absolute });
  let m: RegExpMatchArray | null;
  // "the weekend of November 7" is a date already (the month below reads it)
  if ((m = s.match(/\b(this|next) weekend\b(?! of)/))) {
    const thisSat = (() => {
      const day = new Date(now).getDay();
      if (day === 6) return startOfDay(now);
      if (day === 0) return addDays(startOfDay(now), -1);
      return addDays(startOfDay(now), 6 - day);
    })();
    // next weekend = the weekend of next week (weeks start on Monday)
    const sat = m[1] === 'next' ? addDays(mondayOf(now), 12) : thisSat;
    return out(m[0], sat, addDays(sat, 1), `the weekend of ${monthDay(sat)}`);
  }
  if ((m = s.match(/\b(tonight|today|this evening|this afternoon|this morning)\b/))) return out(m[0], now, now, `${m[1] === 'tonight' || m[1] === 'this evening' ? 'the evening of ' : ''}${weekdayMonthDay(now)}`);
  if ((m = s.match(/\b(the day after tomorrow)\b/))) return out(m[0], addDays(now, 2), addDays(now, 2), weekdayMonthDay(addDays(now, 2)));
  if ((m = s.match(/\btomorrow\b/))) return out(m[0], addDays(now, 1), addDays(now, 1), weekdayMonthDay(addDays(now, 1)));
  if ((m = s.match(/\b(next|this) week\b/))) {
    const mon = m[1] === 'next' ? addDays(mondayOf(now), 7) : mondayOf(now);
    return out(m[0], m[1] === 'this' ? now : mon, addDays(mon, 6), `the week of ${monthDay(mon)}`);
  }
  if ((m = s.match(/\bnext month\b/))) {
    const d = new Date(now);
    const first = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const last = new Date(d.getFullYear(), d.getMonth() + 2, 0).getTime();
    return out(m[0], first, last, new Date(first).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
  }
  if ((m = s.match(/\bin (\d{1,2}|a|one|two|three|four|five|six) (day|days|week|weeks)\b/))) {
    const nums: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = nums[m[1]!] ?? Number(m[1]);
    const days = m[2]!.startsWith('week') ? n * 7 : n;
    const d = addDays(now, days);
    return out(m[0], d, d, weekdayMonthDay(d));
  }
  const monthRe = new RegExp(`\\b(${MONTHS.map((x) => x.slice(0, 3)).join('|')})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`);
  if ((m = s.match(monthRe))) {
    const month = MONTHS.findIndex((x) => x.startsWith(m![1]!));
    const day = Number(m[2]);
    if (month >= 0 && day >= 1 && day <= 31) {
      const y = new Date(now).getFullYear();
      let d = new Date(y, month, day).getTime();
      if (endOfDay(d) < now - 7 * DAY) d = new Date(y + 1, month, day).getTime();
      return out(m[0], d, d, weekdayMonthDay(d));
    }
  }
  if ((m = s.match(new RegExp(`\\b(?:(next|this|on) )?(${WEEKDAYS.join('|')})\\b(?!s)`)))) {
    const want = WEEKDAYS.indexOf(m[2]!);
    const today = new Date(now).getDay();
    let ahead = (want - today + 7) % 7;
    if (m[1] === 'next') ahead = ((want + 6) % 7) + 7 - ((today + 6) % 7);
    const d = addDays(startOfDay(now), ahead);
    return out(m[0], d, d, weekdayMonthDay(d));
  }
  return undefined;
}

/** Puts the real date in place of the words ("next weekend" -> "the weekend of November 7"). */
export function withAbsoluteDate(text: string, now: number): { text: string; date?: DateWords } {
  const date = findDate(text, now);
  if (!date) return { text };
  // "November 7" is a date already
  if (MONTHS.some((m) => date.said.startsWith(m.slice(0, 3)))) return { text, date };
  const re = new RegExp(`\\b(on )?${date.said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const swapped = text.replace(re, (all) => (/^on /i.test(all) && !/^the /.test(date.absolute) ? `on ${date.absolute}` : date.absolute));
  return { text: swapped, date };
}

/** A date the brain gave (YYYY-MM-DD), to the end of that day (a Saturday plan "for the weekend" ends on Sunday). */
export function dateEnd(iso: unknown, weekend = false): number | undefined {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const [y, mo, d] = iso.split('-').map(Number);
  const ms = new Date(y!, mo! - 1, d!).getTime();
  if (Number.isNaN(ms)) return undefined;
  return endOfDay(weekend && new Date(ms).getDay() === 6 ? addDays(ms, 1) : ms);
}

export const MONTH_NAMES = MONTHS;
export const WEEKDAY_NAMES = WEEKDAYS;
