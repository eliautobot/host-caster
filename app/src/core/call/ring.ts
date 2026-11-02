// The call's own short sounds, made here (no audio files): one soft ring and the "on the line" click when the host
// picks up. Rendered once into a WAV and played on the player's voice channel, so they follow the app's volume.
import { player } from '../player';

const RATE = 22_050;

/** A WAV blob from mono samples (-1..1). */
export function wav(samples: Float32Array, rate = RATE): Blob {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([data.buffer], { type: 'audio/wav' });
}

/** The ring: two short warm bursts (440 + 480 Hz like a phone line, softened), then the pickup click. */
export function ringSamples(rate = RATE): Float32Array {
  const len = Math.round(rate * 1.05);
  const out = new Float32Array(len);
  const burst = (from: number, to: number) => {
    for (let i = Math.round(from * rate); i < Math.min(len, Math.round(to * rate)); i++) {
      const t = i / rate;
      const env = Math.min(1, (t - from) / 0.02, (to - t) / 0.04);
      out[i] = env * 0.16 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
    }
  };
  burst(0, 0.36);
  burst(0.46, 0.82);
  // the click: a short low knock with a fast decay
  for (let i = Math.round(0.95 * rate); i < len; i++) {
    const t = i / rate - 0.95;
    out[i] = Math.exp(-t * 90) * 0.35 * Math.sin(2 * Math.PI * 180 * t);
  }
  return out;
}

let ringClip: Blob | undefined;

/** Plays the ring; resolves when it is over (about one second), or at once when the call is cancelled. */
export async function ring(signal: AbortSignal): Promise<void> {
  ringClip ??= wav(ringSamples());
  if (signal.aborted) return;
  const stop = () => player.stopVoice();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await Promise.race([player.playSting(ringClip).catch(() => undefined), new Promise((r) => setTimeout(r, 1400))]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
