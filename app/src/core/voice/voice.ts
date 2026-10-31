// core/voice: speak() turns a host line into a clip; playClip() airs it over the music.
import { getJson, joinUrl, mergeSignal, postForBlob, ProviderError } from '../ai/http';
import { api, ttsProxy } from '../api';
import { getVoiceProvider } from '../db';
import { player } from '../player';
import { DEVICE_VOICE_ID, type Host, type VoiceClip, type VoiceOption, type VoiceProvider } from '../types';
import { listDeviceVoices, speakOnDevice, stopDeviceSpeech } from './device';
import { DEFAULT_MODEL, kokoroVoice, OPENAI_VOICES } from './presets';
import { speechText, voiceInstructions } from './style';

const ELEVEN_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel", a premade voice every account has

export interface SpeakOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function deviceClip(host: Host, text: string): VoiceClip {
  return { kind: 'device', text, voiceId: host.voice.voiceId, rate: host.voice.speed || 1, pitch: host.voice.pitch || 1 };
}

const baseOf = (p: VoiceProvider) =>
  p.baseUrl || (p.kind === 'elevenlabs' ? 'https://api.elevenlabs.io' : p.kind === 'openai' ? 'https://api.openai.com/v1' : '');

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Synthesizes one line in the host's voice with a given provider. */
export async function synthesize(provider: VoiceProvider, host: Host, text: string, opts: SpeakOptions = {}): Promise<Blob> {
  const input = speechText(text);
  const fo = { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 40_000 };
  const speed = host.voice.speed || 1;
  // Host-Caster Voices always run on the Host-Caster service (included with the plan)
  if (provider.transport === 'server' || provider.kind === 'hostcaster') {
    if (!api.available) throw new ProviderError(`${provider.name} runs through your Host-Caster server, which is not reachable`);
    return ttsProxy.speak(
      { voiceProviderId: provider.id, voiceId: host.voice.voiceId, text: input, speed, instructions: voiceInstructions(host) },
      { signal: mergeSignal(fo), provider },
    );
  }
  if (provider.kind === 'elevenlabs') {
    const voice = host.voice.voiceId || ELEVEN_DEFAULT_VOICE;
    const url = joinUrl(baseOf(provider), `v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`);
    return postForBlob(
      url,
      {
        text: input,
        model_id: provider.model || DEFAULT_MODEL.elevenlabs,
        voice_settings: { stability: 0.6 - host.energy * 0.06, similarity_boost: 0.8, style: (host.humor - 1) * 0.08, speed: clamp(speed, 0.7, 1.2) },
      },
      { 'xi-api-key': provider.apiKey ?? '', Accept: 'audio/mpeg' },
      fo,
    );
  }
  const base = baseOf(provider);
  if (!base) throw new ProviderError(`${provider.name} has no server address`);
  const model = provider.model || DEFAULT_MODEL[provider.kind];
  const body: Record<string, unknown> = {
    model,
    voice: host.voice.voiceId || (provider.kind === 'openai' ? 'coral' : 'alloy'),
    input,
    response_format: 'mp3',
    speed: clamp(speed, 0.25, 4),
  };
  // style prompts: gpt-4o-mini-tts (and servers that copy its API) follow them
  if (/gpt-4o.*tts|instruct/i.test(model)) body.instructions = voiceInstructions(host);
  const headers: Record<string, string> = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
  return postForBlob(joinUrl(base, 'audio/speech'), body, headers, fo);
}

/** A host line -> a voice clip. Device voices return a 'device' clip that is spoken live by playClip. */
export async function speak(host: Host, text: string, opts: SpeakOptions = {}): Promise<VoiceClip> {
  if (host.voice.voiceProviderId === DEVICE_VOICE_ID || !host.voice.voiceProviderId) return deviceClip(host, speechText(text));
  const provider = await getVoiceProvider(host.voice.voiceProviderId);
  if (!provider || provider.kind === 'device') return deviceClip(host, speechText(text));
  return { kind: 'audio', blob: await synthesize(provider, host, text, opts) };
}

/** Plays a clip over the music (audio through the player's voice gain; device clips spoken live). */
export async function playClip(clip: VoiceClip, lang?: string): Promise<void> {
  if (clip.kind === 'audio') return player.playVoice(clip.blob);
  return speakOnDevice({ text: clip.text, voiceId: clip.voiceId, rate: clip.rate, pitch: clip.pitch, lang });
}

