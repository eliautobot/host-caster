// Typed server endpoints (owner: server agent). Every call needs a signed-in session unless noted;
// callers check `api.available` / `api.session` first and fall back to local data.
import { db } from '../db/db';
import { kvGet, kvSet } from '../db/kv';
import type { Brain, CalendarEvent, ChatMessage, EmailSummary, InboxItem, ServerTrack, VoiceProvider } from '../types';
import { api, ApiError, request } from './client';

export interface AiProxyRequest {
  brainId: string;
  system: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens: number;
  temperature?: number;
  /** ChatGPT plan brains: ask even while paused after a usage-limit answer (the Test button) */
  force?: boolean;
}

const needSession = (what: string) => {
  if (!api.session) throw new ApiError(401, 'not_signed_in', `Sign in to your Host-Caster server to use ${what}`);
};

/**
 * The server looks the brain/voice up in the synced doc. A record created a moment ago may not be synced yet (or is
 * still a draft in its sheet: Test, Load models), so the config goes along inline (never the key: that is uploaded
 * to the server's secrets first). `given` is the record as the caller has it; otherwise it is read from this device.
 */
async function inlineProvider(kind: 'brain' | 'voice', id: string, given?: Brain | VoiceProvider) {
  const rec = given ?? (kind === 'brain' ? await db.brains.get(id) : await db.voices.get(id));
  if (!rec) return undefined;
  const secretRef = rec.secretRef || `${kind}:${rec.id}`;
  if (rec.apiKey) {
    const sentKey = `sync:sent:${secretRef}`;
    const prev = (await kvGet<string>(sentKey))?.value;
    if (prev !== rec.apiKey.slice(-6) + rec.apiKey.length) {
      await request('PUT', `/api/secrets/${encodeURIComponent(secretRef)}`, { value: rec.apiKey });
      await kvSet(sentKey, rec.apiKey.slice(-6) + rec.apiKey.length);
    }
  }
  const { apiKey: _k, ...rest } = rec as typeof rec & { apiKey?: string };
  return { ...rest, secretRef };
}

export const aiProxy = {
  async chat(req: AiProxyRequest, opts: { signal?: AbortSignal; brain?: Brain } = {}) {
    needSession('this brain');
    const brain = await inlineProvider('brain', req.brainId, opts.brain);
    return request<{ text: string; model?: string }>('POST', '/api/ai/chat', { ...req, brain }, { timeoutMs: 100_000, signal: opts.signal });
  },
  async models(brainId: string, given?: Brain) {
    needSession('this brain');
    const brain = await inlineProvider('brain', brainId, given);
    return request<{ models: string[] }>('POST', '/api/ai/models', { brainId, brain });
  },
};

export const ttsProxy = {
  async speak(
    req: { voiceProviderId: string; voiceId: string; text: string; speed?: number; instructions?: string },
    opts: { signal?: AbortSignal; provider?: VoiceProvider } = {},
  ): Promise<Blob> {
    needSession('this voice');
    const voice = await inlineProvider('voice', req.voiceProviderId, opts.provider);
    const res = await request<Response>('POST', '/api/tts', { ...req, voice }, { raw: true, timeoutMs: 100_000, signal: opts.signal });
    return res.blob();
  },
  async voices(voiceProviderId: string, given?: VoiceProvider) {
    needSession('this voice');
    const voice = await inlineProvider('voice', voiceProviderId, given);
    return request<{
      voices: { id: string; name: string; gender?: string; language?: string; premium?: boolean; replaces?: unknown[]; standIn?: { id?: unknown; name?: unknown } }[];
    }>('POST', '/api/tts/voices', {
      voiceProviderId,
      voice,
    });
  },
};

export interface GoogleCalendarEvent extends CalendarEvent {
  /** all-day events: the local date (YYYY-MM-DD) */
  startDate?: string;
  endDate?: string;
  calendar?: string;
}

export interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
}

export const integrations = {
  /** Google Calendar, next `hours` hours, every visible calendar. */
  calendar: (hours = 36) => request<{ events: GoogleCalendarEvent[]; calendars: number }>('GET', `/api/google/calendar?hours=${hours}`),
  /** Gmail unread, important first. */
  email: (max = 10) => request<{ messages: EmailSummary[]; unread: number }>('GET', `/api/google/gmail?max=${max}`),
  /** ICS / RSS through the server (no CORS). */
  fetchText: (url: string) => request<{ text: string; contentType?: string; url?: string }>('POST', '/api/fetch-text', { url }),
  googleStatus: () => request<{ connected: boolean; email?: string; scopes: string[] }>('GET', '/api/google/status'),
  imap: {
    get: () => request<({ configured: false } | ({ configured: true } & ImapSettings))>('GET', '/api/imap'),
    test: (s: Partial<ImapSettings> & { password?: string }) => request<{ ok: true; unread: number }>('POST', '/api/imap/test', s),
    save: (s: ImapSettings & { password?: string }) => request<{ configured: true; unread: number } & ImapSettings>('PUT', '/api/imap', s),
    remove: () => request<void>('DELETE', '/api/imap'),
    summary: (max = 10) => request<{ messages: EmailSummary[]; unread: number }>('GET', `/api/imap/summary?max=${max}`),
  },
};

