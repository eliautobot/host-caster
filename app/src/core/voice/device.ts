// Device speech: Web Speech on web, the native TTS plugin (core/native) on Android/iOS.
import { isNative, nativeTts } from '../native';
import type { VoiceOption } from '../types';
import { settleWithin } from '../util/abort';

const synth = (): SpeechSynthesis | undefined => (typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined);

export function deviceSpeechAvailable(): boolean {
  return isNative ? nativeTts.available : Boolean(synth());
}

let voicesPromise: Promise<SpeechSynthesisVoice[]> | undefined;

/** Browsers load voices lazily; wait for them (max 1.5 s). */
function webVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length) return Promise.resolve(now);
  voicesPromise ??= new Promise((resolve) => {
    const done = () => resolve(s.getVoices());
    s.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
  return voicesPromise.then((v) => {
    if (!v.length) voicesPromise = undefined;
    return v;
  });
}

export async function listDeviceVoices(): Promise<VoiceOption[]> {
  if (isNative) {
    const v = await nativeTts.voices();
    return v.map((x) => ({ id: x.id, name: x.name, language: x.language }));
  }
  const v = await webVoices();
  return v.map((x) => ({ id: x.voiceURI, name: x.name.replace(/^Microsoft |^Google /, ''), language: x.lang }));
}

async function pickVoice(voiceId: string, lang: string): Promise<SpeechSynthesisVoice | undefined> {
  const all = await webVoices();
  if (voiceId) {
    const exact = all.find((v) => v.voiceURI === voiceId || v.name === voiceId);
    if (exact) return exact;
  }
  const base = lang.split('-')[0]!.toLowerCase();
  const same = all.filter((v) => v.lang.toLowerCase().startsWith(base));
  // natural-sounding voices first
  return same.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ?? same.find((v) => v.default) ?? same[0];
}

/** Chrome stops long utterances after ~15 s: speak sentence groups one at a time. */
export function chunkSentences(text: string, max = 180): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (cur && (cur + ' ' + s).length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

let cancelled = 0;

/** time on top of a line's expected length before device speech counts as stuck (engines start slowly after a sleep) */
const NATIVE_SPEECH_SLACK_MS = 8000;
const STUCK = Symbol('stuck');

/** Speaks `text` live; resolves when done (or after a safety timeout so a stuck engine never stalls the show). */
export async function speakOnDevice(opts: { text: string; voiceId: string; rate: number; pitch: number; lang?: string }): Promise<void> {
  if (isNative) {
    // an engine that never reports the line done (its service went away while the app slept) must not hold the break
    // or every break after it: give up after the line's length with room to spare, and stop the engine
    const said = nativeTts.speak({ text: opts.text, voiceId: opts.voiceId || undefined, language: opts.lang, rate: opts.rate, pitch: opts.pitch });
    const words = opts.text.split(/\s+/).filter(Boolean).length;
    const limit = (words / (2.6 * Math.max(0.5, Math.min(2, opts.rate || 1)))) * 1000 + NATIVE_SPEECH_SLACK_MS;
    if ((await settleWithin(said, limit, STUCK)) === STUCK) await nativeTts.stop().catch(() => undefined);
    return;
  }
  const s = synth();
  if (!s) throw new Error('This browser cannot speak');
  const voice = await pickVoice(opts.voiceId, opts.lang ?? 'en');
  const token = cancelled;
  for (const part of chunkSentences(opts.text)) {
    if (token !== cancelled) return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(part);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? opts.lang ?? 'en';
      u.rate = Math.max(0.5, Math.min(2, opts.rate || 1));
      u.pitch = Math.max(0, Math.min(2, opts.pitch || 1));
      const words = part.split(/\s+/).length;
      const safety = setTimeout(resolve, (words / (2.6 * u.rate)) * 1000 + 4000);
      u.onend = u.onerror = () => {
        clearTimeout(safety);
        resolve();
      };
      s.speak(u);
    });
  }
}

export function stopDeviceSpeech(): void {
  cancelled++;
  if (isNative) void nativeTts.stop();
  else synth()?.cancel();
}
