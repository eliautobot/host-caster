// Low-level HTTP client for the Host-Caster server (owner: server agent).
// Web: same origin + httpOnly cookie. Native: settings.serverUrl + bearer token (stored in kv by core/api/auth).
import { nativeFetch } from '../native/http';
import type { ApiErrorBody, ApiSession, ServerConfig } from '../types';
import { untilAborted } from '../util/abort';
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

// A server that did not answer once (the app opened, or woke up, before the network was back) is looked for again:
// after 5 s, 15 s, 30 s, then every minute, and at once when the device is back online or the app is shown again.
// Without this the whole session stayed "not reachable" (no Host-Caster AI or voices) until the app was restarted.
const REPROBE_MS = [5_000, 15_000, 30_000, 60_000];
let reprobes = 0;
let reprobeTimer: ReturnType<typeof setTimeout> | undefined;
let watching = false;

function scheduleReprobe() {
  if (reprobeTimer) return;
  const wait = REPROBE_MS[Math.min(reprobes++, REPROBE_MS.length - 1)]!;
  reprobeTimer = setTimeout(() => {
    reprobeTimer = undefined;
    void api.probe();
  }, wait);
}

function watchReachability() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const again = () => {
    if (api.available) return;
    clearTimeout(reprobeTimer);
    reprobeTimer = undefined;
    void api.probe();
  };
  window.addEventListener('online', again);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && again());
}

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
  /** GET /api/config; sets `available`. Never throws. Not reachable: it looks again by itself (see reprobe). */
  async probe() {
    watchReachability();
    try {
      this.config = await request<ServerConfig>('GET', '/api/config', undefined, { timeoutMs: 5000 });
      this.available = true;
      reprobes = 0;
      clearTimeout(reprobeTimer);
      reprobeTimer = undefined;
    } catch {
      this.config = undefined;
      this.available = false;
      scheduleReprobe();
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? anySignal([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    // On native, writes go straight to CapacitorHttp (nativeFetch): the app's patched fetch hands them to the native
    // HTTP stack without the AbortSignal and without timeouts, so a POST on a connection that died while the phone
    // slept never ended (the hosts' next break waited for it forever). nativeFetch sets the native connect/read
    // timeouts and keeps binary answers (TTS audio) intact; GETs and the web use plain fetch. The race makes every
    // request end at its own limit whatever the transport does.
    res = await untilAborted(
      nativeFetch(api.url(path), {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        credentials: api.baseUrl ? 'omit' : 'include',
        signal,
        timeoutMs,
      }),
      signal,
    );
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name;
    // the caller stopped it (Next, a newer request): its own reason, unless that was its own time limit
    if (opts.signal?.aborted && name !== 'TimeoutError') throw err;
    if (name === 'TimeoutError' || timeout.aborted) {
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