const ONE_SHOT: InboxItem['kind'][] = ['segment', 'song_request', 'life_event'];

export const inbox = {
  /**
   * Items AI apps sent since the last poll. One-shot items (segments, song requests, life events) are marked
   * delivered on the server once this device has them; notes stay until they expire so every device can use them.
   */
  async poll(): Promise<{ items: InboxItem[] }> {
    const res = await request<{ items: InboxItem[] }>('GET', '/api/inbox');
    const ids = res.items.filter((i) => ONE_SHOT.includes(i.kind)).map((i) => i.id);
    if (ids.length) await request('POST', '/api/inbox/consume', { ids }).catch(() => undefined);
    return res;
  },
  consume: (ids: string[]) => request<{ consumed: number }>('POST', '/api/inbox/consume', { ids }),
  remove: (id: string) => request<void>('DELETE', `/api/inbox/${encodeURIComponent(id)}`),
};

/** What is on air, for AI apps that ask (MCP now_playing). Best effort, never throws. */
export async function reportNowPlaying(np: {
  playing: boolean;
  station?: string;
  track?: { title: string; artist: string; album?: string };
  hosts?: string[];
  onAir?: boolean;
  speaking?: string;
}): Promise<void> {
  if (!api.available || !api.session) return;
  await request('POST', '/api/now-playing', np).catch(() => undefined);
}

export interface Connector {
  id: string;
  name: string;
  url?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export const connectors = {
  list: () => request<{ connectors: Connector[] }>('GET', '/api/connectors'),
  create: (name: string) => request<Connector>('POST', '/api/connectors', { name }),
  rename: (id: string, name: string) => request<Connector>('PATCH', `/api/connectors/${encodeURIComponent(id)}`, { name }),
  remove: (id: string) => request<void>('DELETE', `/api/connectors/${encodeURIComponent(id)}`),
};

export const secrets = {
  list: () => request<{ secrets: { ref: string; hint: string; updatedAt: number }[] }>('GET', '/api/secrets'),
  get: (ref: string) => request<{ ref: string; value: string }>('GET', `/api/secrets/${encodeURIComponent(ref)}`),
  put: (ref: string, value: string) => request<{ ref: string }>('PUT', `/api/secrets/${encodeURIComponent(ref)}`, { value }),
  remove: (ref: string) => request<void>('DELETE', `/api/secrets/${encodeURIComponent(ref)}`),
};

export interface YouTubeItem {
  videoId: string;
  title: string;
  channel: string;
  thumbnail?: string;
  durationMs?: number;
}

export const youtube = {
  /** Includes { id: 'LL', title: 'Liked videos', liked: true } first. */
  playlists: () =>
    request<{ playlists: { id: string; title: string; count: number; thumbnail?: string; liked?: boolean }[] }>(
      'GET',
      '/api/google/youtube/playlists',
    ),
  playlist: (id: string, limit = 200) =>
    request<{ items: YouTubeItem[] }>('GET', `/api/google/youtube/playlist/${encodeURIComponent(id)}?limit=${limit}`),
  search: (q: string, opts: { music?: boolean; max?: number } = {}) =>
    request<{ items: YouTubeItem[] }>(
      'GET',
      `/api/google/youtube/search?q=${encodeURIComponent(q)}${opts.music === false ? '&music=0' : ''}${opts.max ? `&max=${opts.max}` : ''}`,
    ),
};

let streamKey = '';

export const serverLibrary = {
  /** Also refreshes the stream key that stream/art URLs carry (audio elements cannot send headers). */
  async tracks() {
    const res = await request<{ tracks: ServerTrack[]; streamKey: string; scanning: boolean }>('GET', '/api/library/tracks');
    streamKey = res.streamKey;
    return res;
  },
  streamUrl: (id: string) => api.url(`/api/library/stream/${encodeURIComponent(id)}${streamKey ? `?k=${streamKey}` : ''}`),
  artUrl: (id: string) => api.url(`/api/library/art/${encodeURIComponent(id)}${streamKey ? `?k=${streamKey}` : ''}`),
  rescan: () => request<{ count: number; changed: number; removed: number }>('POST', '/api/library/rescan', undefined, { timeoutMs: 600_000 }),
};
