// The scripted fallback is a virtual brain (never stored, never a choice): it speaks for a host with no AI brain and
// stands in when the AI fails, is too slow, is out of reach or at a limit. Everything else lives in the brains table.
import { getBrain } from '../db';
import { FALLBACK_BRAIN_ID, LEGACY_BUILTIN_BRAIN_ID, type Brain, type Host } from '../types';

export const FALLBACK_BRAIN: Brain = {
  id: FALLBACK_BRAIN_ID,
  name: 'Scripted fallback',
  kind: 'builtin',
  preset: 'fallback',
  model: 'scripted',
  transport: 'device',
  createdAt: 0,
  updatedAt: 0,
};

/** True for the scripted fallback (no brain, a missing one, or a legacy built-in id). */
export function isFallback(brain: Pick<Brain, 'kind' | 'id'> | undefined | null): boolean {
  return !brain || brain.kind === 'builtin' || brain.id === FALLBACK_BRAIN_ID || brain.id === LEGACY_BUILTIN_BRAIN_ID;
}

/** A host's brain id, or null when they have no AI brain (empty, the legacy built-in id). */
export function realBrainId(id: string | null | undefined): string | null {
  return id && id !== LEGACY_BUILTIN_BRAIN_ID && id !== FALLBACK_BRAIN_ID ? id : null;
}

/** The brain for an id; the scripted fallback when there is none or it was deleted. */
export async function resolveBrain(id: string | null | undefined): Promise<Brain> {
  const real = realBrainId(id);
  if (!real) return FALLBACK_BRAIN;
  const brain = await getBrain(real);
  return brain && !isFallback(brain) ? brain : FALLBACK_BRAIN;
}

/** Short label for a brain ("OpenAI · gpt-4o-mini"). */
export function brainLabel(brain: Brain): string {
  if (isFallback(brain)) return 'No AI yet (scripted lines)';
  if (brain.kind === 'hostcaster') return `${brain.name} (included)`;
  return brain.model ? `${brain.name} · ${brain.model}` : brain.name;
}

/** True when the host thinks with a real AI brain that still exists (else the scripted fallback reads their lines). */
export function hasAi(host: Pick<Host, 'brainId'>, brains: Pick<Brain, 'id' | 'kind'>[]): boolean {
  const id = realBrainId(host.brainId);
  return Boolean(id && brains.some((b) => b.id === id && !isFallback(b) && b.kind !== 'connector'));
}

/** Home's "Your hosts are reading scripted lines" banner: every host on the mic has no AI brain, and not dismissed. */
export function showFallbackBanner(hosts: Pick<Host, 'brainId'>[], brains: Pick<Brain, 'id' | 'kind'>[], dismissed: boolean): boolean {
  return !dismissed && hosts.length > 0 && hosts.every((h) => !hasAi(h, brains));
}
