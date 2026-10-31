// fetch that also works for binary answers on Android/iOS.
//
// With CapacitorHttp on, the app's fetch() to other hosts runs natively (no CORS, LAN and localhost work). GET and
// HEAD stream through a local proxy, so bytes arrive intact. Other methods go through the bridge, which reads the
// body as text: a POST that returns audio (TTS) comes back corrupted. nativeFetch() asks the native layer for raw
// bytes (base64 over the bridge) and builds a normal Response. On web it is plain fetch().
import { CapacitorHttp, type HttpResponse } from '@capacitor/core';
import { isNative } from './platform';

/** Response from a native HttpResponse fetched with responseType 'arraybuffer'. Exported for tests. */
export function responseFromNative(res: Pick<HttpResponse, 'data' | 'status' | 'headers' | 'url'>): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (v != null) headers.set(k, String(v));
  }
  const type = headers.get('content-type') ?? '';
  let body: BodyInit | null;
  if (res.data == null || [101, 204, 205, 304].includes(res.status)) body = null;
  else if (typeof res.data !== 'string') body = JSON.stringify(res.data); // native parsed JSON
  else if (res.status >= 400 || /json/i.test(type)) body = res.data; // error bodies arrive as text
  else {
    try {
      body = base64ToBytes(res.data);
    } catch {
      body = res.data; // not base64 after all (some servers' text answers)
    }
  }
  const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
  const out = new Response(body, { status, headers });
  if (res.url) Object.defineProperty(out, 'url', { value: res.url });
  return out;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.replace(/[\s]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isRemoteHttp(url: string): boolean {
  if (!/^https?:/i.test(url)) return false;
  if (typeof location === 'undefined') return true;
  try {
    return new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * fetch() replacement for calls whose answer may be binary (TTS audio, images from a POST, files).
 * Same signature and Response as fetch. String bodies only on the native path; other bodies use fetch().
 */
export async function nativeFetch(input: string | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const url = String(input);
  const method = (init.method ?? 'GET').toUpperCase();
  const body = init.body;
  const simpleBody = body == null || typeof body === 'string';
  if (!isNative || !isRemoteHttp(url) || method === 'GET' || method === 'HEAD' || !simpleBody) {
    const { timeoutMs, ...rest } = init;
    const signal = timeoutMs ? anySignal(rest.signal, AbortSignal.timeout(timeoutMs)) : rest.signal;
    return fetch(input, { ...rest, signal });
  }

  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortError(signal);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  // CapacitorHttp drops the body when there is no Content-Type
  if (body != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'text/plain;charset=UTF-8';
  }
  const timeout = init.timeoutMs;
  const request = CapacitorHttp.request({
    url,
    method,
    headers,
    data: body ?? undefined,
    responseType: 'arraybuffer',
    ...(timeout ? { connectTimeout: timeout, readTimeout: timeout } : {}),
  });
  const res = await (signal
    ? Promise.race([
        request,
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError(signal)), { once: true });
        }),
      ])
    : request);
  return responseFromNative(res);
}

/** POST/GET and get the answer as a Blob (throws on HTTP errors with the body text). */
export async function nativeFetchBinary(input: string | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<Blob> {
  const res = await nativeFetch(input, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.blob();
}

function anySignal(a: AbortSignal | null | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}
