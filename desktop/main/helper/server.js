// The desktop app's LOCAL HELPER: the self-hosted server pieces the app needs on this PC, on 127.0.0.1 only, behind a
// secret made at every launch. It runs "Use your ChatGPT plan" (the server's own chatgpt service with a store on this
// PC: the ChatGPT tokens never leave it) and carries the app's 'device' brain and voice calls (proxy.js). The account,
// sync, plans and Host-Caster AI stay with the online server.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { readMessages as wireMessages, readTools } from '../../../server/src/ai/wire.js';
import { createSealer } from '../../../server/src/crypto.js';
import { MANAGE_USAGE_URL } from '../../../server/src/chatgpt/errors.js';
import { createChatGPT } from '../../../server/src/chatgpt/service.js';
import { createMemoryFlows } from './flows.js';
import { proxyRequest } from './proxy.js';
import { createFileStore } from './store.js';

/** the one person using this app: every ChatGPT record is theirs */
export const LOCAL_USER = 'local';
const BODY_LIMIT = 8 * 1024 * 1024;
const ALLOW_HEADERS =
  'content-type, authorization, accept, range, x-hc-helper, x-api-key, xi-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, openai-organization, openai-project, http-referer, x-title';

class HelperError extends Error {
  constructor(status, code, message) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new HelperError(413, 'too_large', 'That request is too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HelperError(400, 'invalid_request', 'The request body is not JSON');
  }
}

/** Plain turns and tool turns (the hosts' lookups), the same shapes the server takes (server/src/ai/wire.js). */
function readMessages(body) {
  const list = (Array.isArray(body?.messages) ? body.messages : []).slice(-40).map((m) => (m && typeof m.content === 'string' ? { ...m, content: m.content.slice(0, 40_000) } : m));
  return wireMessages({ messages: list });
}

/** The address the ChatGPT tab ended on, pasted when the callback could not reach this PC's listener. */
function pastedUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new HelperError(400, 'chatgpt_flow', 'Paste the whole address from the ChatGPT tab (it starts with http://127.0.0.1).');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new HelperError(400, 'chatgpt_flow', 'That is not the ChatGPT sign-in address. It starts with http://127.0.0.1.');
  }
  return url;
}

/**
 * @param {{
 *   dataDir: string,
 *   keychain: { seal: (text: string) => string, open: (sealed: string) => string },
 *   chatgptEnabled: () => boolean,
 *   appOrigin: string,
 *   version?: string,
 *   keychainInfo?: () => object,
 *   log?: { info: Function, warn: Function, error: Function },
 *   chatgpt?: { issuer?: string, apiBase?: string, resource?: string, callbackPort?: number },
 *   backUrl?: string,
 * }} opts
 */
