// Turns model output into clean, speakable break lines mapped to hosts. Tolerant: JSON in any common shape, code
// fences, prose around it, or plain "Name: text" lines.
import { extractJson } from '../ai/json';
import type { BreakLine, Host } from '../types';

const ACTIONS = /laugh|chuckle|giggle|sigh|pause|beat|music|sfx|sound|applause|cheer|smil|grin|clears|whisper|excited|upbeat|warmly|softly|intro|outro|jingle/i;

/** Cleans one spoken line: no markdown, emojis, stage directions, speaker labels or wrapping quotes. */
export function cleanLine(text: string, names: string[] = []): string {
  let t = text.replace(/\r?\n+/g, ' ').replace(/\*\*|__/g, '');
  // JSON debris from a broken script: ”}, { "host": "Jules", "text": "
  t = t.replace(/["”]?\s*\}\s*,?\s*\{\s*(?:"?(?:host|speaker|name)"?\s*:\s*"[^"]{0,40}"\s*,\s*)?(?:"?(?:text|line|says|content)"?\s*:\s*)?"?/g, ' ');
  // stage directions: *laughs*, (pause), [music swells]
  t = t.replace(/\*[^*]{1,40}\*/g, (m) => (ACTIONS.test(m) ? ' ' : m.replace(/\*/g, '')));
  t = t.replace(/\(([^)]{1,40})\)/g, (m, inner: string) => (ACTIONS.test(inner) ? ' ' : m));
  t = t.replace(/\[[^\]]{0,60}\]/g, ' ');
  // markdown
  t = t.replace(/\*\*|__|`+|^#+\s*/g, '').replace(/^\s*[-*•]\s+/, '');
  // emojis
  t = t.replace(/\p{Extended_Pictographic}️?|‍/gu, '');
  // a leading speaker label ("Maya:", "MAYA -")
  const label = names.length ? new RegExp(`^\\s*(?:${names.map(escapeRe).join('|')})\\s*[:\\-–—]\\s*`, 'i') : /^\s*[A-Z][\w .']{0,20}:\s+/;
  t = t.replace(label, '');
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
  // wrapping quotes
  if (/^["“].*["”]$/.test(t) && !/["“”]/.test(t.slice(1, -1))) t = t.slice(1, -1).trim();
  // a stray closing quote left over from broken JSON
  const opens = (t.match(/“/g) ?? []).length;
  const closes = (t.match(/”/g) ?? []).length;
  if (closes > opens && t.endsWith('”')) t = t.slice(0, -1).trim();
  if ((t.match(/"/g) ?? []).length % 2 === 1 && t.endsWith('"')) t = t.slice(0, -1).trim();
  // a dangling opening quote or a comma after the last full stop: “ / !,
  t = t.replace(/\s*[“"]$/, '').replace(/([.!?])[,;:]+$/, '$1').trim();
  // a spoken line ends like a sentence (voices fall in pitch at a full stop)
  if (/[\p{L}\p{N}]$/u.test(t)) t += '.';
  return t;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RawLine {
  host?: unknown;
  speaker?: unknown;
  name?: unknown;
  text?: unknown;
  line?: unknown;
  says?: unknown;
  content?: unknown;
}

function rawLines(value: unknown): RawLine[] | undefined {
  if (Array.isArray(value)) return value as RawLine[];
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of ['lines', 'script', 'break', 'dialogue', 'dialog', 'conversation']) {
      if (Array.isArray(o[k])) return o[k] as RawLine[];
    }
  }
  return undefined;
}

export function matchHost(name: string, hosts: Host[]): Host | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return (
    hosts.find((h) => h.name.toLowerCase() === n) ??
    hosts.find((h) => h.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]) ??
    hosts.find((h) => n.includes(h.name.toLowerCase()))
  );
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s.replace(/\n/g, ' ').replace(/(?<!\\)"/g, '\\"')}"`) as string;
  } catch {
    return s.replace(/\\(["\\/])/g, '$1').replace(/\\n/g, ' ');
  }
}

/** the end of one JSON line object and the start of the next, left inside a text value: ”}, { */
const DEBRIS = /["”]\s*\}\s*,?\s*\{\s*/;

/**
 * A text closed with a curly quote runs on into the next line object (”}, { Here's...): split it there. The part
 * after the debris keeps its own host key when it has one, else it goes to the next host.
 */
export function splitDebris(host: string | undefined, text: string): { host?: string; text: string }[] {
  return text.split(DEBRIS).map((part, i) => {
    if (!i) return { host, text: part };
    const key = /^\s*"?(?:host|speaker|name)"?\s*:\s*"([^"]{1,40})"\s*,\s*(?:"?(?:text|line|says|content)"?\s*:\s*"?)?/.exec(part);
    return { host: key?.[1], text: key ? part.slice(key[0].length) : part };
  });
}

