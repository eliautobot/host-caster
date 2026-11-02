// A fake OpenAI for Sign in with ChatGPT (OSS ChatGPT plan usage): discovery, JWKS, the authorize page (dynamic
// client registration, auto-consent), token endpoint (code + PKCE, rotating refresh, reuse detection), revocation,
// GET /v1/models and streamed POST /v1/responses with the plan route's rules and errors. Used by node:test and, run
// as a script, by the Playwright walk:  node server/test/fake-chatgpt.js <port>
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'];
const RESOURCE = 'https://api.openai.com/v1';
const CALLBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\/callback$/;
const HOST_ID = /^(urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}|urn:uuid:[0-9a-f-]{36}|did:key:z\w+)$/;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req_${randomBytes(4).toString('hex')}`, ...headers });
  res.end(JSON.stringify(body));
};
const id = (p) => `${p}_${randomBytes(8).toString('hex')}`;

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {{ port?: number }} [opts] */
export async function startFakeChatGPT(opts = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fake-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const log = [];
  const clients = new Map(); // issued client id -> { sub }
  const codes = new Map(); // code -> { clientId, sub, challenge, redirectUri, nonce, scope, resource }
  const access = new Map(); // access token -> { clientId, sub, exp, refresh }
  const refreshes = new Map(); // refresh token -> { clientId, sub, scope, used, revoked }
  const state = {
    /** who consents on the authorize page */
    user: { sub: 'user-alpha', email: 'listener@example.com', name: 'Alex Listener' },
    /** grant ChatGPT plan use (chatgpt.tokens.use.direct) */
    grantPlan: true,
    denyNext: false,
    expiresIn: 3600,
    /** next responses call fails: 'limit' | 'limit-stream' | 'invalid-user' | 'unavailable' | 'not-eligible' | 'incomplete' | 'cut' */
    failNext: undefined,
    /** answer 400 unsupported_capability for reasoning */
    rejectReasoning: false,
    /** the refresh endpoint answers 503 / invalid_grant */
    refreshFails: undefined,
    reply: undefined,
  };
  let base = '';

  const signJwt = (claims) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', typ: 'JWT', kid });
    const body = enc(claims);
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };

  const issue = (clientId, sub, scope, nonce) => {
    const now = Math.floor(Date.now() / 1000);
    const at = id('at');
    const rt = id('rt');
    access.set(at, { clientId, sub, exp: Date.now() + state.expiresIn * 1000, refresh: rt });
    refreshes.set(rt, { clientId, sub, scope });
    const user = [...clients.values()].find((c) => c.sub === sub)?.user ?? state.user;
    return {
      access_token: at,
      refresh_token: rt,
      id_token: signJwt({ iss: base, sub, aud: [clientId], ...(nonce ? { nonce } : {}), email: user.email, name: user.name, iat: now, exp: now + 3600, auth_time: now }),
      token_type: 'Bearer',
      expires_in: state.expiresIn,
      scope,
      earliest_refresh_at: now,
    };
  };

  const bearer = (req) => {
    const tok = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const a = access.get(tok);
    return a && a.exp > Date.now() ? a : undefined;
  };

  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': id('req') });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };

  const defaultReply = (body) => {
    const all = `${body.instructions ?? ''} ${JSON.stringify(body.input)}`;
    if (/json/i.test(all) || body.text?.format?.type === 'json_object') {
      return JSON.stringify({ lines: [{ text: 'You are listening to Host-Caster, written on a ChatGPT plan.' }, { text: 'Here comes the next song.' }] });
    }
    return 'Hello from your ChatGPT plan, the mic is live.';
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await readBody(req);
    const p = url.pathname;
    log.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw });

    // test control (browser tests): POST /__control {"failNext":"limit"} patches `state`; ?expire=1 expires tokens
    if (p === '/__control' && req.method === 'POST') {
      Object.assign(state, raw ? JSON.parse(raw) : {});
      if (url.searchParams.get('expire')) for (const a of access.values()) a.exp = Date.now() - 1000;
      return json(res, 200, { ok: true, clients: clients.size, refreshes: refreshes.size });
    }
    if (p === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/api/accounts/authorize`,
        token_endpoint: `${base}/api/accounts/oauth/token`,
        jwks_uri: `${base}/.well-known/jwks.json`,
        revocation_endpoint: `${base}/api/accounts/oauth/revoke`,
      });
    }
    if (p === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });

    if (p === '/api/accounts/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      const fail = (msg) => {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`fake authorize: ${msg}`);
      };
      const redirectUri = q.get('redirect_uri') ?? '';
      const clientId = q.get('client_id') ?? '';
      if (!CALLBACK.test(redirectUri)) return fail('redirect_uri must be http://127.0.0.1:<port>/auth/callback');
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return fail('PKCE S256 code flow only');
      if (!q.get('state') || !q.get('nonce')) return fail('state and nonce required');
      if (q.get('resource') !== RESOURCE) return fail('resource');
      if (!HOST_ID.test(q.get('ext_agent_host_id') ?? '')) return fail('ext_agent_host_id');
      const scopes = String(q.get('scope') ?? '').split(' ');
      for (const s of ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']) if (!scopes.includes(s)) return fail(`scope ${s}`);
      const dynamic = clientId === 'dynamic_agent_client';
      if (dynamic && !q.get('agent_name_hint')) return fail('agent_name_hint required on registration');
      if (!dynamic && q.get('agent_name_hint')) return fail('agent_name_hint only on registration');
      if (!dynamic && !clients.has(clientId)) return fail('unknown client');
      const back = new URL(redirectUri);
      back.searchParams.set('state', q.get('state'));
      if (state.denyNext) {
        state.denyNext = false;
        back.searchParams.set('error', 'access_denied');
      } else {
        const issued = dynamic ? id('oaiapp') : clientId;
        if (dynamic) clients.set(issued, { sub: state.user.sub, user: { ...state.user }, hint: q.get('agent_name_hint') });
        const granted = scopes.filter((s) => s !== 'chatgpt.tokens.use.direct' || state.grantPlan).join(' ');
        const code = id('code');
        codes.set(code, { clientId: issued, sub: state.user.sub, challenge: q.get('code_challenge'), redirectUri, nonce: q.get('nonce'), scope: granted, resource: q.get('resource') });
        back.searchParams.set('code', code);
        back.searchParams.set('scope', granted);
        if (dynamic) back.searchParams.set('client_id', issued);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (p === '/api/accounts/oauth/token' && req.method === 'POST') {
      const f = new URLSearchParams(raw);
      if (f.get('resource') !== RESOURCE) return json(res, 400, { error: 'invalid_target' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        const challenge = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (!c || c.clientId !== f.get('client_id') || c.redirectUri !== f.get('redirect_uri') || c.challenge !== challenge) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        return json(res, 200, issue(c.clientId, c.sub, c.scope, c.nonce));
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (state.refreshFails === 'unavailable') return json(res, 503, { error: 'temporarily_unavailable' });
        const r = refreshes.get(f.get('refresh_token'));
        if (!r || r.revoked || state.refreshFails === 'invalid_grant') return json(res, 400, { error: 'invalid_grant' });
        if (r.used) return json(res, 400, { error: 'refresh_token_reused' });
        if (r.clientId !== f.get('client_id')) return json(res, 401, { error: 'invalid_client' });
        r.used = true;
        const out = issue(r.clientId, r.sub, r.scope);
        delete out.scope; // OAuth may omit an unchanged scope on refresh
        return json(res, 200, out);
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (p === '/api/accounts/oauth/revoke' && req.method === 'POST') {
      const f = new URLSearchParams(raw);
      const r = refreshes.get(f.get('token'));
      if (r && r.clientId === f.get('client_id')) {
        r.revoked = true;
        for (const [k, a] of access) if (a.refresh === f.get('token')) access.delete(k);
      }
      res.writeHead(200);
      return res.end();
    }

    if (p === '/v1/models' && req.method === 'GET') {
      if (!bearer(req)) return json(res, 401, { detail: 'Unauthorized' });
      return json(res, 200, {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'gpt-6.1-luna', display_name: 'GPT-6.1 Luna', visibility: 'list' },
          { slug: 'internal-eval', display_name: 'Internal', visibility: 'hide' },
        ],
      });
    }

    if (p === '/v1/responses' && req.method === 'POST') {
      const who = bearer(req);
      if (!who) return json(res, 401, { error: { code: 'subscription_sharing_invalid_user', message: 'invalid user' } });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: { code: 'invalid_json' } });
      }
      const unsupported = (param) => json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param, message: 'unsupported' } });
      if (body.store !== false) return unsupported('store');
      if (body.stream !== true) return unsupported('stream');
      for (const k of FORBIDDEN) if (k in body) return unsupported(k);
      if (!Array.isArray(body.input) || body.input.some((m) => m.role === 'system' || m.type === 'message' && m.role === 'system')) return unsupported('input');
      if (state.rejectReasoning && body.reasoning) return unsupported('reasoning.effort');
      const fail = state.failNext;
      state.failNext = undefined;
      if (fail === 'limit') return json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } });
      if (fail === 'not-eligible') return json(res, 403, { error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } });
      if (fail === 'unavailable') return json(res, 503, { detail: 'Direct routing is unavailable' });
      if (fail === 'invalid-user') return json(res, 401, { error: { code: 'subscription_sharing_invalid_user', message: 'invalid' } });
      // function tools (the hosts' lookups): a call first, then an answer that quotes the result
      if (Array.isArray(body.tools) && body.tools.length) {
        const rid = id('resp');
        const done = body.input.find((m) => m.type === 'function_call_output');
        if (!done) {
          const call = { type: 'function_call', id: id('fc'), call_id: 'call_1', name: body.tools[0].name, arguments: '{"query":"q4"}' };
          return sse(res, [{ type: 'response.created', response: { id: rid, status: 'in_progress', model: body.model } }, { type: 'response.completed', response: { id: rid, status: 'completed', model: body.model, output: [call] } }]);
        }
        return sse(res, [{ type: 'response.output_text.delta', delta: `found ${done.output}` }, { type: 'response.completed', response: { id: rid, status: 'completed', model: body.model } }]);
      }
      const text = (state.reply ?? defaultReply)(body);
      const half = Math.ceil(text.length / 2);
      const rid = id('resp');
      const created = { type: 'response.created', response: { id: rid, status: 'in_progress', model: body.model } };
      const deltas = [text.slice(0, half), text.slice(half)].map((delta) => ({ type: 'response.output_text.delta', delta }));
      if (fail === 'limit-stream') {
        return sse(res, [created, deltas[0], { type: 'response.failed', response: { id: rid, status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }]);
      }
      if (fail === 'incomplete') return sse(res, [created, deltas[0], { type: 'response.incomplete', response: { id: rid, status: 'incomplete' } }]);
      if (fail === 'cut') return sse(res, [created, deltas[0]]);
      return sse(res, [
        created,
        ...deltas,
        { type: 'response.completed', response: { id: rid, status: 'completed', model: body.model, usage: { input_tokens: 10, output_tokens: 12 } } },
      ]);
    }

    json(res, 404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    log,
    state,
    clients,
    access,
    refreshes,
    signJwt,
    /** expire every access token now (the next call must refresh) */
    expireAccess: () => {
      for (const a of access.values()) a.exp = Date.now() - 1000;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// standalone for the browser tests: node server/test/fake-chatgpt.js <port>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = await startFakeChatGPT({ port: Number(process.argv[2] ?? 0) });
  console.log(`fake chatgpt on ${fake.base}`);
}
