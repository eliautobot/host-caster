// Voice provider presets for the Voices page and default models per kind.
import type { VoiceKind, VoiceOption } from '../types';

export interface VoicePreset {
  id: string;
  name: string;
  kind: VoiceKind;
  baseUrl: string;
  model: string;
  keyRequired: boolean;
  keyUrl?: string;
  note?: string;
  /** voice to pick first for a new host */
  defaultVoice: string;
}

/** Host-Caster Voices (online edition only): the service's curated voices, included with a plan. */
export const HOSTCASTER_VOICES_PRESET: VoicePreset = {
  id: 'hostcaster', name: 'Host-Caster Voices', kind: 'hostcaster', baseUrl: '', model: '', keyRequired: false, defaultVoice: 'voxtral-sheila',
  note: 'Included with the Voices, Everything and Premium plans. The Premium plan adds 21 ElevenLabs voices with their own monthly allowance.',
};

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts',
    keyRequired: true, keyUrl: 'https://platform.openai.com/api-keys', defaultVoice: 'coral',
    note: 'Natural voices that follow each host’s style.' },
  { id: 'elevenlabs', name: 'ElevenLabs', kind: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', model: 'eleven_flash_v2_5',
    keyRequired: true, keyUrl: 'https://elevenlabs.io/app/settings/api-keys', defaultVoice: '',
    note: 'Studio voices, including your own cloned ones.' },
  { id: 'kokoro', name: 'Kokoro', kind: 'openai-compatible', baseUrl: 'http://localhost:8880/v1', model: 'kokoro',
    keyRequired: false, defaultVoice: 'af_heart', note: 'Free, fast and local (Kokoro-FastAPI).' },
  { id: 'chatterbox', name: 'Chatterbox', kind: 'openai-compatible', baseUrl: 'http://localhost:8004/v1', model: 'chatterbox',
    keyRequired: false, defaultVoice: '', note: 'Expressive local voices.' },
  { id: 'qwen3-tts', name: 'Qwen3-TTS', kind: 'openai-compatible', baseUrl: 'http://localhost:8001/v1', model: 'qwen3-tts',
    keyRequired: false, defaultVoice: '' },
  { id: 'orpheus', name: 'Orpheus', kind: 'openai-compatible', baseUrl: 'http://localhost:5005/v1', model: 'orpheus',
    keyRequired: false, defaultVoice: 'tara' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai-compatible', baseUrl: '', model: 'tts-1',
    keyRequired: false, defaultVoice: '', note: 'Any server with /v1/audio/speech (openedai-speech, LocalAI ...).' },
];

export function getVoicePreset(id: string | undefined): VoicePreset | undefined {
  if (id === HOSTCASTER_VOICES_PRESET.id) return HOSTCASTER_VOICES_PRESET;
  return VOICE_PRESETS.find((p) => p.id === id);
}

export const DEFAULT_MODEL: Record<VoiceKind, string> = {
  device: '',
  openai: 'gpt-4o-mini-tts',
  elevenlabs: 'eleven_flash_v2_5',
  'openai-compatible': 'tts-1',
  hostcaster: '',
};

/** OpenAI's built-in voices (also accepted by most OpenAI-compatible servers). */
export const OPENAI_VOICES: VoiceOption[] = [
  { id: 'alloy', name: 'Alloy', gender: 'neutral' },
  { id: 'ash', name: 'Ash', gender: 'male' },
  { id: 'ballad', name: 'Ballad', gender: 'male' },
  { id: 'coral', name: 'Coral', gender: 'female' },
  { id: 'echo', name: 'Echo', gender: 'male' },
  { id: 'fable', name: 'Fable', gender: 'neutral' },
  { id: 'nova', name: 'Nova', gender: 'female' },
  { id: 'onyx', name: 'Onyx', gender: 'male' },
  { id: 'sage', name: 'Sage', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', gender: 'female' },
  { id: 'verse', name: 'Verse', gender: 'male' },
  { id: 'marin', name: 'Marin', gender: 'female' },
  { id: 'cedar', name: 'Cedar', gender: 'male' },
];

/** "af_heart" -> "Heart", with language/gender from the Kokoro naming scheme. */
export function kokoroVoice(id: string): VoiceOption {
  const m = /^([a-z])([fm])_(.+)$/.exec(id);
  if (!m) return { id, name: id };
  const lang: Record<string, string> = { a: 'en-US', b: 'en-GB', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-BR', z: 'zh' };
  const name = m[3]!.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, name, language: lang[m[1]!], gender: m[2] === 'f' ? 'female' : 'male' };
}
