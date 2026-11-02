// One fake HTTP server for every provider the server talks to: Google OAuth + APIs, X, OpenAI, Anthropic,
// speech servers and feeds. Tests point the server's provider URLs (env) at it.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createGoogleWrites, inviteVariants } from './fake-google-store.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/google/${name}`, import.meta.url), 'utf8'));
/** Real Google API shapes (scrubbed) for the hosts' lookups */
export const FX_CAL = fixture('calendar-events.json');
export const FX_MAIL = fixture('gmail-messages.json');

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * YouTube playlist 'PLBIG': 280 entries = 264 videos (2 of them with embedding off: 'blocked'), 7 private, 6 deleted and
 * 3 gone (listed, but videos.list does not return them). Video ids are 11 characters like real ones.
 */
export const BIG = Array.from({ length: 280 }, (_, i) => {
  const kind = i % 40 === 5 ? 'private' : i % 47 === 9 ? 'deleted' : i % 70 === 33 ? 'gone' : i % 90 === 17 ? 'blocked' : 'ok';
  return { id: `big${String(i).padStart(8, '0')}`, kind, title: `Artist ${i % 23} - Big Song ${i}`, channel: `Channel ${i % 23}` };
});
const BIG_BY_ID = new Map(BIG.map((v) => [v.id, v]));

