// Notion connection routes: connect (Notion's own consent page), what the hosts may read, where they write, the notes
// they add when the listener asks, the activity log with Undo, and disconnect.
//
// Connect: the signed-in app asks POST /api/notion/start for a one-time URL and opens it (web: this tab; phone: the
// system browser with the app's code challenge). /auth/notion/start binds that browser and sends it to Notion; the
// callback must come back to the same browser. Web stores the link right away (the cookie session must be the same
// account); the phone app gets hostcaster://notion?code= and finishes with POST /api/notion/finish and its verifier.
import { requireUser } from '../../auth/session.js';
import { appChallengeOf, bindBrowser, browserMatches, verifierMatches } from '../../auth/binding.js';
import { putFlow, takeFlow } from '../../auth/flows.js';
import { HttpError } from '../../errors.js';
import { authorizeUrl, checkId, exchangeCode, notionClient, revokeToken } from './api.js';
import { readContext, forgetContext } from './read.js';
import { activityByRef, addActivity, deleteLink, getActivity, getLink, listActivity, markUndone, saveLink, saveSettings, writesSince } from './store.js';
import { cleanWriteText, editedWhen, pickerItem, stampOf, titleOf, writeBlock } from './text.js';

const MAX_WRITES_PER_HOUR = 30;
const TEXT_MAX = { todo: 300, note: 1000 };
const OUR_PAGE_TITLE = 'Host-Caster';

/** Only in-app hash routes come back from the start URL ("/settings/connections"). */
const safeReturn = (v) => (/^\/[A-Za-z0-9/_?=&.-]*$/.test(String(v ?? '')) && !String(v).startsWith('//') ? String(v) : '/settings/connections');

const webBack = (app, route, params) => `${app.config.publicUrl}/#${route}${route.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;
const appBack = (app, params) => `${app.config.appScheme}://notion?${new URLSearchParams(params)}`;

function requireConfigured(app) {
  if (!app.config.notion.enabled) throw new HttpError(409, 'notion_not_configured', 'Notion is not set up on this server');
}

/** What the app shows: never tokens. */
export function notionStatus(app, userId) {
  if (!app.config.notion.enabled) return { configured: false, connected: false };
  const link = getLink(app, userId);
  if (!link) return { configured: true, connected: false };
  return {
    configured: true,
    connected: true,
    workspace: { name: link.workspace.name ?? 'Notion', icon: link.workspace.icon ?? undefined },
    connectedAt: link.connectedAt,
    settings: link.settings,
  };
}

/** Revokes and forgets a user's Notion link (disconnect, account deletion). */
export async function forgetNotion(app, userId) {
  const link = getLink(app, userId);
  if (link) await revokeToken(app.config, link.tokens);
  deleteLink(app, userId);
  forgetContext(userId);
}

/** The page the hosts write to: an existing one, or a new "Host-Caster" page inside the one the listener chose. */
async function chooseWriteTarget(client, id, mode) {
  const page = await client.call('GET', `/v1/pages/${id}`);
  if (page.in_trash || page.archived) throw new HttpError(404, 'notion_not_shared', 'That page is in the trash');
  const title = titleOf(page) || 'Untitled';
  if (mode !== 'new') return { id: page.id, title, mode: 'direct' };
  const created = await client.call('POST', '/v1/pages', {
    parent: { type: 'page_id', page_id: page.id },
    icon: { type: 'emoji', emoji: '📻' },
    properties: { title: { title: [{ type: 'text', text: { content: OUR_PAGE_TITLE } }] } },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: 'Your Host-Caster hosts add notes and to-dos here when you ask them on air or from your AI app.' }, annotations: { color: 'gray' } },
          ],
        },
      },
    ],
  });
  return { id: created.id, title: OUR_PAGE_TITLE, mode: 'new', parentId: page.id, parentTitle: title, created: true };
}