export async function startHelper(opts) {
  const token = randomBytes(32).toString('base64url');
  const log = opts.log ?? { info() {}, warn() {}, error() {} };
  const store = createFileStore(join(opts.dataDir, 'chatgpt.json'), opts.keychain);
  const config = {
    dataDir: opts.dataDir,
    // the "Back to Host-Caster" link on the ChatGPT callback page brings this app to the front
    publicUrl: opts.backUrl ?? 'hostcaster://chatgpt',
    chatgpt: {
      issuer: (opts.chatgpt?.issuer ?? 'https://auth.openai.com').replace(/\/+$/, ''),
      apiBase: (opts.chatgpt?.apiBase ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      resource: opts.chatgpt?.resource ?? 'https://api.openai.com/v1',
      callbackPort: opts.chatgpt?.callbackPort ?? 1455,
      callbackBind: '127.0.0.1',
      // read at every call: the Desktop setting turns it on and off while the app runs
      get enabled() {
        return opts.chatgptEnabled();
      },
    },
  };
  // flow records stay in memory, sealed with a key that lives as long as this launch
  const svc = createChatGPT({ config, sealer: createSealer(randomBytes(32)), log }, { store, flows: createMemoryFlows() });

  let port = 0;
  const cors = (origin) =>
    origin === opts.appOrigin ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'content-type, content-range, accept-ranges, x-hc-proxy-error' } : {};

  const routes = {
    'GET /health': async () => ({ ok: true, version: opts.version ?? '', chatgptPlan: opts.chatgptEnabled(), keychain: opts.keychainInfo?.() }),
    'GET /api/chatgpt/status': async () => ({ ...svc.status(LOCAL_USER), manageUsageUrl: MANAGE_USAGE_URL }),
    'POST /api/chatgpt/start': async (body) => svc.start(LOCAL_USER, { fresh: body.fresh === true, reconsent: body.reconsent === true }),
    'POST /api/chatgpt/finish': async (body) => {
      await svc.complete(pastedUrl(body.url), LOCAL_USER);
      return { ...svc.status(LOCAL_USER), manageUsageUrl: MANAGE_USAGE_URL };
    },
    'POST /api/chatgpt/cancel': async () => {
      svc.clearAttempt(LOCAL_USER);
      return { ok: true };
    },
    'POST /api/chatgpt/welcome': async () => {
      svc.welcomed(LOCAL_USER);
      return { ok: true };
    },
    'GET /api/chatgpt/models': async () => ({ models: await svc.models(LOCAL_USER) }),
    'POST /api/chatgpt/disconnect': async () => svc.disconnect(LOCAL_USER),
    // the person signed out of Host-Caster: their ChatGPT sign-in on this PC ends (best effort) and is forgotten, so
    // the next account signing in here never runs on it
    'POST /api/account/signed-out': async () => {
      await svc.forgetUser(LOCAL_USER).catch(() => undefined);
      store.clear();
      return { ok: true };
    },
    'POST /api/ai/chat': async (body) => {
      const brain = body.brain ?? {};
      if (brain.kind !== undefined && brain.kind !== 'chatgpt') throw new HelperError(400, 'unsupported_brain', 'This helper runs ChatGPT plan brains only');
      if (!brain.model) throw new HelperError(400, 'invalid_brain', 'Pick a model first');
      return svc.chat(LOCAL_USER, {
        model: String(brain.model),
        system: String(body.system ?? ''),
        messages: readMessages(body),
        tools: readTools(body),
        json: body.json === true,
        force: body.force === true,
      });
    },
    'POST /api/ai/models': async () => ({ models: (await svc.models(LOCAL_USER)).map((m) => m.slug) }),
  };

  async function handle(req, res) {
    const origin = req.headers.origin;
    const send = (status, payload, extra = {}) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(origin), ...extra });
      res.end(JSON.stringify(payload));
    };
    // only this app's page (or no page at all) and only under the exact 127.0.0.1 address (no DNS rebinding)
    if ((origin && origin !== opts.appOrigin) || req.headers.host !== `127.0.0.1:${port}`) {
      return send(403, { error: { code: 'forbidden', message: 'Not allowed' } });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors(origin),
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ? String(req.headers['access-control-request-headers']).slice(0, 2000) : ALLOW_HEADERS,
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (!same(req.headers['x-hc-helper'], token)) return send(401, { error: { code: 'helper_auth', message: 'Not allowed' } });

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === '/proxy') {
        const target = url.searchParams.get('url') ?? '';
        return await proxyRequest(req, res, target, { cors: cors(origin), readBody });
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: { code: 'not_found', message: 'Not found' } });
      const body = req.method === 'POST' ? await readJson(req) : {};
      return send(200, await route(body));
    } catch (err) {
      const status = err?.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
      if (status >= 500) log.warn(`helper ${req.method} ${url.pathname} failed: ${err?.code ?? err?.name ?? 'error'}`);
      const known = Boolean(err?.code && err.statusCode);
      return send(status, { error: { code: known ? String(err.code).toLowerCase() : 'internal', message: known ? err.message : 'Something went wrong' } });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.requestTimeout = 0; // the proxy streams long answers; each route has its own limits
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  log.info(`helper on 127.0.0.1:${port}`);

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    port,
    chatgpt: svc,
    store,
    async close() {
      svc.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
