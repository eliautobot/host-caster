// Speech to text for "Talk to the host": the phone's recognizer on Android/iOS, Web Speech in browsers that have it.
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition';
import { HostCasterAudio } from './plugin';
import { hasPlugin, isNative, platform } from './platform';

/** iOS: the recognizer switches the audio session to record; put playback (and the music) back afterwards. */
function restorePlayback(): void {
  if (platform === 'ios' && hasPlugin('HostCasterAudio')) void HostCasterAudio.restoreSession().catch(() => {});
}

export interface SpeechToTextOptions {
  /** BCP-47, default the browser/device language */
  language?: string;
  /** Android: text in the system dialog */
  prompt?: string;
  /** stop listening after this long (ms), default 15 s */
  timeoutMs?: number;
}

export type SpeechSupport = 'native' | 'web' | 'none';

interface WebSpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface WebSpeechRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: WebSpeechResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type WebSpeechCtor = new () => WebSpeechRecognition;

function webCtor(): WebSpeechCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: WebSpeechCtor; webkitSpeechRecognition?: WebSpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const defaultLang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

export async function speechSupport(): Promise<SpeechSupport> {
  if (isNative) {
    try {
      return (await SpeechRecognition.available()).available ? 'native' : 'none';
    } catch {
      return 'none';
    }
  }
  return webCtor() ? 'web' : 'none';
}

export type SpeechPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** Microphone/speech permission state, without asking. */
export async function speechPermission(): Promise<SpeechPermission> {
  if (!isNative) return webCtor() ? 'prompt' : 'unsupported';
  try {
    if (!(await SpeechRecognition.available()).available) return 'unsupported';
    const s = (await SpeechRecognition.checkPermissions()).speechRecognition;
    return s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'unsupported';
  }
}

/** Microphone/speech permission (asks when needed). */
export async function ensureSpeechPermission(): Promise<boolean> {
  if (!isNative) return Boolean(webCtor());
  const now = await SpeechRecognition.checkPermissions();
  if (now.speechRecognition === 'granted') return true;
  const asked = await SpeechRecognition.requestPermissions();
  return asked.speechRecognition === 'granted';
}

/**
 * Listens once and returns what was said, or undefined when nothing was understood, the user cancelled,
 * permission was refused or the device cannot do it.
 */
export async function speechToText(opts: SpeechToTextOptions = {}): Promise<string | undefined> {
  const language = opts.language ?? defaultLang();
  const timeoutMs = opts.timeoutMs ?? 15000;
  if (isNative) {
    if ((await speechSupport()) !== 'native') return undefined;
    if (!(await ensureSpeechPermission())) return undefined;
    const timer = setTimeout(() => void SpeechRecognition.stop().catch(() => {}), timeoutMs);
    try {
      const r = await SpeechRecognition.start({
        language,
        maxResults: 1,
        partialResults: false,
        popup: false,
        addPunctuation: true,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      });
      const text = r.matches?.[0]?.trim();
      return text || undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      restorePlayback();
    }
  }

  const Ctor = webCtor();
  if (!Ctor) return undefined;
  return new Promise((resolve) => {
    const rec = new Ctor();
    let text: string | undefined;
    rec.lang = language;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      text = e.results[0]?.[0]?.transcript?.trim() || undefined;
    };
    rec.onerror = () => {};
    rec.onend = () => {
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => rec.stop(), timeoutMs);
    try {
      rec.start();
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

/** Stop listening early (the pending speechToText resolves with what was heard so far, if anything). */
export async function stopSpeechToText(): Promise<void> {
  if (isNative) await SpeechRecognition.stop().catch(() => {});
}
