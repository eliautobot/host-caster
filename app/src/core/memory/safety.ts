// What may become a memory (pure). Never: passwords, codes, card or account numbers, IDs, email addresses, links.
// Sensitive (health, money, relationships, religion, politics): only when the listener asked to remember it in so
// many words. And a learned card must be grounded: its words come from what the listener said (or from the cards
// it replaces), so text from anywhere else (an email, a web page, the news) can never plant a memory.
import { MONTH_NAMES, WEEKDAY_NAMES, contentWords } from './text';

const SECRET =
  /\b(pass ?words?|passcodes?|pins?|pin (code|number)|security (code|question)|cvv|cvc|ssn|social security|account (number|no)|routing number|card number|credit card|debit card|iban|swift|passport|driver'?s licen[cs]e|licen[cs]e (number|plate)|log ?in|username|verification code|one[- ]time code|otp|2fa|recovery (code|phrase)|seed phrase|private key|api key|token)\b/i;
/** 4+ digits in a row (or groups like 1234 5678), except a year (1900-2099) */
const DIGITS = /\d[\d -]{4,}\d|\b(?!(19|20)\d\d\b)\d{4,}\b/;
const CONTACT = /@|https?:\/\/|www\.|\.(com|org|net|io)\b/i;

const SENSITIVE: [string, RegExp][] = [
  ['health', /\b(doctor|hospital|surgery|diagnos\w*|cancer|diabet\w*|pregnan\w*|therap\w*|medication|meds|depress\w*|anxiety|illness|disease|pills?|rehab|mental health|adhd|hiv|chemo\w*|disorder|injur\w*|sick|symptoms?|addict\w*)\b/i],
  ['money', /\b(debts?|loans?|mortgage|salary|income|bankrupt\w*|bank account|credit score|broke|owe|owes|paycheck|savings|finances?|financial)\b/i],
  ['relationships', /\b(divorc\w*|break ?up|broke up|separated|affair|cheat\w*|my ex|dating|single again)\b/i],
  ['religion', /\b(church|mosque|synagogue|temple|pray\w*|religio\w*|faith|god|jesus|allah|bible|quran|torah|atheist|muslim|christian|jewish|hindu|buddhist)\b/i],
  ['politics', /\b(vot(e|ed|ing)|election|democrat\w*|republican\w*|liberal|conservative|politic\w*|left[- ]wing|right[- ]wing|congress|senator|president)\b/i],
];

/** A password, a code, a card or account number, an ID, an address to reach someone: never kept. */
export function isSecret(text: string): boolean {
  return SECRET.test(text) || DIGITS.test(text) || CONTACT.test(text);
}

/** The sensitive topic a text is about, if any. */
export function sensitiveTopic(text: string): string | undefined {
  return SENSITIVE.find(([, re]) => re.test(text))?.[0];
}

const DATE_WORDS = new Set([...MONTH_NAMES, ...WEEKDAY_NAMES, 'weekend', 'week', 'month', 'today', 'tonight', 'tomorrow', 'morning', 'evening', 'afternoon'].map((w) => w.slice(0, 5)));
const NAME = /\b[A-Z][a-z]{2,}\b/g;
const NOT_NAMES = new Set(['You', 'Your', 'The', 'They', 'She', 'His', 'Her', 'And', 'But', 'Likes', 'Loves', 'Skips', 'Often', 'Usually', 'Works', 'Lives']);

/**
 * Do the card's words come from `sources`? Every name and number in it must be there, and most of its other words
 * (dates written out are allowed: "next weekend" may become "the weekend of November 7").
 */
export function grounded(card: string, sources: string[]): boolean {
  const src = sources.join(' ');
  const srcLower = src.toLowerCase();
  const names = (card.match(NAME) ?? []).filter((n) => !NOT_NAMES.has(n));
  const sw = new Set(contentWords(src));
  for (const n of names) {
    const low = n.toLowerCase();
    if (MONTH_NAMES.includes(low) || WEEKDAY_NAMES.includes(low)) continue;
    if (!srcLower.includes(low)) {
      // the first word of a sentence is capitalized anyway: a common word is fine if it is in the sources' words
      if (!contentWords(n).every((w) => sw.has(w))) return false;
    }
  }
  const numbers = card.match(/\d+/g) ?? [];
  const srcNumbers = new Set(src.match(/\d+/g) ?? []);
  // a number written out by the date (the 7 in "November 7") is allowed when the card names a month or weekday
  const datey = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(card);
  for (const n of numbers) if (!srcNumbers.has(n) && !(datey && Number(n) <= 31) && !(datey && /^20\d\d$/.test(n))) return false;
  const words = contentWords(card).filter((w) => !DATE_WORDS.has(w) && !/^\d+$/.test(w));
  if (!words.length) return false;
  const hit = words.filter((w) => sw.has(w)).length;
  return hit / words.length >= 0.6;
}

export interface Verdict {
  ok: boolean;
  /** why not: 'secret' (never kept), 'sensitive' (not without being asked), 'ungrounded' (not from their words) */
  problem?: 'secret' | 'sensitive' | 'ungrounded' | 'empty';
  sensitive?: string;
}

/**
 * May this text become a card? `asked` = the listener said "remember that ..." (or typed it in the app): a
 * sensitive topic is then kept, marked sensitive. `sources` = the words it must come from (learned cards only).
 */
export function checkCard(text: string, opts: { asked: boolean; sources?: string[] }): Verdict {
  const t = text.trim();
  if (t.length < 3) return { ok: false, problem: 'empty' };
  if (isSecret(t)) return { ok: false, problem: 'secret' };
  const topic = sensitiveTopic(t);
  if (topic && !opts.asked) return { ok: false, problem: 'sensitive', sensitive: topic };
  if (opts.sources && !grounded(t, opts.sources)) return { ok: false, problem: 'ungrounded' };
  return { ok: true, ...(topic ? { sensitive: topic } : {}) };
}
