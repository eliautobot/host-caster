// Event details from calendar feeds (ICS), the same shapes the server gives for Google events
// (server/src/integrations/details.js): clean description text with links kept apart, the video call by provider,
// how it repeats, people's names. Pure.
import type { LinkRef } from '../types';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: ', ', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const DIAL_IN = /meeting id|passcode|password|pin[:#]|dial[- ]in|one tap|join by phone|find your local number|\+\d[\d\s().-]{7,}|^#+$|^tel:|more phone numbers|join with google meet|join zoom meeting|join on your computer|microsoft teams meeting|click here to join|learn more about meet/i;

export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}...`;
}

/** HTML or text -> clean text and the links it held (never read aloud). */
export function cleanText(input: string, max = 400): { text: string; links: LinkRef[] } {
  let s = String(input ?? '');
  const links: LinkRef[] = [];
  const add = (url: string, label?: string) => {
    const u = decodeEntities(url).replace(/[.,;:]+$/, '');
    if (/^https?:\/\//i.test(u) && !links.some((l) => l.url === u)) links.push(label && label !== u ? { url: u, label } : { url: u });
  };
  s = s.replace(/-::~[:~]+::-?[\s\S]*?(-::~[:~]+::-?|$)/g, '\n');
  if (/<[a-z][\s\S]*>/i.test(s)) {
    s = s
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
        const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        const named = label && !/^https?:/i.test(label) ? label.slice(0, 80) : undefined;
        add(href, named);
        return named ?? ' ';
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  }
  s = decodeEntities(s);
  for (const m of s.matchAll(URL_RE)) add(m[0]);
  s = s.replace(URL_RE, ' ').replace(/[<>]/g, ' ');
  s = s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => !DIAL_IN.test(l) && !/^[-_=*~.]{3,}$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: capText(s, max), links: links.slice(0, 6) };
}

const VIDEO: [RegExp, string][] = [
  [/meet\.google\.com\//i, 'Google Meet'],
  [/(^|[./])zoom\.us\/(j|my|w)\//i, 'Zoom'],
  [/teams\.(microsoft|live)\.com\//i, 'Microsoft Teams'],
  [/webex\.com\//i, 'Webex'],
  [/whereby\.com\//i, 'Whereby'],
  [/(gotomeeting|gotomeet)\.(com|me)\//i, 'GoTo Meeting'],
  [/meet\.jit\.si\//i, 'Jitsi'],
  [/facetime\.apple\.com\//i, 'FaceTime'],
];

export const providerOf = (url: string) => VIDEO.find(([re]) => re.test(url))?.[1];

/** The first known video call link in these texts. */
export function videoIn(...texts: (string | undefined)[]): { provider: string; url: string } | undefined {
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(URL_RE)) {
      const provider = providerOf(m[0]);
      if (provider) return { provider, url: decodeEntities(m[0]).replace(/[.,;:]+$/, '') };
    }
  }
  return undefined;
}

const FREQ: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const DAYS: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };

/** RRULE -> "weekly", "every 2 weeks on Tuesday", "every weekday" ... */
export function recurrenceWords(rule: string | undefined): string | undefined {
  if (!rule) return undefined;
  const p = Object.fromEntries(rule.replace(/^RRULE:/i, '').split(';').map((kv) => kv.split('=')).map(([k, v]) => [String(k).toUpperCase(), v ?? '']));
  const unit = FREQ[String(p.FREQ).toUpperCase()];
  if (!unit) return undefined;
  const n = Number(p.INTERVAL || 1);
  const days = String(p.BYDAY ?? '').split(',').filter(Boolean).map((d) => d.slice(-2).toUpperCase());
  if (unit === 'week' && days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.includes(d))) return 'every weekday';
  const base = n > 1 ? `every ${n} ${unit}s` : unit === 'day' ? 'daily' : `${unit}ly`;
  if (unit === 'week' && days.length && days.length < 5) return `${base} on ${days.map((d) => DAYS[d]).filter(Boolean).join(' and ')}`;
  return base;
}

/** A display name, else a name from the address ("mike.chen@x" -> "Mike Chen"); never the address itself. */
export function personName(displayName: string | undefined, email: string | undefined): string {
  const n = String(displayName ?? '').replace(/["<>]/g, '').trim();
  if (n && !n.includes('@')) return n;
  const local = String(email || n).replace(/^mailto:/i, '').split('@')[0] ?? '';
  const words = local.replace(/[0-9]+/g, ' ').split(/[._+-]+/).map((w) => w.trim()).filter((w) => w.length > 1);
  if (!words.length) return 'someone';
  return words.slice(0, 3).map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
