// Turns packet facts into words a host can say out loud (times, relative days, sender names, temperatures).
import type { CalendarEvent, EmailSummary, PartOfDay, WeatherSnapshot } from '../types';

export function clockTime(t: number, locale?: string): string {
  const d = new Date(t);
  // "9:05 PM", or "9 PM" on the hour
  return d.toLocaleTimeString(locale ?? 'en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined });
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];

/** 0..59 in words: "seven", "twenty-four". */
export function numberWords(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

/** The time the way a radio host says it: "ten o'clock", "ten oh five", "ten twenty-four" (12-hour clock). */
export function spokenTime(t: number): string {
  const d = new Date(t);
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  const hour = h === 12 && d.getHours() === 0 ? 'midnight' : h === 12 && m === 0 ? 'noon' : numberWords(h);
  if (m === 0) return hour === 'midnight' || hour === 'noon' ? hour : `${hour} o'clock`;
  return `${hour === 'midnight' || hour === 'noon' ? 'twelve' : hour} ${m < 10 ? `oh ${numberWords(m)}` : numberWords(m)}`;
}

const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "in 20 minutes", "at 3 PM", "tomorrow at 9 AM", "on Saturday at 8 PM", "today", "right now". */
export function whenSpoken(at: number, now: number, allDay = false, locale?: string): string {
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  const dayWord = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : `on ${new Date(at).toLocaleDateString(locale ?? 'en-US', { weekday: 'long' })}`;
  if (allDay) return dayWord;
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0 && mins > -10) return 'right now';
  if (mins > 0 && mins < 60) return `in ${numberWords(mins)} minute${mins === 1 ? '' : 's'}`;
  if (mins < 0 && mins > -60) return `${numberWords(-mins)} minute${mins === -1 ? '' : 's'} ago`;
  return days === 0 ? `at ${clockTime(at, locale)}` : `${dayWord} at ${clockTime(at, locale)}`;
}

export function eventSpoken(e: CalendarEvent, now: number, locale?: string): string {
  const live = e.start <= now && (e.end ?? e.start) > now;
  if (live && !e.allDay) return `${e.title}, happening now`;
  return `${e.title} ${whenSpoken(e.start, now, e.allDay, locale)}`;
}

/** "Sam Lee <sam@x.com>" -> "Sam Lee"; "billing@shop.com" -> "Shop". Never reads addresses on air. */
export function senderName(from: string): string {
  const name = from.replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  if (name && !name.includes('@')) return name;
  const domain = (from.match(/@([^>\s]+)/)?.[1] ?? '').split('.').slice(-2, -1)[0] ?? '';
  return domain ? domain[0]!.toUpperCase() + domain.slice(1) : 'someone';
}

/** Subject trimmed to a few words, with numbers and codes taken out. */
export function subjectGist(subject: string, maxWords = 7): string {
  const words = subject
    .replace(/^(re|fwd?|aw):\s*/gi, '')
    .replace(/[#[\]{}<>|]/g, ' ')
    .replace(/\b\d{4,}\b/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const gist = words.slice(0, maxWords).join(' ');
  return words.length > maxWords ? `${gist}...` : gist;
}

export function emailSpoken(m: EmailSummary): string {
  return `a message from ${senderName(m.from)} about ${subjectGist(m.subject)}`;
}

export function weatherSpoken(w: WeatherSnapshot): string {
  const parts = [`${w.temperature} degrees and ${w.condition}${w.place ? ` in ${w.place}` : ''}`];
  if (w.high !== undefined && w.low !== undefined) parts.push(`high of ${w.high}, low of ${w.low}`);
  if ((w.precipitationChance ?? 0) >= 30) parts.push(`${w.precipitationChance} percent chance of rain`);
  return parts.join(', ');
}

export const PART_OF_DAY_WORDS: Record<PartOfDay, string> = {
  'early-morning': 'early morning',
  morning: 'morning',
  afternoon: 'afternoon',
  evening: 'evening',
  night: 'night',
  'late-night': 'late night',
};

export function greetingFor(p: PartOfDay): string {
  switch (p) {
    case 'early-morning':
    case 'morning':
      return 'Good morning';
    case 'afternoon':
      return 'Good afternoon';
    case 'evening':
      return 'Good evening';
    default:
      return 'Hey there, night owl';
  }
}

const MORNING_WORDS = /\b(morning|rise|shine|sunrise|wake|breakfast|coffee|this day|the day)\b/i;
const NIGHT_WORDS = /\b(night|owls?|midnight|late|evening|moon|stars?|sleep)\b/i;

/** A catchphrase that names a time of day ("Rise and shine", "night owls") only fits that part of the day. */
export function fitsPartOfDay(phrase: string, part: PartOfDay): boolean {
  const morning = part === 'early-morning' || part === 'morning';
  const night = part === 'evening' || part === 'night' || part === 'late-night';
  if (MORNING_WORDS.test(phrase) && !morning) return false;
  if (NIGHT_WORDS.test(phrase) && !night) return false;
  return true;
}