/** Appends one block for the listener; every attempt (and why it failed) goes into the activity log. */
export async function writeForUser(app, userId, { kind, text, source, tz, ref }) {
  const link = getLink(app, userId);
  if (!link) throw new HttpError(409, 'notion_not_connected', 'Connect Notion first');
  const k = kind === 'todo' ? 'todo' : 'note';
  const clean = cleanWriteText(text, TEXT_MAX[k]);
  if (!clean) throw new HttpError(400, 'invalid_request', 'Nothing to add');
  const s = link.settings;
  if (ref) {
    const seen = activityByRef(app, userId, ref);
    if (seen) return seen.status === 'failed' ? { ok: false, code: 'duplicate', message: seen.error, activity: seen, duplicate: true } : { ok: true, activity: seen, pageTitle: seen.pageTitle, duplicate: true };
  }
  const fail = (code, message, extra = {}) => {
    const activity = addActivity(app, userId, { source, kind: k, text: clean, status: 'failed', error: message, ref, ...extra });
    return { ok: false, code, message, activity };
  };
  if (source !== 'recap' && !s.writesOn) return fail('notion_writes_off', 'Adding notes is turned off in Settings');
  if (!s.write) return fail('notion_no_page', 'No page is chosen for the hosts to write to');
  if (source !== 'recap' && writesSince(app, userId, 3600_000) >= MAX_WRITES_PER_HOUR) return fail('rate_limited', 'Too many notes this hour');
  const page = { pageId: s.write.id, pageTitle: s.write.title };
  try {
    const client = notionClient(app, userId);
    const res = await client.call('PATCH', `/v1/blocks/${s.write.id}/children`, { children: [writeBlock(k, clean, stampOf(Date.now(), tz), source)] });
    const blockId = res?.results?.[0]?.id;
    if (!blockId) return fail('upstream_error', 'Notion did not say what it added', page);
    forgetContext(userId);
    const activity = addActivity(app, userId, { source, kind: k, text: clean, status: 'done', blockId, ref, ...page });
    return { ok: true, activity, pageTitle: s.write.title };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return fail(err.code, err.message, page);
  }
}

const tzOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_+\-/]{1,60}$/.test(v) ? v : undefined);

