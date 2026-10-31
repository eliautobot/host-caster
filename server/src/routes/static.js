// Serves app/dist with SPA fallback. Registered last; runs in the root context so its 404 handler is global.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { errorBody } from '../errors.js';

const LIVE_PREFIXES = ['/api/', '/auth/', '/mcp/'];
const NO_CACHE = new Set(['/sw.js', '/index.html', '/manifest.webmanifest']);

export async function staticRoutes(app) {
  const dist = app.config.appDist;
  const built = existsSync(join(dist, 'index.html'));

  if (built) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      cacheControl: false,
      // @fastify/static 10 passes the Fastify reply here
      setHeaders(reply, filePath) {
        const rel = filePath.slice(dist.length).replaceAll('\\', '/');
        if (rel.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else if (NO_CACHE.has(rel) || rel.endsWith('.html')) reply.header('Cache-Control', 'no-cache');
        else reply.header('Cache-Control', 'public, max-age=3600');
        if (rel === '/sw.js') reply.header('Service-Worker-Allowed', '/');
      },
    });
  } else {
    app.log.warn(`app not built (${dist}); run "npm run build" in app/`);
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const isLive = LIVE_PREFIXES.some((p) => path.startsWith(p)) || path === '/api' || path === '/mcp';
    const isPage = (req.method === 'GET' || req.method === 'HEAD') && !/\.[a-z0-9]+$/i.test(path);
    if (isLive || !isPage) {
      return reply.status(404).send(errorBody('not_found', `No route for ${req.method} ${path}`));
    }
    if (!built) {
      return reply.status(503).type('text/plain').send('Host-Caster app is not built. Run "npm run build" in app/.');
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}

// run in the parent context (like fastify-plugin) so setNotFoundHandler applies to every route
staticRoutes[Symbol.for('skip-override')] = true;
