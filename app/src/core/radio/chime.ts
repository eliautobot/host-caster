// Station ident: a short bell-like chime synthesized in code (WAV), different per station but always pleasant.

const RATE = 44_100;

/** Major-pentatonic steps keep any three notes consonant. */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface ChimeNote {
  /** seconds from the start */
  at: number;
  freq: number;
  /** seconds */
  decay: number;
  gain: number;
}

/** Three rising notes picked from the station seed (e.g. its frequency + name). */
export function chimeNotes(seed: string): ChimeNote[] {
  const h = seedOf(seed);
  const root = 523.25 * Math.pow(2, ((h % 5) - 2) / 12); // around C5
  const a = PENTA[h % 3]!;
  const b = PENTA[3 + ((h >> 3) % 2)]!;
  const c = PENTA[5 + ((h >> 5) % 3)]!;
  return [
    { at: 0, freq: root * Math.pow(2, a / 12), decay: 0.9, gain: 0.5 },
    { at: 0.17, freq: root * Math.pow(2, b / 12), decay: 0.9, gain: 0.48 },
    { at: 0.34, freq: root * Math.pow(2, c / 12), decay: 1.3, gain: 0.55 },
  ];
}

/** Renders the notes to mono float samples (soft attack, exponential decay, a little shimmer). */
export function renderChime(notes: ChimeNote[], seconds = 1.7): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (const note of notes) {
    const start = Math.round(note.at * RATE);
    for (let i = start; i < n; i++) {
      const t = (i - start) / RATE;
      const env = Math.min(1, t / 0.006) * Math.exp(-t / (note.decay * 0.42));
      if (t > 0.05 && env < 1e-4) break;
      const w = 2 * Math.PI * note.freq * t;
      const s = Math.sin(w) + 0.28 * Math.sin(2 * w + 0.3) + 0.08 * Math.sin(3.01 * w) + 0.05 * Math.sin(4.2 * w);
      out[i]! += s * env * note.gain;
    }
  }
  // gentle fade-out and peak normalize to -6 dBFS
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, (n - i) / (0.25 * RATE));
    out[i]! *= fade;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  const g = peak ? 0.5 / peak : 1;
  for (let i = 0; i < n; i++) out[i]! *= g;
  return out;
}

/** 16-bit PCM WAV bytes. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

const cache = new Map<string, Blob>();

/** The ident for a station, as a WAV blob (cached). */
export function identChime(seed: string): Blob {
  let blob = cache.get(seed);
  if (!blob) {
    blob = new Blob([encodeWav(renderChime(chimeNotes(seed))) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
    cache.set(seed, blob);
  }
  return blob;
}
