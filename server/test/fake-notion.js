// A small fake of Notion's OAuth + API (the parts Host-Caster uses), for server tests and the browser e2e.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const rt = (content) => [{ type: 'text', plain_text: content, text: { content } }];
export const todo = (text, checked = false) => ({ type: 'to_do', to_do: { rich_text: rt(text), checked } });
export const para = (text) => ({ type: 'paragraph', paragraph: { rich_text: rt(text) } });
export const heading = (text) => ({ type: 'heading_2', heading_2: { rich_text: rt(text) } });
export const bullet = (text) => ({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(text) } });

export async function startFakeNotion(t, { clientId = 'notion-client', clientSecret = 'notion-secret' } = {}) {
  const log = [];
  const tokens = new Map(); // access -> refresh
  const refresh = new Map(); // refresh -> true
  const revoked = [];
  const pages = new Map(); // id -> { id, title, parent, blocks: [], in_trash, last_edited_time }
  const sources = new Map(); // id -> { id, title, rows: [] }
  const state = { n: 0, expireAll: false, noRefresh: false };

  const now = () => new Date().toISOString();
  const addPage = (title, blocks = [], parent = { type: 'workspace', workspace: true }) => {
    const id = randomUUID();
    pages.set(id, { id, title, parent, in_trash: false, last_edited_time: now(), blocks: blocks.map((b) => ({ id: randomUUID(), object: 'block', has_children: false, in_trash: false, ...b })) });
    return id;
  };
  const addSource = (title, rows) => {
    const id = randomUUID();
    sources.set(id, { id, title, rows: rows.map((r) => ({ id: randomUUID(), object: 'page', in_trash: false, last_edited_time: now(), parent: { type: 'data_source_id', data_source_id: id }, ...r })) });
    return id;
  };
  const pageObj = (p) => ({
    object: 'page',
    id: p.id,
    parent: p.parent,
    in_trash: p.in_trash,
    last_edited_time: p.last_edited_time,
    icon: { type: 'emoji', emoji: '📝' },
    url: `https://www.notion.so/${p.id.replace(/-/g, '')}`,
    properties: { title: { id: 'title', type: 'title', title: rt(p.title) } },
  });
  const sourceObj = (s) => ({ object: 'data_source', id: s.id, title: rt(s.title), in_trash: false, last_edited_time: now() });
  const findBlock = (id) => {
    for (const p of pages.values()) {
      const b = p.blocks.find((x) => x.id === id);
      if (b) return { page: p, block: b };
    }
    return undefined;
  };
  const issue = () => {
    state.n++;
    const access = `ntn-access-${state.n}`;
    const r = `ntn-refresh-${state.n}`;
    tokens.set(access, r);
    refresh.set(r, true);
    return { access_token: access, refresh_token: state.noRefresh ? null : r };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname;
    log.push({ method: req.method, path: p, body, headers: req.headers });

    // consent page for browser tests: approve at once
    if (p === '/v1/oauth/authorize' && req.method === 'GET') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (state.denyNext) {
        state.denyNext = false;
        back.searchParams.set('error', 'access_denied');
      } else back.searchParams.set('code', 'good-code');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (p.startsWith('/v1/oauth/')) {
      const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (req.headers.authorization !== basic) return json(res, 401, { error: 'invalid_client' });
      if (p === '/v1/oauth/revoke') {
        revoked.push(body.token);
        tokens.delete(body.token);
        return json(res, 200, {});
      }
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'good-code') return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, {
          ...issue(),
          token_type: 'bearer',
          bot_id: 'bot-1',
          workspace_id: 'ws-1',
          workspace_name: "Sam's Space",
          workspace_icon: '🎧',
          owner: { type: 'workspace', workspace: true },
          duplicated_template_id: null,
          redirect_uri_seen: body.redirect_uri,
        });
      }
      if (body.grant_type === 'refresh_token' && refresh.has(body.refresh_token) && !state.refuseRefresh) {
        refresh.delete(body.refresh_token);
        return json(res, 200, { ...issue(), token_type: 'bearer', bot_id: 'bot-1' });
      }
      return json(res, 400, { error: 'invalid_grant' });
    }

    const access = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!tokens.has(access) || state.expireAll) {
      state.expireAll = false;
      return json(res, 401, { object: 'error', code: 'unauthorized' });
    }
    if (!req.headers['notion-version']) return json(res, 400, { object: 'error', code: 'missing_version' });
    const notFound = () => json(res, 404, { object: 'error', code: 'object_not_found', message: 'Could not find it' });
    let m;
    if (p === '/v1/search' && req.method === 'POST') {
      const q = String(body.query ?? '').toLowerCase();
      const results = [
        ...[...pages.values()].filter((x) => !x.in_trash).map(pageObj),
        ...[...sources.values()].map(sourceObj),
        ...[...sources.values()].flatMap((s) => s.rows),
      ].filter((o) => !q || JSON.stringify(o).toLowerCase().includes(q));
      return json(res, 200, { object: 'list', results, has_more: false });
    }
    if ((m = /^\/v1\/pages\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const page = pages.get(m[1]);
      return page ? json(res, 200, pageObj(page)) : notFound();
    }
    if (p === '/v1/pages' && req.method === 'POST') {
      const parent = pages.get(body.parent?.page_id);
      if (!parent) return notFound();
      const title = body.properties?.title?.title?.[0]?.text?.content ?? 'Untitled';
      const id = addPage(title, (body.children ?? []).map((c) => ({ ...c, [c.type]: { ...c[c.type], rich_text: c[c.type].rich_text.map((x) => ({ ...x, plain_text: x.text.content })) } })), { type: 'page_id', page_id: parent.id });
      parent.blocks.push({ id, object: 'block', type: 'child_page', child_page: { title }, has_children: true, in_trash: false });
      return json(res, 200, pageObj(pages.get(id)));
    }
    if ((m = /^\/v1\/blocks\/([^/]+)\/children$/.exec(p))) {
      const page = pages.get(m[1]);
      if (!page) return notFound();
      if (req.method === 'GET') return json(res, 200, { object: 'list', results: page.blocks.filter((b) => !b.in_trash), has_more: false });
      if (req.method === 'PATCH') {
        const added = (body.children ?? []).map((c) => ({
          id: randomUUID(),
          object: 'block',
          has_children: false,
          in_trash: false,
          type: c.type,
          [c.type]: { ...c[c.type], rich_text: c[c.type].rich_text.map((x) => ({ ...x, plain_text: x.text.content })) },
        }));
        page.blocks.push(...added);
        page.last_edited_time = now();
        return json(res, 200, { object: 'list', results: added });
      }
    }
    if ((m = /^\/v1\/blocks\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
      const hit = findBlock(m[1]);
      if (!hit || hit.block.in_trash) return notFound();
      hit.block.in_trash = true;
      return json(res, 200, { ...hit.block, in_trash: true });
    }
    if ((m = /^\/v1\/data_sources\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const s = sources.get(m[1]);
      return s ? json(res, 200, sourceObj(s)) : notFound();
    }
    if ((m = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(p)) && req.method === 'POST') {
      const s = sources.get(m[1]);
      return s ? json(res, 200, { object: 'list', results: s.rows.slice(0, body.page_size ?? 100), has_more: false }) : notFound();
    }
    return json(res, 404, { object: 'error', code: 'invalid_request_url' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t?.after?.(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    log,
    pages,
    sources,
    revoked,
    state,
    addPage,
    addSource,
    env: { NOTION_CLIENT_ID: clientId, NOTION_CLIENT_SECRET: clientSecret, NOTION_API_BASE: base, NOTION_AUTH_URL: `${base}/v1/oauth/authorize` },
    close: () => new Promise((r) => server.close(r)),
  };
}
