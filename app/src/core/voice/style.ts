// Speaking-style prompt for voices that take one (gpt-4o-mini-tts), built from the host.
import type { Host } from '../types';

const ENERGY = ['very calm and low-key', 'relaxed', 'warm and steady', 'upbeat', 'high-energy and lively'];
const HUMOR = ['earnest', 'mostly sincere', 'lightly playful', 'playful', 'cheeky and funny'];

export function voiceInstructions(host: Host): string {
  if (host.voice.instructions?.trim()) return host.voice.instructions.trim();
  const parts = [
    `You are ${host.name}, a radio host speaking live on air.`,
    host.style && `Style: ${host.style.trim().replace(/\.?$/, '.')}`,
    `Delivery: ${ENERGY[host.energy - 1] ?? 'warm'}, ${HUMOR[host.humor - 1] ?? 'friendly'}, natural pacing with real radio warmth.`,
    'Sound like a real person talking to one listener, not reading.',
  ];
  return parts.filter(Boolean).join(' ');
}

/** Text cleaned for speech engines: no markdown, emojis or stage directions. */
export function speechText(text: string): string {
  return text
    .replace(/\*\*?|__|`|#+\s/g, '')
    .replace(/\[[^\]]*\]|\([^)]*(?:laughs?|sighs?|pause|music|sfx)[^)]*\)/gi, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
