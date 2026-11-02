// The hosts' voices on a call: each reply is cut into sentences, the first is voiced and played as soon as it is
// ready while the next ones are voiced behind it, through the station's own voice engines (Host-Caster Voices, own
// keys, Kokoro, this device's voice). A voice that fails or is slow gives this device's voice for that sentence.
import { player } from '../player';
import { deviceStandIn } from '../radio/prepare';
import type { Host, VoiceClip } from '../types';
import { stopDeviceSpeech } from '../voice/device';
import { playClip, speak } from '../voice/voice';
import { sentences } from './phrases';
import type { HostLine, Mouth } from './session';

/** a sentence voice that takes longer than this is read by the device voice instead */
const SENTENCE_TIMEOUT_MS = 9000;
/** sentences voiced ahead of the one playing */
const AHEAD = 2;

export interface MouthOptions {
  /** measured: a sentence's voice took this long (ms) */
  onVoiced?: (ms: number) => void;
}

export function hostsMouth(hosts: Host[], opts: MouthOptions = {}): Mouth {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const cache = new Map<string, Promise<VoiceClip>>();
  let stopped = 0;

  const clip = (hostId: string, text: string): Promise<VoiceClip> => {
    const key = `${hostId}|${text}`;
    let p = cache.get(key);
    if (!p) {
      const host = byId.get(hostId) ?? hosts[0]!;
      const t0 = Date.now();
      p = speak(host, text, { timeoutMs: SENTENCE_TIMEOUT_MS })
        .then((c) => {
          opts.onVoiced?.(Date.now() - t0);
          return c;
        })
        .catch(() => speak(deviceStandIn(host), text));
      cache.set(key, p);
      // a long call should not keep every clip
      if (cache.size > 40) cache.delete(cache.keys().next().value!);
    }
    return p;
  };

  const parts = (lines: HostLine[]) => lines.flatMap((l, li) => sentences(l.text).map((text, si) => ({ hostId: l.hostId, text, line: li, first: si === 0 })));

  return {
    prime(lines) {
      for (const p of parts(lines).slice(0, AHEAD + 1)) void clip(p.hostId, p.text);
    },
    async say(lines, { signal, onLine }) {
      const all = parts(lines);
      const run = stopped;
      const cut = () => signal.aborted || run !== stopped;
      for (let i = 0; i < all.length; i++) {
        if (cut()) return;
        for (const p of all.slice(i, i + AHEAD + 1)) void clip(p.hostId, p.text);
        const p = all[i]!;
        const c = await Promise.race([clip(p.hostId, p.text), new Promise<undefined>((r) => signal.addEventListener('abort', () => r(undefined), { once: true }))]);
        if (!c || cut()) return;
        if (p.first) onLine(lines[p.line]!);
        try {
          const host = byId.get(p.hostId);
          await playClip(c, host?.language);
        } catch {
          // the clip could not play: the caption already said it
        }
      }
    },
    stop() {
      stopped++;
      player.stopVoice();
      stopDeviceSpeech();
    },
  };
}
