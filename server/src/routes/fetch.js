// POST /api/fetch-text {url}: ICS calendars and RSS/Atom feeds through the server (no CORS on most feeds).
// Signed-in users only; private addresses are refused unless the operator allows them (see net/egress.js).
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { userRequest } from '../net/http.js';

const MAX = 3 * 1024 * 1024;

function decode(buf, contentType) {
  const charset = /charset=([^;]+)/i.exec(contentType ?? '')?.[1]?.trim().replace(/"/g, '');
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export async function fetchRoutes(app) {
  app.post('/api/fetch-text', async (req) => {
    requireUser(req);
    let url = String(req.body?.url ?? '').trim();
    if (!url) throw new HttpError(400, 'invalid_url', 'url is required');
    if (/^webcals?:\/\//i.test(url)) url = url.replace(/^webcals?:/i, 'https:');
    const res = await userRequest(app.egressCtx, url, {
      headers: { accept: 'text/calendar, application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.8, */*;q=0.5' },
      timeoutMs: 15000,
      maxBytes: MAX,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(502, 'upstream_error', `The feed answered HTTP ${res.status}`);
    }
    const contentType = res.headers['content-type'] ? String(res.headers['content-type']) : undefined;
    return { text: decode(res.body, contentType), contentType, url: res.url };
  });
}
