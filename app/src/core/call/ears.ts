// The listener's side of a call: speech to text, one utterance at a time, with live captions and the end of speech
// found by the recognizer itself. Android/iOS: the phone's own recognizer (no popup, partial results). Browsers: the
// Web Speech API where it exists (Chrome, Edge, Safari). There is no server or own-key speech-to-text in Host-Caster,
// so a browser without Web Speech (Firefox) takes typed words in the call instead.
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition';
import { ensureSpeechPermission, isNative, speechSupport } from '../native';
import { HostCasterAudio } from '../native/plugin';
import { hasPlugin, platform } from '../native/platform';
import { MicBlocked, type Ears, type ListenOptions } from './session';

interface WebResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface WebRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: WebResultEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type WebCtor = new () => WebRecognition;

function webCtor(): WebCtor | undefined {
  const g = globalThis as { SpeechRecognition?: WebCtor; webkitSpeechRecognition?: WebCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

const touch = () => typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0 && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

function webEars(lang: string): Ears {
  const Ctor = webCtor()!;
  return {
    kind: 'web',
    // a computer can listen while a host speaks (the echo check drops the host's own words); a phone browser's
    // recognizer would take the audio from the host
    overlap: !touch(),
    listen(opts: ListenOptions) {
      return new Promise<string>((resolve, reject) => {
        const rec = new Ctor();
        rec.lang = lang;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.continuous = false;
        let text = '';
        let settled = false;
        const end = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        rec.onresult = (e) => {
          text = Array.from(e.results)
            .map((r) => r[0]?.transcript ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (!opts.signal.aborted) opts.onPartial(text);
        };
        rec.onerror = (e) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') end(() => reject(new MicBlocked('Microphone access was blocked')));
        };
        rec.onend = () => end(() => (opts.signal.aborted ? reject(new Error('aborted')) : resolve(text)));
        const timer = setTimeout(() => rec.stop(), opts.maxMs);
        opts.signal.addEventListener('abort', () => {
          rec.abort();
          end(() => reject(new Error('aborted')));
        });
        opts.finish.addEventListener('abort', () => rec.stop());
        try {
          rec.start();
        } catch (err) {
          end(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      });
    },
  };
}

interface Handle {
  remove(): Promise<void>;
}

function nativeEars(lang: string): Ears {
  let asked = false;
  return {
    kind: 'native',
    // the phone's recognizer and the host's voice share one speaker and microphone: tap the mic to stop the host
    overlap: false,
    async listen(opts: ListenOptions) {
      if (!asked || platform === 'ios') {
        asked = true;
        if (!(await ensureSpeechPermission().catch(() => false))) throw new MicBlocked('Microphone access was refused');
      }
      const handles: Handle[] = [];
      let mine: number | undefined;
      let text = '';
      try {
        return await new Promise<string>((resolve, reject) => {
          let settled = false;
          const end = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
          };
          const timer = setTimeout(() => void SpeechRecognition.stop().catch(() => undefined), opts.maxMs);
          opts.signal.addEventListener('abort', () => {
            void SpeechRecognition.forceStop().catch(() => SpeechRecognition.stop().catch(() => undefined));
            end(() => reject(new Error('aborted')));
          });
          opts.finish.addEventListener('abort', () => void SpeechRecognition.stop().catch(() => undefined));
          void (async () => {
            handles.push(
              await SpeechRecognition.addListener('partialResults', (e) => {
                const t = (e.accumulatedText ?? e.matches?.[0] ?? '').trim();
                if (!t || settled) return;
                text = t;
                opts.onPartial(text);
              }),
              await SpeechRecognition.addListener('listeningState', (e) => {
                // the session this listen started; a late "stopped" from the one before is not ours
                if ((e.state === 'startingListening' || e.state === 'started') && mine === undefined) mine = e.sessionId;
                if ((e.state === 'stopped' || e.status === 'stopped') && mine !== undefined && e.sessionId === mine) end(() => resolve(text));
              }),
            );
            if (settled) return;
            try {
              await SpeechRecognition.start({ language: lang, maxResults: 1, partialResults: true, popup: false, addPunctuation: true, muteRecognizerBeep: true });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (/permission/i.test(msg)) end(() => reject(new MicBlocked(msg)));
              else end(() => resolve(text));
            }
          })();
        });
      } finally {
        await Promise.all(handles.map((h) => h.remove().catch(() => undefined)));
        // iOS: the recognizer switched the audio session to record; playback (the host's voice) needs it back
        if (platform === 'ios' && hasPlugin('HostCasterAudio')) void HostCasterAudio.restoreSession().catch(() => undefined);
      }
    },
  };
}

const noEars: Ears = {
  kind: 'none',
  overlap: false,
  listen: (opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
};

/** a test (debug builds) can put its own ears in: window.__hostcaster.call.useEars(new FakeEars()) */
let override: Ears | undefined;
export function useEars(ears: Ears | undefined): void {
  override = ears;
}

/** The best way this device has to hear the listener. */
export async function callEars(lang?: string): Promise<Ears> {
  if (override) return override;
  const language = lang || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  if (isNative) return (await speechSupport()) === 'native' ? nativeEars(language) : noEars;
  return webCtor() ? webEars(language) : noEars;
}
