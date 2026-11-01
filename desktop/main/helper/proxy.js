// The app's 'device' brains and voices (Ollama, LM Studio, Kokoro on this PC or the home network, or any provider
// with the person's own key) go through here: the request leaves from this PC, like the phone apps' native HTTP, so
// there is no CORS and no mixed-content block for plain http on the LAN. Only the app (holding the per-launch secret)
// can use it, and only for http(s) addresses.
import { Readable } from 'node:stream';

/** Request headers that are about the hop to the helper, not the provider. */
const DROP_REQUEST = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'upgrade',
  'proxy-authorization',
  'x-hc-helper',
]);
/** Answer headers passed back (bodies arrive decoded, so no content-encoding or length). */
const KEEP_RESPONSE = ['content-type', 'content-range', 'accept-ranges', 'cache-control', 'retry-after', 'x-request-id', 'request-id'];

export const PROXY_ERROR_HEADER = 'x-hc-proxy-error';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} target
 * @param {{ cors: Record<string, string>, readBody: (req: object) => Promise<Buffer>, timeoutMs?: number }} opts
 */
export async function proxyRequest(req, res, target, opts) {
  const fail = (status, code, message) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { ...opts.cors, 'content-type': 'application/json', [PROXY_ERROR_HEADER]: '1' });
    res.end(JSON.stringify({ error: { code, message } }));
  };
  let url;
  try {
    url = new URL(target);
  } catch {
    return fail(400, 'invalid_url', 'That is not a web address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail(400, 'invalid_url', 'Only http and https addresses work here');
  if (url.username || url.password) return fail(400, 'invalid_url', 'Put the key in the key field, not in the address');

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (DROP_REQUEST.has(key) || key.startsWith('sec-') || key.startsWith('access-control-') || v === undefined) continue;
    headers[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await opts.readBody(req);

  const ctl = new AbortController();
  // the app gave up (its own timeout or a skipped break): stop the provider call too
  res.on('close', () => ctl.abort());
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), opts.timeoutMs ?? 180_000);
  let upstream;
  try {
    upstream = await fetch(url, { method, headers, body, redirect: 'follow', signal: ctl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (res.destroyed) return undefined;
    const why = err?.cause?.code ?? err?.name ?? 'error';
    return fail(502, 'unreachable', `Could not reach ${url.host} (${why}). Check the address, that it is running, and that this computer is on its network.`);
  }
  const out = { ...opts.cors };
  for (const k of KEEP_RESPONSE) {
    const v = upstream.headers.get(k);
    if (v) out[k] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body || method === 'HEAD') {
    clearTimeout(timer);
    return res.end();
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  stream.on('end', () => clearTimeout(timer));
  stream.pipe(res);
  return undefined;
}
