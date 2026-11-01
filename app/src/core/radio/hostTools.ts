// Host editor helpers: "Describe your host" (AI fills the fields) and "Say something" (a real test line in the
// host's brain and voice, using the listener's real context).
import { isFallback, resolveBrain } from '../ai/brains';
import { generate } from '../ai/generate';
import { extractJson } from '../ai/json';
import { buildContext } from '../context/context';
import { defaultSegments, listBrains } from '../db';
import type { Brain, BreakLine, Host, Level, Station } from '../types';
import { playStandalone, speak } from '../voice/voice';
import { HOST_PRESETS } from './hostPresets';
import { planBreak } from './planner';
import { writeBreak } from './writer';

export type HostFields = Pick<Host, 'name' | 'tagline' | 'personality' | 'style' | 'energy' | 'humor' | 'verbosity' | 'catchphrases' | 'topics' | 'avoid'> & {
  emoji?: string;
};

const lvl = (x: unknown, d: Level): Level => {
  const n = Math.round(Number(x));
  return (n >= 1 && n <= 5 ? n : d) as Level;
};
const strs = (x: unknown, max = 6): string[] =>
  (Array.isArray(x) ? x : typeof x === 'string' ? x.split(',') : []).map((s) => String(s).trim()).filter(Boolean).slice(0, max);
const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** The brain to design with: the host's own, else the first real brain the user has. */
export async function designBrain(preferredId?: string | null): Promise<Brain | undefined> {
  const own = await resolveBrain(preferredId);
  if (!isFallback(own)) return own;
  return (await listBrains()).find((b) => !isFallback(b) && b.kind !== 'connector');
}

