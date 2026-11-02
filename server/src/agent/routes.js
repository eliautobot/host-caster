// The hosts' lookups (agent tools) on the server:
//   GET    /api/agent/status          which lookups this account can make here, today's use and the caps
//   POST   /api/agent/tool            { name, args, host?, purpose? } -> { result, what }   (runs one, logs it)
//   POST   /api/agent/lookups         { items: [{ tool, what, host?, purpose?, ok?, ms?, at? }] }  lookups the app ran
//                                      on the device (weather, a calendar feed), so the log shows them on every device
//   GET    /api/agent/lookups?limit=  the log, newest first (30 days)
//   DELETE /api/agent/lookups         clears it
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { clearLookups, listLookups, logLookup, usedToday } from './store.js';
import { runServerTool, serverTools } from './tools.js';

const DEVICE_TOOLS = new Set(['weather', 'calendar_event', 'calendar_search', 'news_article', 'open_link', 'recent_items', 'my_list']);

export async function agentRoutes(app) {
  const caps = app.config.agent;

  app.get('/api/agent/status', async (req) => {
    const user = requireUser(req);
    const used = usedToday(app, user.id);
    return {
      tools: serverTools(app, user.id),
      caps: { lookupsPerDay: caps.lookupsPerDay, webSearchesPerDay: caps.webSearchesPerDay },
      used,
    };
  });

  app.post('/api/agent/tool', async (req) => {
    const user = requireUser(req);
    const name = String(req.body?.name ?? '');
    const args = req.body?.args && typeof req.body.args === 'object' && !Array.isArray(req.body.args) ? req.body.args : {};
    const host = req.body?.host ? String(req.body.host) : undefined;
    const purpose = req.body?.purpose ? String(req.body.purpose) : undefined;
    const used = usedToday(app, user.id);
    if (used.lookups >= caps.lookupsPerDay) {
      throw new HttpError(429, 'lookups_limit', `Your hosts made ${caps.lookupsPerDay} lookups today, the most for one day. They read from what they already have until tomorrow.`);
    }
    if (name === 'web_search' && used.webSearches >= caps.webSearchesPerDay) {
      throw new HttpError(429, 'web_search_limit', `Your hosts searched the web ${caps.webSearchesPerDay} times today, the most for one day.`);
    }
    const t0 = Date.now();
    try {
      const tz = typeof req.body?.tz === 'string' ? req.body.tz.slice(0, 64) : undefined;
      const out = await runServerTool(app, user.id, name, args, { tz });
      logLookup(app, user.id, { tool: name, what: out.what, host, purpose, ms: Date.now() - t0, costUsd: out.costUsd });
      return { result: out.result, what: out.what };
    } catch (err) {
      if (!['unknown_tool', 'invalid_request', 'tool_unavailable'].includes(err.code)) {
        logLookup(app, user.id, { tool: name, what: `${name.replace(/_/g, ' ')} (did not work: ${String(err.message).slice(0, 80)})`, host, purpose, ok: false, ms: Date.now() - t0 });
      }
      throw err;
    }
  });

  app.post('/api/agent/lookups', async (req, reply) => {
    const user = requireUser(req);
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
    const now = Date.now();
    let n = 0;
    for (const it of items) {
      const tool = String(it?.tool ?? '');
      if (!DEVICE_TOOLS.has(tool) || !it.what) continue;
      const at = Number(it.at);
      logLookup(app, user.id, {
        tool,
        what: String(it.what),
        host: it.host,
        purpose: it.purpose,
        ok: it.ok !== false,
        ms: Number(it.ms),
        where: 'device',
        at: Number.isFinite(at) && at <= now && at > now - 86_400_000 ? at : now,
      });
      n++;
    }
    return reply.status(201).send({ saved: n });
  });

  app.get('/api/agent/lookups', async (req) => {
    const user = requireUser(req);
    return { lookups: listLookups(app, user.id, Number(req.query?.limit ?? 100) || 100) };
  });

  app.delete('/api/agent/lookups', async (req) => {
    const user = requireUser(req);
    return { cleared: clearLookups(app, user.id) };
  });
}