export async function notionRoutes(app) {
  // ---- connect -----------------------------------------------------------------------------------------------------
  app.post('/api/notion/start', async (req) => {
    const user = requireUser(req);
    requireConfigured(app);
    const b = req.body ?? {};
    const isApp = b.app === true;
    const appChallenge = isApp ? appChallengeOf({ cc: b.cc }) : undefined;
    if (isApp && !appChallenge) throw new HttpError(400, 'app_outdated', 'Update the Host-Caster app to connect Notion');
    const ticket = putFlow(app.db, 'notionstart', {
      provider: 'notion',
      userId: user.id,
      data: { app: isApp, appChallenge, viaCookie: req.auth?.via === 'cookie', returnTo: safeReturn(b.return) },
    });
    return { url: `${app.config.publicUrl}/auth/notion/start?t=${encodeURIComponent(ticket)}` };
  });

  app.get('/auth/notion/start', async (req, reply) => {
    const ticket = takeFlow(app.db, 'notionstart', String(req.query?.t ?? ''));
    if (!ticket) return reply.redirect(webBack(app, '/settings/connections', { notion: 'link_expired' }));
    const { data } = ticket;
    if (!app.config.notion.enabled) {
      return reply.redirect(data.app ? appBack(app, { error: 'provider_disabled' }) : webBack(app, data.returnTo, { notion: 'provider_disabled' }));
    }
    const state = putFlow(app.db, 'oauth', { provider: 'notion', userId: ticket.userId, data: { ...data, bind: bindBrowser(app, req, reply) } });
    return reply.redirect(authorizeUrl(app.config, state));
  });

  app.get('/auth/notion/callback', async (req, reply) => {
    const q = req.query ?? {};
    const flow = takeFlow(app.db, 'oauth', String(q.state ?? ''));
    if (!flow || flow.provider !== 'notion') return reply.redirect(webBack(app, '/settings/connections', { notion: 'state_invalid' }));
    const { data } = flow;
    const fail = (error) => reply.redirect(data.app ? appBack(app, { error }) : webBack(app, data.returnTo, { notion: error }));
    if (!browserMatches(app, req, data.bind)) return fail('state_invalid');
    // web, same origin: the account signed in here must be the one that asked
    if (!data.app && data.viaCookie && req.user?.id !== flow.userId) return fail('state_invalid');
    if (q.error) return fail(q.error === 'access_denied' ? 'access_denied' : 'provider_error');
    if (!q.code) return fail('missing_code');
    let granted;
    try {
      granted = await exchangeCode(app.config, String(q.code));
    } catch (err) {
      req.log.warn({ code: err.code }, 'notion callback failed');
      return fail(err.code ?? 'provider_error');
    }
    if (data.app) {
      const code = putFlow(app.db, 'notionfinish', {
        provider: 'notion',
        userId: flow.userId,
        data: { challenge: data.appChallenge, sealed: app.sealer.seal(JSON.stringify(granted), `notionfinish:${flow.userId}`) },
      });
      return reply.redirect(appBack(app, { code }));
    }
    saveLink(app, flow.userId, granted);
    forgetContext(flow.userId);
    return reply.redirect(webBack(app, data.returnTo, { notion: 'connected' }));
  });

  app.post('/api/notion/finish', async (req) => {
    const user = requireUser(req);
    const flow = takeFlow(app.db, 'notionfinish', String(req.body?.code ?? ''));
    if (!flow || flow.userId !== user.id || !verifierMatches(flow.data.challenge, req.body?.verifier)) {
      throw new HttpError(400, 'code_invalid', 'That link expired. Try again.');
    }
    saveLink(app, user.id, JSON.parse(app.sealer.open(flow.data.sealed, `notionfinish:${user.id}`)));
    forgetContext(user.id);
    return notionStatus(app, user.id);
  });

  app.get('/api/notion/status', async (req) => notionStatus(app, requireUser(req).id));

  app.delete('/api/notion', async (req, reply) => {
    const user = requireUser(req);
    await forgetNotion(app, user.id);
    return reply.status(204).send();
  });

  // ---- choose pages ------------------------------------------------------------------------------------------------
  /** Pages and databases the listener shared with Host-Caster on Notion's consent page (newest first). */
  app.get('/api/notion/pages', async (req) => {
    const user = requireUser(req);
    requireConfigured(app);
    const client = notionClient(app, user.id);
    const query = String(req.query?.q ?? '').slice(0, 100);
    const res = await client.call('POST', '/v1/search', {
      ...(query ? { query } : {}),
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 50,
    });
    const items = (res.results ?? [])
      .filter((o) => (o.object === 'page' || o.object === 'data_source') && !o.in_trash && !o.archived)
      // rows of a database are pages too: the database itself is the useful choice
      .filter((o) => o.object !== 'page' || o.parent?.type !== 'data_source_id')
      .map(pickerItem)
      .map((i) => ({ ...i, edited: editedWhen(i.editedAt, Date.now(), tzOf(req.query?.tz)) }));
    return { items };
  });

  app.put('/api/notion/settings', async (req) => {
    const user = requireUser(req);
    requireConfigured(app);
    const link = getLink(app, user.id);
    if (!link) throw new HttpError(409, 'notion_not_connected', 'Connect Notion first');
    const b = req.body ?? {};
    const next = { ...link.settings };
    if (typeof b.writesOn === 'boolean') next.writesOn = b.writesOn;
    if (typeof b.recapOn === 'boolean') next.recapOn = b.recapOn;
    if (Array.isArray(b.read)) {
      if (b.read.length > 5) throw new HttpError(400, 'invalid_request', 'Up to 5 pages');
      const client = notionClient(app, user.id);
      const read = [];
      for (const r of b.read) {
        const id = checkId(r?.id);
        const type = r?.type === 'data_source' ? 'data_source' : 'page';
        const obj = await client.call('GET', type === 'page' ? `/v1/pages/${id}` : `/v1/data_sources/${id}`);
        read.push({ id: obj.id, type, title: titleOf(obj) || 'Untitled' });
      }
      next.read = read;
      forgetContext(user.id);
    }
    if (b.write === null) next.write = null;
    else if (b.write && typeof b.write === 'object') {
      const id = checkId(b.write.id);
      // choosing the same parent again (new page mode) keeps the Host-Caster page made for it
      const same = link.settings.write && (link.settings.write.mode === 'new' ? link.settings.write.parentId : link.settings.write.id) === id;
      if (same && (b.write.mode === 'new') === (link.settings.write.mode === 'new')) next.write = link.settings.write;
      else {
        const target = await chooseWriteTarget(notionClient(app, user.id), id, b.write.mode === 'direct' ? 'direct' : 'new');
        next.write = { id: target.id, title: target.title, mode: target.mode, ...(target.parentId ? { parentId: target.parentId, parentTitle: target.parentTitle } : {}) };
      }
    }
    return { settings: saveSettings(app, user.id, next) };
  });

  // ---- read: the hosts' notes --------------------------------------------------------------------------------------
  app.get('/api/notion/context', async (req) => {
    const user = requireUser(req);
    requireConfigured(app);
    return readContext(app, user.id, Date.now(), tzOf(req.query?.tz));
  });

  // ---- write: only what the listener asked for ---------------------------------------------------------------------
  app.post('/api/notion/write', async (req, reply) => {
    const user = requireUser(req);
    requireConfigured(app);
    const b = req.body ?? {};
    const source = b.source === 'app' ? 'app' : b.source === 'call' ? 'call' : undefined;
    if (!source) throw new HttpError(400, 'invalid_request', 'source must be call or app');
    if (b.kind !== 'todo' && b.kind !== 'note') throw new HttpError(400, 'invalid_request', 'kind must be todo or note');
    const ref = typeof b.ref === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(b.ref) ? b.ref : undefined;
    const result = await writeForUser(app, user.id, { kind: b.kind, text: b.text, source, tz: tzOf(b.tz), ref });
    return reply.status(result.ok ? 201 : 200).send(result);
  });

  /** Daily recap (off by default): at most one a day, only when the listener turned it on. */
  app.post('/api/notion/recap', async (req) => {
    const user = requireUser(req);
    requireConfigured(app);
    const link = getLink(app, user.id);
    if (!link) throw new HttpError(409, 'notion_not_connected', 'Connect Notion first');
    const day = String(req.body?.day ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'invalid_request', 'day must be YYYY-MM-DD');
    if (!link.settings.recapOn) return { ok: false, code: 'recap_off' };
    if (link.settings.recapDay === day) return { ok: false, code: 'recap_done' };
    const result = await writeForUser(app, user.id, { kind: 'note', text: req.body?.text, source: 'recap', tz: tzOf(req.body?.tz) });
    if (result.ok) saveSettings(app, user.id, { ...getLink(app, user.id).settings, recapDay: day });
    return result;
  });

  app.get('/api/notion/activity', async (req) => ({ items: listActivity(app, requireUser(req).id) }));

  /** Undo: moves only the block the hosts added to Notion's trash (never anything else on the page). */
  app.post('/api/notion/activity/:id/undo', async (req) => {
    const user = requireUser(req);
    requireConfigured(app);
    const a = getActivity(app, user.id, String(req.params.id));
    if (!a) throw new HttpError(404, 'not_found', 'No such note');
    if (a.status === 'undone') return { activity: a };
    if (a.status !== 'done' || !a.blockId) throw new HttpError(409, 'not_undoable', 'Nothing was added, so there is nothing to undo');
    const client = notionClient(app, user.id);
    try {
      await client.call('DELETE', `/v1/blocks/${checkId(a.blockId)}`);
    } catch (err) {
      // already gone (the listener removed it in Notion): it is undone either way
      if (err.code !== 'notion_not_shared') throw err;
    }
    forgetContext(user.id);
    return { activity: markUndone(app, user.id, a.id) };
  });
}