/** Offline fallback: the closest preset by keywords, with a name if the description gives one. */
export function designOffline(description: string): HostFields {
  const d = description.toLowerCase();
  const score = (keys: string[]) => keys.reduce((n, k) => n + (d.includes(k) ? 1 : 0), 0);
  const keys: Record<string, string[]> = {
    sunny: ['morning', 'sunny', 'bright', 'upbeat', 'coffee', 'cheer', 'happy'],
    storyteller: ['night', 'story', 'calm', 'soft', 'late', 'poet', 'quiet'],
    sports: ['sport', 'stats', 'hot take', 'fast', 'loud', 'game', 'hype'],
    chill: ['chill', 'lo-fi', 'lofi', 'relax', 'laid', 'surf', 'easy'],
    nerd: ['nerd', 'history', 'facts', 'vinyl', 'production', 'trivia', 'geek'],
    sidekick: ['funny', 'joke', 'comed', 'silly', 'sarcas', 'witty', 'prank'],
    calm: ['wellness', 'yoga', 'mindful', 'gentle', 'kind', 'breath', 'meditat'],
    classic: ['classic', 'old-school', 'smooth', 'fm', 'oldies', 'velvet', 'retro'],
  };
  const best = HOST_PRESETS.map((p) => ({ p, s: score(keys[p.id] ?? []) })).sort((a, b) => b.s - a.s)[0]!.p;
  const named = /\b(?:named|called|name is)\s+([A-Z][\w'-]{1,20})/i.exec(description)?.[1];
  const h = best.host;
  return {
    name: named ? named[0]!.toUpperCase() + named.slice(1) : h.name,
    tagline: h.tagline,
    personality: description.trim().length > 30 ? description.trim().slice(0, 400) : h.personality,
    style: h.style,
    energy: h.energy,
    humor: h.humor,
    verbosity: h.verbosity,
    catchphrases: h.catchphrases,
    topics: h.topics,
    avoid: [],
    emoji: h.avatar.kind === 'emoji' ? h.avatar.value : undefined,
  };
}

/** Reads "key": value pairs out of almost-JSON: strings, 1-5 numbers, string arrays and a bare emoji. */
export function looseFields(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of raw.matchAll(/"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\]|-?\d+(?:\.\d+)?|[^\s",}\]]+"?)/g)) {
    const key = m[1]!;
    const v = m[2]!;
    if (v.startsWith('"')) out[key] = v.slice(1, -1).replace(/\\"/g, '"');
    else if (v.startsWith('[')) out[key] = [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!);
    else if (/^-?\d/.test(v)) out[key] = Number(v);
    else out[key] = v.replace(/"$/, '');
  }
  return out;
}

/** Turns a free-text description into host fields with a brain (falls back to the offline designer). */
export async function designHost(description: string, brain?: Brain, signal?: AbortSignal): Promise<{ fields: HostFields; usedAi: boolean }> {
  if (!brain || isFallback(brain)) return { fields: designOffline(description), usedAi: false };
  const system = [
    'You design radio host characters for a personal AI radio app.',
    'Given a description, reply with one JSON object only:',
    '{"name": short first name, "tagline": max 6 words, "personality": 1-2 sentences about who they are,',
    '"style": 1 sentence about how they talk on air, "energy": 1-5, "humor": 1-5, "verbosity": 1-5,',
    '"catchphrases": 0-2 short phrases, "topics": 2-4 things they love to talk about, "avoid": topics they never touch,',
    '"emoji": one emoji for their avatar}.',
    'Keep it warm, specific and safe for all audiences. No markdown.',
  ].join(' ');
  const raw = await generate(brain, { system, messages: [{ role: 'user', content: description }], json: true, maxTokens: 500 }, { signal, timeoutMs: 60_000 });
  const parsed = extractJson(raw);
  // broken JSON (a small model forgot a quote): the scanner may only find an inner array, so read the keys one by one
  const j = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'name' in parsed ? (parsed as Record<string, unknown>) : looseFields(raw);
  if (!Object.keys(j).length) throw new Error('The brain did not return a host. Try again, or pick a personality above.');
  const off = designOffline(description);
  const emoji = str(j.emoji, 8);
  return {
    usedAi: true,
    fields: {
      name: str(j.name, 24) || off.name,
      tagline: str(j.tagline, 60) || off.tagline,
      personality: str(j.personality, 500) || off.personality,
      style: str(j.style, 300) || off.style,
      energy: lvl(j.energy, off.energy),
      humor: lvl(j.humor, off.humor),
      verbosity: lvl(j.verbosity, off.verbosity),
      catchphrases: strs(j.catchphrases, 3),
      topics: strs(j.topics, 5),
      avoid: strs(j.avoid, 5),
      emoji: /\p{Extended_Pictographic}/u.test(emoji) ? emoji : off.emoji,
    },
  };
}

/** A one-host station around `host` (unsaved edits included) for test lines. */
function soloStation(host: Host): Station {
  return {
    id: 'host-test',
    createdAt: 0,
    updatedAt: 0,
    name: 'Host-Caster',
    frequency: '88.1',
    color: '#ff5a36',
    sources: [{ kind: 'library' }],
    hostIds: [host.id],
    talkEvery: 1,
    talkLength: 'short',
    segments: { ...defaultSegments(), email: false, news: false },
    talkOverIntro: false,
    duckLevel: 0.18,
    newsFeeds: [],
    shuffle: false,
  };
}

/** "Say something": the host writes a short live line from your real context and says it in their voice. */
export async function sayTestLine(host: Host, opts: { onLines?: (lines: BreakLine[]) => void; signal?: AbortSignal } = {}): Promise<BreakLine[]> {
  const station = soloStation(host);
  const packet = await buildContext(station, {}, { budgetMs: 5000 });
  // one line: the opening's first topic, not a whole rundown of the day
  const opening = planBreak(station, packet, [], { kind: 'opening', hostCount: 1 });
  const plan = { ...opening, rundown: undefined, items: opening.items.slice(0, 1), topics: opening.topics.slice(0, 1), lines: 1 };
  const brain = await resolveBrain(host.brainId);
  const brains = new Map([[brain.id, brain]]);
  const { lines } = await writeBreak({ station, hosts: [host], brains, plan, packet, signal: opts.signal, timeoutMs: 60_000 });
  opts.onLines?.(lines);
  for (const line of lines) {
    if (opts.signal?.aborted) break;
    await playStandalone(await speak(host, line.text, { signal: opts.signal }), host.language);
  }
  return lines;
}