/**
 * Broken JSON (small local models): pull each {"host": ..., "text": ...} pair out with a regex. A text value with
 * no closing quote runs to the end of its line.
 */
export function lenientLines(raw: string): RawLine[] {
  const out: RawLine[] = [];
  const re = /"(?:host|speaker|name)"\s*:\s*"([^"\n]{1,40})"\s*,?\s*"(?:text|line|says|content)"\s*:\s*"((?:[^"\\\n]|\\.)*)/g;
  for (const m of raw.matchAll(re)) {
    for (const part of splitDebris(m[1], unescapeJson(m[2]!))) {
      const text = part.text.replace(/["”]?\s*[}\]]+\s*,?\s*$/, '').trim();
      if (text) out.push({ host: part.host, text });
    }
  }
  return out;
}

/** Parses a whole-break script. Throws when nothing speakable comes out. */
export function parseScript(raw: string, hosts: Host[], maxLines = 10): BreakLine[] {
  if (!hosts.length) throw new Error('No hosts');
  const names = hosts.map((h) => h.name);
  const out: BreakLine[] = [];
  let next = 0;
  const push = (who: string | undefined, text: string) => {
    const host = (who && matchHost(who, hosts)) || hosts[next % hosts.length]!;
    const clean = cleanLine(text, names);
    if (!clean || !/[a-z0-9]/i.test(clean)) return;
    // the same host twice in a row: join into one line
    const prev = out[out.length - 1];
    if (prev && prev.hostId === host.id && hosts.length > 1) prev.text = `${prev.text} ${clean}`;
    else out.push({ hostId: host.id, text: clean });
    next = hosts.indexOf(host) + 1;
  };

  let lines = rawLines(extractJson(raw));
  if (!lines?.length) {
    const loose = lenientLines(raw);
    if (loose.length) lines = loose;
  }
  if (lines?.length) {
    for (const l of lines) {
      if (typeof l === 'string') {
        const m = /^\s*([^:]{1,24}):\s*(.+)$/s.exec(l);
        push(m?.[1], m ? m[2]! : l);
        continue;
      }
      const who = [l.host, l.speaker, l.name].find((x) => typeof x === 'string') as string | undefined;
      const text = [l.text, l.line, l.says, l.content].find((x) => typeof x === 'string') as string | undefined;
      if (text) for (const part of splitDebris(who, text)) push(part.host, part.text);
    }
  } else {
    // plain text: "Maya: ...", or just paragraphs
    const label = new RegExp(`^\\s*\\**(${names.map(escapeRe).join('|')})\\**\\s*[:\\-–—]\\s*(.+)$`, 'i');
    for (const para of raw.replace(/```\w*/g, '').split(/\n+/)) {
      // skip JSON debris ({"lines":[]}, "host": ...) that did not parse
      if (!para.trim() || /^\s*[{}[\]]/.test(para) || /"\w+"\s*:/.test(para)) continue;
      const m = label.exec(para);
      push(m?.[1], m ? m[2]! : para);
    }
  }
  if (!out.length) throw new Error('The brain did not write any lines');
  return out.slice(0, maxLines);
}

const squash = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();

/** Small models sometimes repeat the line before theirs first: drop an echo of a transcript line at the start. */
export function dropEcho(text: string, transcript: string[]): string {
  let t = text.trim();
  for (const prev of [...transcript].reverse()) {
    const p = squash(prev);
    if (p.length < 12) continue;
    const words = t.split(/\s+/);
    // find the shortest prefix of `t` that squashes to `p`
    for (let n = 1; n <= words.length; n++) {
      const head = squash(words.slice(0, n).join(' '));
      if (head === p) {
        t = words.slice(n).join(' ').trim();
        break;
      }
      if (head.length > p.length) break;
    }
  }
  return t;
}

/** One line from turn-by-turn generation. */
export function parseTurn(raw: string, speaker: Host, hosts: Host[], transcript: string[] = []): string {
  const j = extractJson(raw);
  let text = raw;
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    const lines = rawLines(j);
    const first = lines?.find((l) => matchHost(String(l.host ?? l.speaker ?? ''), hosts)?.id === speaker.id) ?? lines?.[0];
    text = String(o.text ?? o.line ?? first?.text ?? first?.line ?? raw);
  }
  // models sometimes continue with the other host's turn: keep only the speaker's part
  const others = hosts.filter((h) => h.id !== speaker.id).map((h) => escapeRe(h.name));
  if (others.length) text = text.split(new RegExp(`\\n\\s*\\**(?:${others.join('|')})\\**\\s*:`, 'i'))[0]!;
  const clean = dropEcho(cleanLine(text, hosts.map((h) => h.name)), transcript);
  if (!clean || !/[a-z0-9]/i.test(clean)) throw new Error(`${speaker.name}'s brain returned nothing to say`);
  return clean;
}
