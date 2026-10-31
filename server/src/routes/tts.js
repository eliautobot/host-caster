// POST /api/tts (audio bytes) and /api/tts/voices for OpenAI, ElevenLabs and OpenAI-compatible speech servers
// (Kokoro, Chatterbox, Qwen3-TTS, Orpheus, openedai-speech ...). Keys come from the user's secrets.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { jsonOf, userRequest } from '../net/http.js';
import { joinUrl, resolveVoice, upstreamError, upstreamMessage } from './providers.js';

const DEFAULT_MODEL = { openai: 'gpt-4o-mini-tts', elevenlabs: 'eleven_flash_v2_5', 'openai-compatible': 'tts-1' };
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const ELEVEN_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function baseOf(app, voice) {
  if (voice.baseUrl) return voice.baseUrl;
  if (voice.kind === 'openai') return 'https://api.openai.com/v1';
  if (voice.kind === 'elevenlabs') return app.config.elevenlabsBase;
  throw new HttpError(400, 'invalid_voice', 'The voice server has no address');
}

async function speakOpenAi(ctx, base, voice, req) {
  const headers = { 'content-type': 'application/json', accept: 'audio/mpeg' };
  if (voice.apiKey) headers.authorization = `Bearer ${voice.apiKey}`;
  const body = {
    model: voice.model || DEFAULT_MODEL[voice.kind],
    voice: req.voiceId || (voice.kind === 'openai' ? 'coral' : 'alloy'),
    input: req.text,
    response_format: 'mp3',
  };
  if (req.speed && req.speed !== 1) body.speed = clamp(req.speed, 0.25, 4);
  if (req.instructions && voice.kind === 'openai') body.instructions = req.instructions.slice(0, 1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await userRequest(ctx, joinUrl(base, 'audio/speech'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 90000,
      maxBytes: 20 * 1024 * 1024,
    });
    if (res.status === 200) return res;
    const msg = res.status === 400 || res.status === 422 ? upstreamMessage(res, '').toLowerCase() : '';
    if (msg.includes('instructions') && body.instructions) delete body.instructions;
    else if (msg.includes('speed') && body.speed) delete body.speed;
    else throw upstreamError(res, voice.name || 'The voice server');
  }
  throw new HttpError(502, 'upstream_error', 'The voice server kept rejecting the request');
}

async function speakEleven(ctx, base, voice, req) {
  if (!voice.apiKey) throw new HttpError(400, 'missing_key', 'Add your ElevenLabs API key first');
  const id = encodeURIComponent(req.voiceId || ELEVEN_DEFAULT_VOICE);
  const res = await userRequest(ctx, joinUrl(base, `v1/text-to-speech/${id}?output_format=mp3_44100_128`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': voice.apiKey },
    body: JSON.stringify({
      text: req.text,
      model_id: voice.model || DEFAULT_MODEL.elevenlabs,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: clamp(req.speed || 1, 0.7, 1.2) },
    }),
    timeoutMs: 90000,
    maxBytes: 20 * 1024 * 1024,
  });
  if (res.status !== 200) throw upstreamError(res, voice.name || 'ElevenLabs');
  return res;
}

async function listVoices(ctx, base, voice) {
  if (voice.kind === 'openai') return OPENAI_VOICES.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
  if (voice.kind === 'elevenlabs') {
    const res = await userRequest(ctx, joinUrl(base, 'v1/voices'), { headers: { 'xi-api-key': voice.apiKey } });
    if (res.status !== 200) throw upstreamError(res, voice.name || 'ElevenLabs');
    return (jsonOf(res)?.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender,
      language: v.labels?.language ?? v.fine_tuning?.language,
    }));
  }
  // Kokoro-FastAPI and friends: GET /v1/audio/voices -> { voices: [...] }; otherwise the OpenAI names.
  const headers = voice.apiKey ? { authorization: `Bearer ${voice.apiKey}` } : {};
  try {
    const res = await userRequest(ctx, joinUrl(base, 'audio/voices'), { headers, timeoutMs: 10000 });
    const list = res.status === 200 ? (jsonOf(res)?.voices ?? jsonOf(res)?.data) : undefined;
    if (Array.isArray(list) && list.length) {
      return list
        .map((v) => (typeof v === 'string' ? { id: v, name: v } : { id: v.id ?? v.voice_id ?? v.name, name: v.name ?? v.id }))
        .filter((v) => v.id);
    }
  } catch (err) {
    if (err.code === 'blocked_address') throw err;
  }
  return OPENAI_VOICES.map((id) => ({ id, name: id }));
}

export async function ttsRoutes(app) {
  const ctx = app.egressCtx;

  app.post('/api/tts', async (req, reply) => {
    const user = requireUser(req);
    const voice = resolveVoice(app, user.id, req.body);
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'invalid_request', 'text is empty');
    if (text.length > 4000) throw new HttpError(400, 'invalid_request', 'text is too long (4000 characters max)');
    const speakReq = {
      text,
      voiceId: String(req.body?.voiceId ?? ''),
      speed: Number(req.body?.speed ?? 1) || 1,
      instructions: typeof req.body?.instructions === 'string' ? req.body.instructions : undefined,
    };
    if (voice.kind === 'hostcaster') {
      // online edition: Host-Caster Voices, included with the plan
      if (!app.included) throw new HttpError(400, 'unsupported_voice', 'Host-Caster Voices are only on the Host-Caster online service');
      const out = await app.included.speak(user.id, speakReq);
      // the voice that spoke (a premium voice off the Premium plan speaks as its standard stand-in)
      reply.header('x-hostcaster-voice', out.voiceId);
      if (out.standIn) reply.header('x-hostcaster-stand-in', out.standIn);
      return reply.type(out.contentType).header('cache-control', 'no-store').send(out.audio);
    }
    if (!['openai', 'elevenlabs', 'openai-compatible'].includes(voice.kind)) {
      throw new HttpError(400, 'unsupported_voice', 'This voice does not run on the server');
    }
    const base = baseOf(app, voice);
    const res = voice.kind === 'elevenlabs' ? await speakEleven(ctx, base, voice, speakReq) : await speakOpenAi(ctx, base, voice, speakReq);
    const type = String(res.headers['content-type'] ?? 'audio/mpeg');
    return reply.type(type.startsWith('audio/') ? type : 'audio/mpeg').header('cache-control', 'no-store').send(res.body);
  });

  app.post('/api/tts/voices', async (req) => {
    const user = requireUser(req);
    const voice = resolveVoice(app, user.id, req.body);
    if (voice.kind === 'device') return { voices: [] };
    if (voice.kind === 'hostcaster') return { voices: app.included ? app.included.voices() : [] };
    return { voices: await listVoices(ctx, baseOf(app, voice), voice) };
  });
}
