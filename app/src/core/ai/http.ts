// Small fetch helpers for brains and voices on the 'device' transport. On Android/iOS requests go through
// core/native nativeFetch (CapacitorHttp: no CORS, LAN hosts work, binary answers like TTS mp3 stay intact). In the
// desktop app they go through its local helper (desktopFetch), which gives the same.
import { desktopFetch, isDesktop, isNative, nativeFetch, PROXY_ERROR_HEADER } from '../native';

export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    message: string,
    readonly status = 0,
    readonly body = '',
  ) {
    super(message);
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The caller's signal and the timeout as one signal. */
export function mergeSignal(opts: FetchOpts): AbortSignal | undefined {
  const sigs = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(
    (s): s is AbortSignal => Boolean(s),
  );
  if (sigs.length <= 1) return sigs[0];
  return AbortSignal.any(sigs);
}

/** Pulls a readable message out of an OpenAI / Anthropic / ElevenLabs style error body. */
export function errorMessage(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: { message?: string } | string;
    };
    const e = j.error;
    const msg =
      (typeof e === 'string' ? e : e?.message) ??
      j.message ??
      (typeof j.detail === 'string' ? j.detail : j.detail?.message);
    if (msg) return `${msg} (HTTP ${status})`;
  } catch {
    // not JSON
  }
  if (status === 401 || status === 403) return `The provider refused the key (HTTP ${status})`;
  if (status === 404) return 'Not found: check the address and model (HTTP 404)';
  return body.trim().slice(0, 200) || `HTTP ${status}`;
}

async function send(url: string, init: RequestInit, opts: FetchOpts): Promise<Response> {
  let res: Response;
  try {
    const signal = mergeSignal(opts);
    res = isNative ? await nativeFetch(url, { ...init, signal }) : isDesktop ? await desktopFetch(url, { ...init, signal }) : await fetch(url, { ...init, signal });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError') throw new ProviderError('The provider took too long to answer');
    if (e.name === 'AbortError') throw e;
    // the phone app has no CORS (native HTTP): there it is the address, the server, or no network
    throw new ProviderError(
      isNative || isDesktop
        ? `Could not reach ${new URL(url).host}. Check the address, that it is running, and that this ${isDesktop ? 'computer' : 'phone'} is on its network.`
        : `Could not reach ${new URL(url).host}. Check the address, that it is running, and that it allows this app (CORS).`,
    );
  }
  if (res.headers.get(PROXY_ERROR_HEADER)) {
    // the desktop helper could not reach the provider: its message says why
    const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
    throw new ProviderError(body?.error?.message ?? `Could not reach ${new URL(url).host}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderError(errorMessage(res.status, body), res.status, body);
  }
  return res;
}

export async function postJson<T>(url: string, body: unknown, headers: Record<string, string>, opts: FetchOpts = {}): Promise<T> {
  const res = await send(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, opts);
  return (await res.json()) as T;
}

export async function postForBlob(url: string, body: unknown, headers: Record<string, string>, opts: FetchOpts = {}): Promise<Blob> {
  const res = await send(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, opts);
  const blob = await res.blob();
  if (!blob.size) throw new ProviderError('The voice came back empty');
  return blob;
}

export async function getJson<T>(url: string, headers: Record<string, string>, opts: FetchOpts = {}): Promise<T> {
  const res = await send(url, { method: 'GET', headers }, opts);
  return (await res.json()) as T;
}

/** Joins a base URL and a path without double slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
