// Call-in by voice: native speech recognition (core/native) or the Web Speech API on web.
import { isNative, speechToText, stopSpeechToText } from '../native';

interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const g = globalThis as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

/** True when this device can turn the listener's voice into text. */
export function canListen(): boolean {
  return isNative || Boolean(recognitionCtor());
}

export interface ListenHandle {
  /** resolves with the final transcript ('' when nothing was heard) */
  result: Promise<string>;
  /** stop listening and resolve with what was heard so far */
  stop(): void;
}

/**
 * Starts listening. `onPartial` gets the running transcript on web. Native speech recognition returns once the
 * listener stops talking.
 */
export function listen(opts: { lang?: string; onPartial?: (text: string) => void } = {}): ListenHandle {
  if (isNative) {
    return { result: speechToText({ language: opts.lang }).then((t) => t ?? ''), stop: () => void stopSpeechToText() };
  }
  const Ctor = recognitionCtor();
  if (!Ctor) return { result: Promise.reject(new Error('Speech recognition is not available in this browser')), stop() {} };
  const rec = new Ctor();
  rec.lang = opts.lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  let text = '';
  const result = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      text = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .trim();
      opts.onPartial?.(text);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') resolve(text);
      else reject(new Error(e.error === 'not-allowed' ? 'Microphone access was blocked' : `Speech recognition failed (${e.error ?? 'unknown'})`));
    };
    rec.onend = () => resolve(text);
  });
  try {
    rec.start();
  } catch (err) {
    return { result: Promise.reject(err instanceof Error ? err : new Error(String(err))), stop() {} };
  }
  return { result, stop: () => rec.stop() };
}