let preview: HTMLAudioElement | undefined;

/** Plays a clip on its own (previews, tests): no player or music needed. */
export async function playStandalone(clip: VoiceClip, lang?: string): Promise<void> {
  stopPreview();
  if (clip.kind === 'device') return speakOnDevice({ text: clip.text, voiceId: clip.voiceId, rate: clip.rate, pitch: clip.pitch, lang });
  const url = URL.createObjectURL(clip.blob);
  const el = new Audio(url);
  preview = el;
  try {
    await new Promise<void>((resolve, reject) => {
      el.onended = () => resolve();
      el.onpause = () => resolve();
      el.onerror = () => reject(new Error('This device could not play the voice'));
      el.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
    if (preview === el) preview = undefined;
  }
}

export function stopPreview(): void {
  preview?.pause();
  preview = undefined;
  stopDeviceSpeech();
}

export async function listVoices(provider: VoiceProvider | typeof DEVICE_VOICE_ID): Promise<VoiceOption[]> {
  if (provider === DEVICE_VOICE_ID || provider.kind === 'device') return listDeviceVoices();
  if (provider.transport === 'server' || provider.kind === 'hostcaster') {
    if (!api.available) throw new ProviderError('Your Host-Caster server is not reachable');
    return (await ttsProxy.voices(provider.id, provider)).voices.map((v) => ({
      id: v.id,
      name: v.name,
      language: v.language,
      gender: v.gender === 'female' || v.gender === 'male' || v.gender === 'neutral' ? v.gender : undefined,
      ...(v.premium ? { premium: true } : {}),
      ...(Array.isArray(v.replaces) && v.replaces.length ? { replaces: v.replaces.filter((r): r is string => typeof r === 'string') } : {}),
      ...(typeof v.standIn?.id === 'string' && typeof v.standIn.name === 'string' ? { standIn: { id: v.standIn.id, name: v.standIn.name } } : {}),
    }));
  }
  if (provider.kind === 'openai') return OPENAI_VOICES;
  if (provider.kind === 'elevenlabs') {
    const res = await getJson<{ voices?: { voice_id: string; name: string; labels?: { gender?: string; accent?: string } }[] }>(
      joinUrl(baseOf(provider), 'v1/voices'),
      { 'xi-api-key': provider.apiKey ?? '' },
      { timeoutMs: 15_000 },
    );
    return (res.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender === 'female' ? 'female' : v.labels?.gender === 'male' ? 'male' : undefined,
    }));
  }
  // OpenAI-compatible: Kokoro-FastAPI and friends list voices at /audio/voices; otherwise offer OpenAI's names.
  try {
    const headers: Record<string, string> = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
    const res = await getJson<{ voices?: (string | { id?: string; voice_id?: string; name?: string })[] }>(
      joinUrl(baseOf(provider), 'audio/voices'),
      headers,
      { timeoutMs: 10_000 },
    );
    const list = (res.voices ?? []).map((v) =>
      typeof v === 'string' ? kokoroVoice(v) : { id: v.id ?? v.voice_id ?? v.name ?? '', name: v.name ?? v.id ?? '' },
    );
    if (list.length) return list.filter((v) => v.id);
  } catch {
    // not every server has the endpoint
  }
  return OPENAI_VOICES;
}

const PREVIEW_LINES = [
  (h: Host) => `Hey, it's ${h.name}. You're listening to Host-Caster, and this is what I sound like on air.`,
  (h: Host) => `${h.name} here. Stick around, the next one is a good one.`,
  (h: Host) => `This is ${h.name}. Thanks for tuning in, let's keep the music going.`,
];

/** Speaks a short line in the host's voice and style, on its own (no music needed). */
export async function previewVoice(host: Host, text?: string): Promise<void> {
  const line = text ?? PREVIEW_LINES[Math.floor(Math.random() * PREVIEW_LINES.length)]!(host);
  const clip = await speak(host, line);
  await playStandalone(clip, host.language);
}

/** Stops whatever voice is speaking (radio stop, skip). */
export function stopVoice(): void {
  stopPreview();
}
