// Device speech: the phone's own text-to-speech engine (Android TextToSpeech, iOS AVSpeechSynthesizer) through
// @capacitor-community/text-to-speech. On web the same calls use speechSynthesis, but core/voice uses Web Speech
// directly there; `available` is only true in the apps.
import { QueueStrategy, TextToSpeech } from '@capacitor-community/text-to-speech';
import { isNative } from './platform';

export interface DeviceVoice {
  /** engine voice name, stable per device (Android 'en-us-x-iol-local', iOS voice identifier) */
  id: string;
  name: string;
  /** BCP-47 */
  language: string;
  /** false = needs the internet */
  local: boolean;
}

export interface SpeakOptions {
  text: string;
  voiceId?: string;
  /** BCP-47, used when no voice is picked (default: the voice's language, else en-US) */
  language?: string;
  /** 1 = normal (0.5 .. 2) */
  rate?: number;
  /** 1 = normal (0.5 .. 2) */
  pitch?: number;
  /** 0 .. 1 */
  volume?: number;
}

interface RawVoice {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
}

let voiceCache: RawVoice[] | undefined;
const pending = new Set<() => void>();

const clamp = (v: number | undefined, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === 'UNAVAILABLE' || /not yet initialized/i.test(e?.message ?? '');
}

/** The engine binds asynchronously at app start: retry a few times instead of failing the first break. */
async function whenReady<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isUnavailable(err) || i >= 15) throw err;
      await sleep(250);
    }
  }
}

async function rawVoices(refresh = false): Promise<RawVoice[]> {
  if (!voiceCache || refresh) {
    const { voices } = await whenReady(() => TextToSpeech.getSupportedVoices());
    voiceCache = voices as RawVoice[];
  }
  return voiceCache;
}

let languageNames: Intl.DisplayNames | undefined;

function languageName(tag: string): string | undefined {
  try {
    languageNames ??= new Intl.DisplayNames([typeof navigator !== 'undefined' ? navigator.language : 'en'], { type: 'language' });
    return languageNames.of(tag);
  } catch {
    return undefined;
  }
}

/** Readable label ("Australian English · AUA"): Android names every voice after its language only. */
function label(v: RawVoice): string {
  const variant = /-x-([a-z0-9]+)-/i.exec(v.voiceURI)?.[1];
  const base = (/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(v.lang) && languageName(v.lang)) || v.name?.trim() || v.lang;
  return variant && !base.toLowerCase().includes(variant.toLowerCase()) ? `${base} · ${variant.toUpperCase()}` : base;
}

export const nativeTts = {
  available: isNative,

  /** Voices of the device engine; local (offline) voices first, then by language. */
  async voices(opts: { language?: string; refresh?: boolean } = {}): Promise<DeviceVoice[]> {
    const list = await rawVoices(opts.refresh);
    const want = opts.language?.toLowerCase();
    return list
      .filter((v) => !want || v.lang.toLowerCase().startsWith(want))
      .map((v) => ({ id: v.voiceURI, name: label(v), language: v.lang, local: v.localService }))
      .sort((a, b) => Number(b.local) - Number(a.local) || a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  },

  /** Speaks and resolves when the voice has finished (or was stopped). */
  async speak(opts: SpeakOptions): Promise<void> {
    const text = opts.text.trim();
    if (!text) return;
    let voice = -1;
    let language = opts.language;
    if (opts.voiceId) {
      let list = await rawVoices();
      let i = list.findIndex((v) => v.voiceURI === opts.voiceId);
      if (i < 0) {
        list = await rawVoices(true);
        i = list.findIndex((v) => v.voiceURI === opts.voiceId);
      }
      if (i >= 0) {
        voice = i;
        language = list[i]!.lang;
      }
    }
    // a new utterance flushes the old one; the engine then never reports it done, so settle it here
    settlePending();
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        pending.delete(done);
        resolve();
      };
      pending.add(done);
      whenReady(() =>
        TextToSpeech.speak({
          text,
          lang: language || 'en-US',
          rate: clamp(opts.rate, 0.5, 2, 1),
          pitch: clamp(opts.pitch, 0.5, 2, 1),
          volume: clamp(opts.volume, 0, 1, 1),
          voice,
          category: 'playback',
          queueStrategy: QueueStrategy.Flush,
        }),
      ).then(done, (err: unknown) => {
        pending.delete(done);
        reject(err instanceof Error ? err : new Error(String((err as { message?: string })?.message ?? err)));
      });
    });
  },

  async stop(): Promise<void> {
    settlePending();
    await TextToSpeech.stop().catch(() => {});
  },
};

function settlePending(): void {
  for (const done of [...pending]) done();
}
