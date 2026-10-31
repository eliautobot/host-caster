// Low-level HTTP client for the Host-Caster server (owner: server agent).
// Web: same origin + httpOnly cookie. Native: settings.serverUrl + bearer token (stored in kv by core/api/auth).
import { nativeFetch } from '../native/http';
import type { ApiErrorBody, ApiSession, ServerConfig } from '../types';
import { createEmitter } from '../util/emitter';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** True for "no server / no network" failures (the caller should fall back to local data). */
export function isOffline(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.code === 'offline' || err.code === 'timeout');
}

interface ApiClientState {
  /** '' = same origin (web served by the server); a full URL on native or a remote server */
  baseUrl: string;
  session?: ApiSession;
  /** false = local-only mode; every caller must handle it */
  available: boolean;
  config?: ServerConfig;
}

interface ApiEvents {
  /** the server answered 401 for a request made with a session: it expired or was revoked */
  unauthorized: void;
  /** available / config changed */
  probe: ServerConfig | undefined;
}

const events = createEmitter<ApiEvents>();

export const api: ApiClientState & {
  configure(opts: { baseUrl?: string; session?: ApiSession | undefined }): void;
  probe(): Promise<ServerConfig | undefined>;
  url(path: string): string;
  readonly signedIn: boolean;
  on: typeof events.on;
} = {
  baseUrl: '',
  available: false,
  configure(opts) {
    if (opts.baseUrl !== undefined) this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    if ('session' in opts) this.session = opts.session;
  },
  /** GET /api/config; sets `available`. Never throws. */
  async probe() {
    try {
      this.config = await request<ServerConfig>('GET', '/api/config', undefined, { timeoutMs: 5000 });
      this.available = true;
    } catch {
      this.config = undefined;
      this.available = false;
    }
    events.emit('probe', this.config);
    return this.config;
  },
  url(path) {
    return `${this.baseUrl}${path}`;
  },
  get signedIn() {
    return Boolean(this.session);
  },
  on: events.on.bind(events),
};

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** return the raw Response (audio bytes, streams) */
  raw?: boolean;
  /** extra headers (Range ...) */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 30_000;

/** AbortSignal.any with a fallback for older WebViews. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const write = method !== 'GET' && method !== 'HEAD';
  // Writes always carry a JSON body: Android's native HTTP gives a POST/DELETE without one a form Content-Type,
  // which the server refuses (415), so sign out, delete account and removing keys silently failed on the phone.
  const payload = body === undefined && write ? {} : body;
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  // CSRF guard for cookie sessions; harmless for bearer sessions.
  if (write) headers['X-HostCaster'] = '1';
  const token = api.session?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT);
  const signal = opts.signal ? anySignal([opts.signal, timeout]) : timeout;
  // On native, Capacitor's patched fetch (CapacitorHttp) carries this without CORS.
  let res: Response;
  try {
    // Binary answers (TTS audio): on native, CapacitorHttp's patched fetch reads POST bodies as text and corrupts
    // them; nativeFetch asks for raw bytes (plain fetch on web).
    res = await (opts.raw ? nativeFetch : fetch)(api.url(path), {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      credentials: api.baseUrl ? 'omit' : 'include',
      signal,
    });
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name;
    if (name === 'AbortError' && opts.signal?.aborted) throw err;
    if (name === 'TimeoutError' || (name === 'AbortError' && timeout.aborted)) {
      throw new ApiError(0, 'timeout', 'The Host-Caster server took too long to answer');
    }
    throw new ApiError(0, 'offline', 'Could not reach the Host-Caster server');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as ApiErrorBody;
      code = err.error.code;
      message = err.error.message;
    } catch {
      // not JSON
    }
    if (res.status === 401 && api.session && code === 'not_signed_in') events.emit('unauthorized', undefined);
    throw new ApiError(res.status, code, message);
  }
  if (opts.raw) return res as T;
  if (res.status === 204 || res.status === 202) return undefined as T;
  return (await res.json()) as T;
}
