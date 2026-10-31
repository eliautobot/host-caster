// Outbound HTTP. userRequest(): user-supplied URLs, guarded + pinned to the validated address.
// providerFetch(): operator-declared provider APIs (Google, X, ElevenLabs) with a timeout and JSON errors.
import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { HttpError } from '../errors.js';
import { checkUrl } from './egress.js';

const UA = 'Host-Caster/1 (personal radio server)';

function decoder(encoding) {
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return undefined;
  }
}

/** One request to a validated address. Host header and TLS SNI keep the URL's host name. */
function dialPinned(target, { method, headers, body, timeoutMs, maxBytes }) {
  const { url, address, family } = target;
  if (!address) throw new HttpError(500, 'internal', 'refusing to dial without a validated address');
  const lib = url.protocol === 'https:' ? https : http;
  const pinnedLookup = (_host, opts, cb) => {
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: { 'user-agent': UA, 'accept-encoding': 'gzip, deflate, br', ...headers },
        lookup: pinnedLookup,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const dec = decoder(res.headers['content-encoding']);
        const stream = dec ? res.pipe(dec) : res;
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            stream.destroy();
            reject(new HttpError(502, 'too_large', 'The response was too large'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), url: url.href }),
        );
        stream.on('error', (err) => reject(new HttpError(502, 'upstream_error', err.message)));
      },
    );
    req.on('timeout', () => req.destroy(new HttpError(504, 'upstream_timeout', 'The server took too long to answer')));
    req.on('error', (err) =>
      reject(err instanceof HttpError ? err : new HttpError(502, 'upstream_unreachable', `Could not reach ${url.host}: ${err.code ?? err.message}`)),
    );
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Request to a URL a user supplied. Every hop (redirects) is re-validated.
 * @param {{ egress: ReturnType<import('./egress.js').makePolicy>, resolver?: (h: string) => Promise<string[]> }} ctx
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string | Buffer, timeoutMs?: number,
 *   maxBytes?: number, maxRedirects?: number }} [opts]
 */
export async function userRequest(ctx, url, opts = {}) {
  const method = opts.method ?? 'GET';
  const maxRedirects = opts.maxRedirects ?? (method === 'GET' ? 5 : 0);
  let current = url;
  for (let hop = 0; ; hop++) {
    const target = await checkUrl(current, ctx.egress, ctx.resolver);
    const res = await dialPinned(target, {
      method,
      headers: opts.headers ?? {},
      body: opts.body,
      timeoutMs: opts.timeoutMs ?? 15000,
      maxBytes: opts.maxBytes ?? 4 * 1024 * 1024,
    });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location && hop < maxRedirects) {
      current = new URL(location, target.url).href;
      continue;
    }
    return res;
  }
}

export function jsonOf(res) {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** fetch() to an operator-declared provider with a timeout. Network failures become 502s. */
export async function providerFetch(url, init = {}, timeoutMs = 15000) {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, 'upstream_timeout', 'The provider took too long to answer');
    throw new HttpError(502, 'upstream_unreachable', `Could not reach ${new URL(url).host}`);
  }
}
