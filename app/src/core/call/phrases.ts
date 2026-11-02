// The live call's own words: how a host picks up, checks in after a silence, wraps up and signs off, and how the
// listener's words end a call. Pure (no network, no clock of its own), so the call machine and its tests share them.

const pick = <T>(bank: readonly T[], seed = Math.random()): T => bank[Math.floor(seed * bank.length) % bank.length]!;

const named = (name: string | undefined, withName: string, without: string) => (name ? withName.replace('{name}', name) : without);

/** "Hey Sam, you're on Host-Caster. What's up?" The first words of the call, said by the lead host. */
export function pickupLine(name: string | undefined, station: string, seed?: number): string {
  return pick(
    [
      named(name, `Hey {name}, you're on ${station}. What's up?`, `Hey, you're on ${station}. What's up?`),
      named(name, `${station}, you're on the air with me. Hi {name}, what's going on?`, `${station}, you're on the air with me. What's going on?`),
      named(name, `Hey {name}! Good to hear from you. What can I do for you?`, `Hey there, good to hear from you. What can I do for you?`),
    ],
    seed,
  );
}

/** After ~12 s without a word. */
export function stillThereLine(name: string | undefined, seed?: number): string {
  return pick([named(name, '{name}, you still there?', 'You still there?'), named(name, 'Hello? {name}, are you still with me?', 'Hello? Are you still with me?'), "I'm still here whenever you're ready."], seed);
}

/** After the check-in got no answer either: the host ends the call kindly. */
export function wrapUpLine(name: string | undefined, seed?: number): string {
  return pick(
    [
      named(name, "Sounds like you stepped away, {name}. I'll let you go and get the music back on. Call anytime.", "Sounds like you stepped away. I'll let you go and get the music back on. Call anytime."),
      named(name, "I think I lost you, {name}. No worries, I'll put the music back on. Talk soon.", "I think I lost you. No worries, I'll put the music back on. Talk soon."),
    ],
    seed,
  );
}

/** The host's last words when the listener hangs up. */
export function signOffLine(name: string | undefined, seed?: number): string {
  return pick(
    [named(name, 'Thanks for calling, {name}. Back to the music!', 'Thanks for calling. Back to the music!'), named(name, 'Anytime, {name}. Here comes the music.', 'Anytime. Here comes the music.'), named(name, 'Talk soon, {name}. Enjoy the music.', 'Talk soon. Enjoy the music.')],
    seed,
  );
}

/** Two minutes before the call's length cap. */
export function limitWarningLine(minutesLeft: number): string {
  return `Quick heads up, we have about ${minutesLeft === 1 ? 'a minute' : `${minutesLeft} minutes`} left on this call.`;
}

/** The cap was reached. */
export function limitLine(name: string | undefined): string {
  return named(name, "That's our time for this call, {name}. Call back anytime. Here's the music.", "That's our time for this call. Call back anytime. Here's the music.");
}

export const HOLD_LINES = ['One sec, let me pull that up.', 'Good question. Give me a second to check.', "Hang on, I'm looking that up right now.", 'Let me check that for you, one moment.'] as const;

/** A station whose hosts have no AI brain: an honest call that still takes song requests and notes. */
export function noBrainLine(name: string | undefined): string {
  return named(
    name,
    "Hey {name}! Heads up, my AI brain is off right now, so I can only take song requests and notes. Want me to play something, or should I write something down?",
    'Hey! Heads up, my AI brain is off right now, so I can only take song requests and notes. Want me to play something, or should I write something down?',
  );
}

export const NO_BRAIN_REPLY = "Sorry, I can't help with that one while my AI brain is off. I can play a song for you, or write a note down. Set up an AI brain in Settings for the full call.";

export const LOST_LINE = 'Sorry, I lost my train of thought there. Can you say that again?';

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const BYE = [
  /\b(good ?bye|bye( bye)?|see ya|see you|talk (to you )?(later|soon)|catch you later|gotta go|got to go|have to go|i'?ll let you go|hang up|end (the )?call)\b|^(ok(ay)? |alright |cool )?later$/,
  /\b(that'?s (all|it|everything)|that is (all|it|everything)|that'?ll be all|nothing else|i'?m (all )?(good|done|set)|we'?re (good|done)|all (good|set)|no that'?s (it|all))\b/,
];

/**
 * Does the listener end the call ("bye", "that's all", "thanks, that's it")? Only short replies count, and a
 * question never ends a call ("is that all I have tomorrow?").
 */
export function isGoodbye(said: string): boolean {
  if (/\?\s*$/.test(said.trim())) return false;
  const s = norm(said);
  if (!s) return false;
  // a question never ends a call, with or without its question mark
  if (/^(what|when|where|who|why|how|is|are|can|could|do|does|did|will|would|should|tell)\b/.test(s)) return false;
  const words = s.split(' ');
  if (words.length > 9) return false;
  // "add dentist Friday, that's it" is a task with a tail, not a goodbye: the goodbye must be most of it
  const hit = BYE.find((re) => re.test(s));
  if (!hit) return false;
  const rest = s
    .replace(hit, ' ')
    .replace(/\b(ok(ay)?|alright|great|cool|perfect|awesome|yeah|yes|yep|no|nope|well|so|oh|and|then|for now|today|now|thanks?|thank you|thank you so much|much|appreciate it|man|buddy|guys|again|really|very|bye|have a good (one|day|night)|you too)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return rest.split(' ').filter(Boolean).length <= 2;
}

/**
 * A reply cut into sentences for speaking one after the other (the first is voiced while the brain's later sentences
 * are still on their way). Very short pieces join the next one so a voice never says a lone "Sure."
 */
export function sentences(text: string, minChars = 18): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=["'“A-Z0-9])/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let carry = '';
  for (const p of parts) {
    const s = carry ? `${carry} ${p}` : p;
    if (s.length < minChars) carry = s;
    else {
      out.push(s);
      carry = '';
    }
  }
  if (carry) {
    if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${carry}`;
    else out.push(carry);
  }
  return out;
}

/** "3:07" for the call timer. */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
