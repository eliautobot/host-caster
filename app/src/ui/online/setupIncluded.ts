// Puts the plan's included AI to work: makes the "Host-Caster AI" brain and the "Host-Caster Voices" engine (once) and
// gives them to the chosen hosts. Used by onboarding and the plan page after a new plan.
import { listBrains, listHosts, listVoices, saveBrain, saveHost, saveVoiceProvider } from '@/core/db';
import { realBrainId } from '@/core/ai';
import type { Brain, Host, VoiceProvider } from '@/core/types';

/** Voices handed out in host order (warm female lead, then male, ...). */
export const INCLUDED_VOICE_ORDER = ['voxtral-sheila', 'voxtral-james', 'voxtral-mary', 'voxtral-david'];
/** The same order in premium voices (Premium plan); each one's stand-in is the standard voice at the same place. */
export const PREMIUM_VOICE_ORDER = ['eleven-sarah', 'eleven-brian', 'eleven-lily', 'eleven-george'];

export async function ensureHostCasterBrain(): Promise<Brain> {
  const found = (await listBrains()).find((b) => b.kind === 'hostcaster');
  if (found) return found;
  return saveBrain({ name: 'Host-Caster AI', kind: 'hostcaster', preset: 'hostcaster', model: 'hostcaster', transport: 'server', temperature: 0.9 });
}

export async function ensureHostCasterVoices(): Promise<VoiceProvider> {
  const found = (await listVoices()).find((v) => v.kind === 'hostcaster');
  if (found) return found;
  return saveVoiceProvider({ name: 'Host-Caster Voices', kind: 'hostcaster', transport: 'server', model: '' });
}

/**
 * Gives the included brain and/or voices to `hostIds` (all hosts when empty). Hosts that already use another real
 * brain or voice engine keep it unless `force`. premium = the plan has premium voices: hosts get those.
 */
export async function applyIncluded(opts: { brain?: boolean; voices?: boolean; premium?: boolean; hostIds?: string[]; force?: boolean }): Promise<Host[]> {
  const order = opts.premium ? PREMIUM_VOICE_ORDER : INCLUDED_VOICE_ORDER;
  const hosts = (await listHosts()).filter((h) => !opts.hostIds?.length || opts.hostIds.includes(h.id));
  const brain = opts.brain ? await ensureHostCasterBrain() : undefined;
  const voices = opts.voices ? await ensureHostCasterVoices() : undefined;
  const known = new Set((await listBrains()).map((b) => b.id));
  const changed: Host[] = [];
  let i = 0;
  for (const h of hosts) {
    const next: Host = { ...h, voice: { ...h.voice } };
    const id = realBrainId(h.brainId);
    if (brain && (opts.force || !id || !known.has(id))) next.brainId = brain.id;
    if (voices && (opts.force || !h.voice.voiceProviderId || h.voice.voiceProviderId === 'device')) {
      next.voice = { ...next.voice, voiceProviderId: voices.id, voiceId: order[i % order.length]! };
    }
    i++;
    if (next.brainId !== h.brainId || next.voice.voiceProviderId !== h.voice.voiceProviderId || next.voice.voiceId !== h.voice.voiceId) changed.push(await saveHost(next));
  }
  return changed;
}
