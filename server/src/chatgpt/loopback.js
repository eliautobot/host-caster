// The 127.0.0.1 callback listener Sign in with ChatGPT requires (redirect_uri http://127.0.0.1:<port>/auth/callback).
// It only receives the callback when the browser runs on this machine; any other device pastes the address instead.
// Up while a sign-in is pending, closed a while after the last one.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const CALLBACK_PATH = '/auth/callback';
const IDLE_MS = 11 * 60 * 1000;

const SCRIPT = 'history.replaceState(null, "", "/auth/complete");';
const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64');

const page = (title, text, backUrl) => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:32rem;margin:16vh auto;padding:24px;color:#f4f4f5;background:#0a0a0b}
h1{font-size:24px;margin:0 0 8px}a{color:#ff5a36}</style>
<h1>${title}</h1><p>${text}</p>${backUrl ? `<p><a href="${backUrl}">Back to Host-Caster</a></p>` : ''}<script>${SCRIPT}</script></html>`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * @param {{ port: number, bind: string, backUrl?: string, log?: { warn: Function },
 *   onCallback: (url: URL) => Promise<{ ok: boolean, message: string }> }} opts
 */
export function createLoopback(opts) {
  let server;
  let port;
  let idleTimer;

  const handler = async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
    );
    let url;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('Not found');
      return;
    }
    const result = await opts.onCallback(url).catch((err) => ({ ok: false, message: err?.message ?? 'Sign-in failed' }));
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    const back = opts.backUrl ? escapeHtml(opts.backUrl) : undefined;
    res.end(
      result.ok
        ? page('Return to Host-Caster', 'Your ChatGPT account is connected. You can close this tab.', back)
        : page('ChatGPT sign-in did not finish', escapeHtml(result.message), back),
    );
  };

  async function listenOn(p) {
    const s = createServer(handler);
    s.requestTimeout = 15000;
    s.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen({ port: p, host: opts.bind }, () => {
        s.removeListener('error', reject);
        resolve();
      });
    });
    s.on('error', (err) => opts.log?.warn({ err: err.message }, 'chatgpt callback listener error'));
    return s;
  }

  /** Makes sure the listener is up; returns the port for redirect_uri (the configured one when binding failed). */
  async function ensure() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_MS);
    idleTimer.unref?.();
    if (server) return { port, listening: true };
    for (const p of opts.port ? [opts.port, 0] : [0]) {
      try {
        server = await listenOn(p);
        port = server.address().port;
        return { port, listening: true };
      } catch {
        server = undefined;
      }
    }
    opts.log?.warn('chatgpt callback listener could not bind; sign-in works by pasting the address');
    return { port: opts.port || 1455, listening: false };
  }

  function close() {
    clearTimeout(idleTimer);
    if (!server) return;
    server.close();
    server.closeAllConnections?.();
    server = undefined;
  }

  return { ensure, close, get port() { return port; } };
}