export async function startFakeProviders(t) {
  const log = [];
  const tokens = new Map(); // access token -> { sub, scope }
  const refreshTokens = new Map(); // refresh token -> { sub, scope }
  const granted = new Map(); // sub -> Set of scopes granted on the consent page
  let n = 0;
  const state = { failNextChatWithMaxTokens: false, googleExpiresIn: 3600 };

  const issue = (sub, scope, withRefresh) => {
    n++;
    const access = `at-${sub}-${n}`;
    tokens.set(access, { sub, scope });
    const out = { access_token: access, expires_in: state.googleExpiresIn, scope, token_type: 'Bearer' };
    if (withRefresh) {
      const rt = `rt-${sub}-${n}`;
      refreshTokens.set(rt, { sub, scope });
      out.refresh_token = rt;
    }
    return out;
  };
  const authed = (req) => tokens.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  // what the actions write to (events by id, Google Tasks, "in:sent") + fault injection (fake-google-store.js); the
  // Q4 budget review invitation (Dana organizes, the listener is a guest) keeps its fixture time while that is ahead
  const t0 = Date.now();
  const invited = structuredClone(FX_CAL.invited);
  if (!(Date.parse(invited.end.dateTime) > t0 + 3_600_000)) {
    invited.start = { dateTime: new Date(t0 + 26 * 3_600_000).toISOString(), timeZone: 'America/New_York' };
    invited.end = { dateTime: new Date(t0 + 27 * 3_600_000).toISOString(), timeZone: 'America/New_York' };
  }
  const writes = createGoogleWrites({ events: [invited, ...inviteVariants(FX_CAL.invited, t0)], now: t0 });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const p = url.pathname;

    // ---- consent pages for browser tests: approve at once and send the browser back with a code.
    // Google: code = "<sub>|<requested scopes>|1" (sub = login_hint user part, else "e2e"); X: code = "e2e".
    if ((p === '/google/auth' || p === '/x/auth') && req.method === 'GET') {
      const q = url.searchParams;
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('state', q.get('state') ?? '');
      if (state.denyNext) {
        state.denyNext = false;
        back.searchParams.set('error', 'access_denied');
      } else if (p === '/google/auth') {
        const sub = (q.get('login_hint') ?? state.googleUser ?? 'e2e').split('@')[0];
        // like Google: include_granted_scopes=true adds what this user granted before
        const scopes = new Set(String(q.get('scope') ?? '').split(' ').filter(Boolean));
        if (q.get('include_granted_scopes') === 'true') for (const s of granted.get(sub) ?? []) scopes.add(s);
        granted.set(sub, scopes);
        back.searchParams.set('code', `${sub}|${[...scopes].join(' ')}|1`);
      } else {
        back.searchParams.set('code', 'e2e');
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // ---- Google OAuth: code = "<sub>|<scope words>|<refresh?>"
    if (p === '/google/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        if (!form.get('code_verifier')) return json(res, 400, { error: 'invalid_request', error_description: 'missing verifier' });
        const [sub, scope = 'openid email profile', refresh = '1'] = String(form.get('code')).split('|');
        if (sub === 'bad') return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(sub, scope, refresh === '1'));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const rt = refreshTokens.get(form.get('refresh_token'));
        if (!rt) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        state.refreshed = (state.refreshed ?? 0) + 1;
        return json(res, 200, issue(rt.sub, rt.scope, false));
      }
    }
    if (p === '/google/userinfo') {
      const a = authed(req);
      if (!a) return json(res, 401, { error: 'invalid_token' });
      // accounts named noverify* come back without email_verified (a provider that does not vouch for the address)
      const verified = a.sub.startsWith('noverify') ? {} : { email_verified: true };
      return json(res, 200, { sub: a.sub, email: `${a.sub}@gmail.test`, ...verified, name: `User ${a.sub}`, picture: 'https://img.test/p.png' });
    }
    if (p === '/google/revoke') return json(res, 200, {});

    if (writes.fixture(req, res, url, body)) return;

    // ---- Google APIs
    if (p.startsWith('/gapi/')) {
      const a = authed(req);
      if (!a) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
      if (await writes.serve(req, res, url, body, a.scope)) return;
      const has = (s) => a.scope.includes(s);
      const insufficient = () =>
        json(res, 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }], status: 'PERMISSION_DENIED' } });
      const now = Date.now();
      if (p === '/gapi/calendar/v3/users/me/calendarList') {
        if (!has('calendar.readonly')) return insufficient();
        return json(res, 200, { items: [{ id: 'primary@x', summary: 'Me', primary: true }, { id: 'family@x', summary: 'Family' }, { id: 'hidden@x', summary: 'Hidden', hidden: true }] });
      }
      const one = /^\/gapi\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p);
      if (one) {
        if (!has('calendar.readonly')) return insufficient();
        const id = decodeURIComponent(one[2]);
        const fx = { [FX_CAL.invited.id]: FX_CAL.invited, [FX_CAL.master.id]: FX_CAL.master, [FX_CAL.instance.id]: FX_CAL.instance }[id];
        return fx ? json(res, 200, fx) : json(res, 404, { error: { code: 404, message: 'Not Found' } });
      }
      const ev = /^\/gapi\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(p);
      if (ev) {
        const cal = decodeURIComponent(ev[1]);
        if (cal === 'hidden@x') return json(res, 500, {});
        const q = url.searchParams.get('q');
        if (q) return json(res, 200, { items: cal === 'primary@x' && /budget|dana/i.test(q) ? [{ ...FX_CAL.invited, start: { dateTime: new Date(now + 26 * 3600e3).toISOString() }, end: { dateTime: new Date(now + 27 * 3600e3).toISOString() } }] : [] });
        const items =
          cal === 'primary@x'
            ? [
                { id: 'e1', status: 'confirmed', summary: 'Dentist', start: { dateTime: new Date(now + 3 * 3600e3).toISOString() }, end: { dateTime: new Date(now + 4 * 3600e3).toISOString() }, location: 'Main St' },
                { id: 'e2', status: 'cancelled', summary: 'Gone', start: { dateTime: new Date(now + 3600e3).toISOString() } },
                { id: 'e3', summary: 'Declined', start: { dateTime: new Date(now + 3600e3).toISOString() }, attendees: [{ self: true, responseStatus: 'declined' }] },
              ]
            : [{ id: 'f1', summary: 'Birthday', start: { date: new Date(now + 86400e3).toISOString().slice(0, 10) }, end: { date: new Date(now + 2 * 86400e3).toISOString().slice(0, 10) } }];
        return json(res, 200, { items });
      }
      // the heads-up watch: where the mailbox is now, and what arrived since (m1 a promotion, m2 important)
      if (p === '/gapi/gmail/v1/users/me/profile') {
        if (!has('gmail.readonly')) return insufficient();
        return json(res, 200, { emailAddress: 'gina@example.com', historyId: '100' });
      }
      if (p === '/gapi/gmail/v1/users/me/history') {
        if (!has('gmail.readonly')) return insufficient();
        if (Number(url.searchParams.get('startHistoryId')) < 50) return json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
        const added = [
          { message: { id: 'm1', labelIds: ['UNREAD', 'INBOX', 'CATEGORY_PROMOTIONS'] } },
          { message: { id: 'm2', labelIds: ['UNREAD', 'INBOX', 'IMPORTANT'] } },
          { message: { id: 'm3', labelIds: ['SENT'] } },
        ];
        return json(res, 200, { historyId: '105', history: [{ id: '101', messagesAdded: added }] });
      }
      if (p === '/gapi/gmail/v1/users/me/messages') {
        if (!has('gmail.readonly')) return insufficient();
        if (/budget/i.test(url.searchParams.get('q') ?? '')) return json(res, 200, { messages: [{ id: FX_MAIL.dana.id }, { id: FX_MAIL.invite.id }], resultSizeEstimate: 2 });
        return json(res, 200, { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], resultSizeEstimate: 3 });
      }
      const fxMsg = /^\/gapi\/gmail\/v1\/users\/me\/messages\/([0-9a-f]{16})$/.exec(p);
      if (fxMsg) {
        const m = Object.values(FX_MAIL).find((x) => x?.id === fxMsg[1]);
        return m ? json(res, 200, m) : json(res, 404, { error: { code: 404, message: 'Not Found' } });
      }
      const fxThread = /^\/gapi\/gmail\/v1\/users\/me\/threads\/([0-9a-f]{16})$/.exec(p);
      if (fxThread) {
        if (fxThread[1] !== FX_MAIL.thread.id) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
        if (url.searchParams.get('format') === 'minimal') return json(res, 200, { messages: FX_MAIL.thread.messages.map((m) => ({ id: m.id })) });
        return json(res, 200, FX_MAIL.thread);
      }
      const msg = /^\/gapi\/gmail\/v1\/users\/me\/messages\/(m\d)$/.exec(p);
      if (msg) {
        const id = msg[1];
        const labels = { m1: ['UNREAD', 'CATEGORY_PROMOTIONS'], m2: ['UNREAD', 'IMPORTANT'], m3: ['UNREAD'] }[id];
        const at = { m1: now - 1000, m2: now - 5000, m3: now - 2000 }[id];
        return json(res, 200, {
          id,
          labelIds: labels,
          snippet: `Snippet &amp; ${id}`,
          internalDate: String(at),
          payload: { headers: [{ name: 'From', value: `"Sender ${id}" <${id}@mail.test>` }, { name: 'Subject', value: `Subject ${id}` }] },
        });
      }
      if (p.startsWith('/gapi/youtube/v3/')) {
        if (!has('youtube.readonly')) return insufficient();
        if (p === '/gapi/youtube/v3/playlists') {
          if (url.searchParams.get('id') === 'LL') return json(res, 200, { items: [{ id: 'LL', contentDetails: { itemCount: 42 } }] });
          return json(res, 200, { items: [{ id: 'PL1', snippet: { title: 'Road trip', thumbnails: { medium: { url: 'https://i.test/1.jpg' } } }, contentDetails: { itemCount: 2 } }] });
        }
        if (p === '/gapi/youtube/v3/playlistItems' && url.searchParams.get('playlistId') === 'PLBIG') {
          // a long list in pages of 50: private, deleted and gone videos among them (see bigPlaylist)
          const from = Number(String(url.searchParams.get('pageToken') ?? 'p0').slice(1)) || 0;
          const page = BIG.slice(from, from + 50).map((v) => ({
            snippet: v.kind === 'private' ? { title: 'Private video' } : v.kind === 'deleted' ? { title: 'Deleted video' } : { title: v.title, videoOwnerChannelTitle: v.channel },
            contentDetails: { videoId: v.id },
          }));
          return json(res, 200, { items: page, pageInfo: { totalResults: BIG.length }, ...(from + 50 < BIG.length ? { nextPageToken: `p${from + 50}` } : {}) });
        }
        if (p === '/gapi/youtube/v3/playlistItems') {
          return json(res, 200, {
            items: [
              { snippet: { title: 'Song A', videoOwnerChannelTitle: 'Artist A - Topic', thumbnails: { default: { url: 'https://i.test/a.jpg' } } }, contentDetails: { videoId: 'vidA' } },
              { snippet: { title: 'Deleted video' }, contentDetails: { videoId: 'vidX' } },
              { snippet: { title: 'Song B', videoOwnerChannelTitle: 'Label B' }, contentDetails: { videoId: 'vidB' } },
            ],
          });
        }
        if (p === '/gapi/youtube/v3/videos') {
          const ids = String(url.searchParams.get('id'))
            .split(',')
            .filter((id) => BIG_BY_ID.get(id)?.kind !== 'gone');
          // vidB: the owner turned embedding off
          return json(res, 200, { items: ids.map((id) => ({ id, contentDetails: { duration: 'PT3M25S' }, status: { embeddable: id !== 'vidB' && BIG_BY_ID.get(id)?.kind !== 'blocked' } })) });
        }
        if (p === '/gapi/youtube/v3/search') {
          return json(res, 200, { items: [{ id: { videoId: 'vidS' }, snippet: { title: 'Found &amp; played', channelTitle: 'Band' } }] });
        }
      }
      return json(res, 404, { error: { message: 'no such fake' } });
    }

    // ---- X
    if (p === '/x/token' && req.method === 'POST') {
      const want = `Basic ${Buffer.from('x-id:x-secret').toString('base64')}`;
      if (req.headers.authorization !== want) return json(res, 401, { error: 'unauthorized_client' });
      const form = new URLSearchParams(body);
      if (!form.get('code_verifier')) return json(res, 400, { error: 'invalid_request' });
      return json(res, 200, issue(`x${form.get('code')}`, 'users.read tweet.read', false));
    }
    if (p === '/x/2/users/me') {
      const a = authed(req);
      if (!a) return json(res, 401, {});
      return json(res, 200, { data: { id: a.sub.slice(1), name: 'Radio Fan', username: 'radiofan', profile_image_url: 'https://pbs.test/a_normal.jpg' } });
    }
    if (p === '/x/revoke') return json(res, 200, { revoked: true });

    // ---- pages the hosts open, and a SearXNG
    if (p === '/page/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html><head><title>Vendor prices rise 4% | Example News</title><meta property="og:site_name" content="Example News"></head><body><nav>Home | World | Sign up for our newsletter</nav><article><h1>Vendor prices rise 4%</h1><p>Office suppliers raised prices by about four percent this quarter, the trade group said on Friday.</p><p>Analysts expect the increase to hold through the first quarter of next year as shipping costs stay high.</p></article><footer>All rights reserved</footer><script>track()</script></body></html>');
    }
    if (p === '/page/private') return json(res, 401, { error: 'sign in' });
    if (p === '/searx/search') {
      return json(res, 200, { results: [{ title: 'Q4 budgets: what to expect', url: 'https://news.example.com/q4', content: 'Most firms plan flat budgets.' }, { title: 'Second', url: 'https://b.example.com/', content: 'More.' }] });
    }

    // ---- OpenAI-compatible chat
    if (p === '/openai/v1/chat/completions') {
      const b = JSON.parse(body);
      if (req.headers.authorization !== 'Bearer sk-good') return json(res, 401, { error: { message: 'Incorrect API key provided' } });
      if (b.model === 'new-model' && b.max_tokens !== undefined) {
        return json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
      }
      // a small local model that loops in JSON mode, and one that thinks out loud first
      if (b.model === 'loopy' && b.response_format) return json(res, 500, { error: { message: 'prediction aborted, token repeat limit reached' } });
      if (b.model === 'thinker') return json(res, 200, { model: b.model, choices: [{ message: { role: 'assistant', content: '<think>what to say</think>Hello there' } }] });
      // tools: 'notools' is a model without them (Ollama's words); 'tooler' asks for the first tool once, then answers
      if (b.tools && b.model === 'notools') return json(res, 400, { error: { message: 'registry.ollama.ai/library/notools does not support tools' } });
      if (b.tools && b.model === 'tooler') {
        const last = b.messages[b.messages.length - 1];
        if (last.role !== 'tool') {
          return json(res, 200, { model: b.model, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: b.tools[0].function.name, arguments: '{"query":"budget"}' } }] } }] });
        }
        return json(res, 200, { model: b.model, choices: [{ message: { role: 'assistant', content: `found:${last.tool_call_id}:${last.content.slice(0, 20)}` } }] });
      }
      const sys = b.messages[0];
      return json(res, 200, { model: b.model, choices: [{ message: { role: 'assistant', content: b.response_format ? '{"lines":[]}' : `ok:${sys.role}:${b.messages.length}` } }] });
    }
    if (p === '/openai/v1/models') return json(res, 200, { data: [{ id: 'zeta' }, { id: 'alpha' }] });
    if (p === '/anthropic/v1/messages') {
      if (req.headers['x-api-key'] !== 'sk-ant-good') return json(res, 401, { error: { message: 'invalid x-api-key' } });
      const b = JSON.parse(body);
      if (b.tools) {
        const last = b.messages[b.messages.length - 1];
        const result = Array.isArray(last.content) ? last.content.find((c) => c.type === 'tool_result') : undefined;
        if (!result) return json(res, 200, { model: b.model, stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_1', name: b.tools[0].name, input: { query: 'budget' } }] });
        return json(res, 200, { model: b.model, content: [{ type: 'text', text: `claude-found:${result.tool_use_id}:${String(result.content).slice(0, 20)}` }] });
      }
      return json(res, 200, { model: b.model, content: [{ type: 'text', text: `claude:${b.messages[0].role}:${b.system.length > 0}` }] });
    }
    if (p === '/anthropic/v1/models') return json(res, 200, { data: [{ id: 'claude-x' }] });

    // ---- speech
    if (p === '/tts/v1/audio/speech') {
      const b = JSON.parse(body);
      if (b.instructions) return json(res, 422, { detail: 'instructions: extra fields not permitted' });
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(Buffer.from(`ID3-${b.voice}-${b.model}`));
    }
    if (p === '/tts/v1/audio/voices') return json(res, 200, { voices: ['af_heart', 'am_adam'] });
    const el = /^\/eleven\/v1\/text-to-speech\/([^/]+)$/.exec(p);
    if (el) {
      if (req.headers['xi-api-key'] !== 'el-good') return json(res, 401, { detail: { message: 'bad key' } });
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(Buffer.from(`EL-${el[1]}`));
    }
    if (p === '/eleven/v1/voices') return json(res, 200, { voices: [{ voice_id: 'v1', name: 'Rachel', labels: { gender: 'female' } }] });

    // ---- feeds
    if (p === '/feed.ics') {
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
      return res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    }
    if (p === '/feed.rss') {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      return res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Test news</title><item><title>Local band plays tonight</title></item></channel></rss>');
    }
    if (p === '/echo-host') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`host=${req.headers.host}`);
    }
    if (p === '/to-private') {
      res.writeHead(302, { location: 'http://10.1.2.3/secret' });
      return res.end();
    }
    if (p === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(4 * 1024 * 1024));
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((r) => server.close(r)));

  const env = {
    PUBLIC_URL: 'http://hostcaster.test',
    GOOGLE_CLIENT_ID: 'g-id',
    GOOGLE_CLIENT_SECRET: 'g-secret',
    GOOGLE_AUTH_URL: `${base}/google/auth`,
    GOOGLE_TOKEN_URL: `${base}/google/token`,
    GOOGLE_USERINFO_URL: `${base}/google/userinfo`,
    GOOGLE_REVOKE_URL: `${base}/google/revoke`,
    GOOGLE_API_BASE: `${base}/gapi`,
    X_CLIENT_ID: 'x-id',
    X_CLIENT_SECRET: 'x-secret',
    X_AUTH_URL: `${base}/x/auth`,
    X_TOKEN_URL: `${base}/x/token`,
    X_REVOKE_URL: `${base}/x/revoke`,
    X_API_BASE: `${base}/x`,
  };
  /** the scopes granted to an access token ("Bearer at-..."), for stand-ins that proxy their sign-in to this fake */
  const scopeOf = (authorization) => tokens.get(String(authorization ?? '').replace(/^Bearer /, ''))?.scope;
  return { base, port, env, log, state, writes, scopeOf };
}
