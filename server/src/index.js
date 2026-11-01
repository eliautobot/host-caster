// Host-Caster server entry. createServer(config) builds the app (used by tests); running this file starts it.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { accountRoutes } from './auth/account.js';
import { oauthRoutes } from './auth/oauth.js';
import { chatgptRoutes } from './chatgpt/routes.js';
import { createChatGPT } from './chatgpt/service.js';
import { csrfHook, routePath, sessionHook } from './auth/session.js';
import { loadConfig, loadEnvFile } from './config.js';
import { createSealer, deriveKey } from './crypto.js';
import { openDb } from './db.js';
import { errorHandler } from './errors.js';
import { googleRoutes } from './integrations/google.js';
import { defaultImapFactory, imapRoutes } from './integrations/imap.js';
import { notionRoutes } from './integrations/notion/routes.js';
import { libraryRoutes } from './library/routes.js';
import { mcpRoutes } from './mcp/server.js';
import { makePolicy } from './net/egress.js';
import { aiRoutes } from './routes/ai.js';
import { configRoutes } from './routes/config.js';
import { connectorRoutes } from './routes/connectors.js';
import { fetchRoutes } from './routes/fetch.js';
import { healthRoutes } from './routes/health.js';
import { inboxRoutes } from './routes/inbox.js';
import { reportRoutes } from './routes/reports.js';
import { secretsRoutes } from './routes/secrets.js';
import { staticRoutes } from './routes/static.js';
import { syncRoutes } from './routes/sync.js';
import { ttsRoutes } from './routes/tts.js';

/**
 * Headers for every edition: no MIME sniffing, no framing (clickjacking of delete/connect buttons), no full URLs in
 * the Referer. The online edition adds a full CSP on top (online/headers.js); self-hosted keeps connections open to
 * the user's own AI and voice servers, so its page CSP only covers framing, plugins and <base>.
 */
function baseHeadersHook() {
  return async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('content-security-policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    }
    return payload;
  };
}

const CORS_HEADERS = 'authorization, content-type, x-hostcaster, range, accept, mcp-protocol-version, mcp-session-id';
const CORS_EXPOSE = 'content-range, content-length, accept-ranges, content-type';

/**
 * Cross-origin calls come from the native apps (capacitor://localhost, https://localhost) with a bearer token.
 * Origins are reflected without Allow-Credentials, so a foreign page can never ride the cookie session.
 */
function corsHook() {
  return async (req, reply) => {
    const origin = req.headers.origin;
    const path = routePath(req);
    if (!origin || !(path.startsWith('/api/') || path.startsWith('/mcp/'))) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-expose-headers', CORS_EXPOSE);
    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
        .header('access-control-allow-headers', CORS_HEADERS)
        .header('access-control-max-age', '600')
        .status(204)
        .send();
      return reply;
    }
  };
}

/**
 * A request URL as it goes into the log: the AI app connector secret (/mcp/<token>), the one-time OAuth values
 * (code, state, link ticket) and the library stream key (k) are replaced with ***.
 * @param {string} url
 */
export function redactUrl(url) {
  return url.replace(/^\/mcp\/[^/?#]+/, '/mcp/***').replace(/([?&](?:code|state|link|session_id|token|k)=)[^&#]*/g, '$1***');
}

/**
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ logger?: boolean | object, dbFile?: string, resolver?: (host: string) => Promise<string[]>,
 *   imapFactory?: (opts: object) => object }} [opts]
 */
export async function createServer(config = loadConfig(), opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? {
      level: config.logLevel,
      serializers: {
        req: (req) => ({ method: req.method, url: redactUrl(req.url), hostname: req.hostname, remoteAddress: req.ip }),
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 8 * 1024 * 1024,
  });

  const db = openDb(opts.dbFile ?? config.dbFile);
  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('sealer', createSealer(config.secretKey));
  app.decorate('egressCtx', {
    egress: makePolicy({ allowPrivate: config.allowPrivateFetch, allow: config.fetchAllow }),
    resolver: opts.resolver,
  });
  app.decorate('imapFactory', opts.imapFactory ?? defaultImapFactory);
  app.decorate('chatgpt', createChatGPT(app));
  app.addHook('onClose', async () => {
    app.chatgpt.close();
    db.close();
  });

  app.setErrorHandler(errorHandler);
  await app.register(cookie, { secret: deriveKey(config.secretKey, 'cookie').toString('base64url') });
  app.addHook('onRequest', corsHook());
  app.addHook('onRequest', sessionHook(app));
  app.addHook('onRequest', csrfHook());
  app.addHook('onSend', baseHeadersHook());
  app.addHook('onSend', async (req, reply, payload) => {
    if (routePath(req).startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
  // HOSTCASTER_EDITION=online only: sign-in required, plans, included AI (self-hosted never loads it; the public
  // source has no src/online at all)
  if (config.online.enabled) await (await import('./online/index.js')).registerOnline(app);

  await app.register(healthRoutes);
  await app.register(configRoutes);
  await app.register(oauthRoutes);
  await app.register(accountRoutes);
  await app.register(syncRoutes);
  await app.register(secretsRoutes);
  await app.register(aiRoutes);
  await app.register(chatgptRoutes);
  await app.register(ttsRoutes);
  await app.register(fetchRoutes);
  await app.register(googleRoutes);
  await app.register(imapRoutes);
  await app.register(notionRoutes);
  await app.register(libraryRoutes);
  await app.register(inboxRoutes);
  await app.register(reportRoutes);
  await app.register(connectorRoutes);
  await app.register(mcpRoutes);

  // Static app + SPA fallback (keep last).
  await app.register(staticRoutes);

  return app;
}

async function main() {
  loadEnvFile();
  const config = loadConfig();
  const app = await createServer(config);
  const shutdown = async (signal) => {
    app.log.info(`${signal}: shutting down`);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ port: config.port, host: config.host });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
