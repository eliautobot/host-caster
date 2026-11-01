// "Use your ChatGPT plan": Sign in with ChatGPT for open-source apps, per Host-Caster user. The server is the agent host,
// keeps each user's registration and tokens, refreshes them, and runs that user's Responses requests. One user's
// ChatGPT account is never used for another user's requests (every lookup is by the signed-in user's id).
import { randomToken } from '../crypto.js';
import { pkcePair, putFlow, takeFlow } from '../auth/flows.js';
import { chatgptError, TERMINAL_REFRESH, upstreamCode } from './errors.js';
import { loadHostId } from './host.js';
import { CALLBACK_PATH, createLoopback } from './loopback.js';
import { createOidc } from './oidc.js';
import { listModels, streamResponse } from './responses.js';
import { createStore } from './store.js';

export const APP_NAME = 'Host-Caster';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const CLIENT_ID = /^[A-Za-z0-9_-]{1,200}$/;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** after a usage-limit answer, new plan requests wait this long (the Test button can still try) */
const LIMIT_PAUSE_MS = 10 * 60 * 1000;
const ATTEMPT = 'chatgpt:attempt';
const WELCOMED = 'chatgpt:welcomed';

/** Token endpoint answer -> the stored token set. Throws on anything incomplete. */
function tokenSet(body, previous) {
  const scope = typeof body?.scope === 'string' ? body.scope : previous?.scope;
  if (typeof scope !== 'string') throw chatgptError.failed('ChatGPT did not confirm the granted permissions. Please sign in again.');
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (
    typeof body.access_token !== 'string' ||
    !body.access_token ||
    String(body.token_type ?? '').toLowerCase() !== 'bearer' ||
    typeof body.expires_in !== 'number' ||
    body.expires_in <= 0 ||
    (scopes.includes('offline_access') && (typeof body.refresh_token !== 'string' || !body.refresh_token))
  ) {
    throw chatgptError.failed('ChatGPT returned incomplete credentials. Please sign in again.');
  }
  const t = Date.now();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    idToken: typeof body.id_token === 'string' ? body.id_token : previous?.idToken,
    tokenType: 'Bearer',
    expiresAt: t + body.expires_in * 1000,
    ...(body.earliest_refresh_at !== undefined ? { earliestRefreshAt: refreshTime(body.earliest_refresh_at) } : {}),
    scope: scopes.join(' '),
    savedAt: new Date(t).toISOString(),
  };
}

/** earliest_refresh_at: unix seconds, ms or an ISO string */
function refreshTime(v) {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * @param {object} app the server (config, db, sealer, log)
 * @param {{ store?: ReturnType<typeof createStore>, flows?: { put: Function, take: Function } }} [deps] another store
 *   and one-time flow keeper (the desktop app's local helper keeps one person's sign-in on their PC, without SQLite)
 */
export function createChatGPT(app, deps = {}) {
  const cfg = app.config.chatgpt;
  const store = deps.store ?? createStore(app);
  const flows = deps.flows ?? { put: (kind, value) => putFlow(app.db, kind, value), take: (kind, raw) => takeFlow(app.db, kind, raw) };
  const oidc = createOidc(cfg.issuer);
  const refreshing = new Map();
  let hostId;
  const host = () => (hostId ??= loadHostId(app.config.dataDir));
  const loopback = createLoopback({
    port: cfg.callbackPort,
    bind: cfg.callbackBind,
    backUrl: app.config.publicUrl,
    log: app.log,
    onCallback: (url) => complete(url).then(() => ({ ok: true, message: 'Connected' })),
  });
  const need = () => {
    if (!cfg.enabled) throw chatgptError.off();
  };
  const attempt = (userId, value) => store.setState(userId, ATTEMPT, { ...value, at: Date.now() });

  /**
   * Starts a sign-in: fresh state, nonce and PKCE verifier, the host id persisted first. Reuses the user's issued
   * client id (with login_hint) unless `fresh` (a different ChatGPT account); `reconsent` asks for plan use again.
   * `loopbackPort`: the app listens on its own 127.0.0.1 (phone) instead of this server.
   */
  async function start(userId, { fresh = false, reconsent = false, loopbackPort } = {}) {
    need();
    const hid = host();
    const saved = fresh ? undefined : store.saved(userId);
    const d = await oidc.config();
    let redirectPort = Number(loopbackPort);
    let listening = Number.isInteger(redirectPort) && redirectPort > 0 && redirectPort < 65536;
    if (!listening) ({ port: redirectPort, listening } = await loopback.ensure());
    const redirectUri = `http://127.0.0.1:${redirectPort}${CALLBACK_PATH}`;
    const { verifier, challenge } = pkcePair();
    const nonce = randomToken(24);
    const flowData = { verifier, nonce, redirectUri, clientId: saved?.client_id ?? null, accountId: saved?.id ?? null };
    const state = flows.put('chatgpt', {
      provider: 'chatgpt',
      userId,
      data: { sealed: app.sealer.seal(JSON.stringify(flowData), `chatgpt-flow:${userId}`) },
    });
    const url = new URL(d.authorization_endpoint);
    const q = url.searchParams;
    q.set('client_id', saved?.client_id ?? DYNAMIC_CLIENT);
    if (!saved) q.set('agent_name_hint', APP_NAME);
    q.set('ext_agent_host_id', hid);
    // id_token_hint is optional; it would sit in the browser's history, so only the email hint goes along
    if (saved?.email) q.set('login_hint', saved.email);
    q.set('response_type', 'code');
    q.set('redirect_uri', redirectUri);
    q.set('scope', SCOPES);
    q.set('resource', cfg.resource);
    q.set('state', state);
    q.set('nonce', nonce);
    q.set('code_challenge_method', 'S256');
    q.set('code_challenge', challenge);
    if (reconsent) q.set('prompt', 'consent');
    attempt(userId, { status: 'pending' });
    return { authorizeUrl: url.toString(), redirectUri, listening, reusing: Boolean(saved) };
  }

  /** The callback (from the 127.0.0.1 listener, the phone, or a pasted address). `userId` set = must be theirs. */
  async function complete(url, userId) {
    need();
    const q = url.searchParams;
    if (q.getAll('state').length !== 1) throw chatgptError.flow('That address is not a ChatGPT sign-in answer. Copy the whole address from the ChatGPT tab.');
    const flow = flows.take('chatgpt', q.get('state'));
    if (!flow || (userId && flow.userId !== userId)) {
      throw chatgptError.flow('This sign-in expired or was already used. Start again with Continue with ChatGPT.');
    }
    const uid = flow.userId;
    try {
      const data = JSON.parse(app.sealer.open(flow.data.sealed, `chatgpt-flow:${uid}`));
      if (`${url.origin}${url.pathname}` !== data.redirectUri) throw chatgptError.flow('That address does not belong to this sign-in. Start again.');
      if (q.has('error')) throw q.get('error') === 'access_denied' ? chatgptError.denied() : chatgptError.flow(`ChatGPT sign-in stopped (${q.get('error').slice(0, 60)}).`);
      const code = q.get('code');
      const returned = q.get('client_id');
      const clientId = returned ?? data.clientId;
      if (
        !code ||
        q.getAll('code').length !== 1 ||
        q.getAll('client_id').length > 1 ||
        !clientId ||
        clientId === DYNAMIC_CLIENT ||
        !CLIENT_ID.test(clientId) ||
        (data.clientId && returned && returned !== data.clientId)
      ) {
        throw chatgptError.flow('ChatGPT did not finish registering Host-Caster. Try signing in again.');
      }
      let row = data.clientId ? store.byClient(uid, data.clientId) : store.register(uid, clientId);
      if (!row) row = store.register(uid, clientId);
      const res = await oidc.token({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: data.verifier,
        redirect_uri: data.redirectUri,
        resource: cfg.resource,
      });
      if (res.status !== 200) {
        app.log.warn({ status: res.status, code: upstreamCode(res.body), requestId: res.requestId }, 'chatgpt code exchange failed');
        throw upstreamCode(res.body) === 'invalid_grant'
          ? chatgptError.flow('That sign-in code expired or was used. Start again with Continue with ChatGPT.')
          : chatgptError.failed('ChatGPT did not accept the sign-in. Try again.');
      }
      if (typeof res.body?.id_token !== 'string') throw chatgptError.failed('ChatGPT did not return a verifiable identity. Try again.');
      const tokens = tokenSet(res.body);
      const who = await oidc.verifyIdToken(res.body.id_token, { clientId, nonce: data.nonce });
      if (row.subject && row.subject !== who.sub) throw chatgptError.mismatch();
      const plan = tokens.scope.split(' ').includes(PLAN_SCOPE);
      // the new account is validated: only now does it replace the active one
      for (const other of store.deactivateOthers(uid, row.id)) await endSession(other);
      store.update(
        row,
        { subject: who.sub, email: who.email ?? null, name: who.name ?? null, scopes: tokens.scope, status: plan ? 'connected' : 'not_enabled', active: 1, paused_until: null, last_error: null },
        tokens,
      );
      attempt(uid, { status: 'done' });
    } catch (err) {
      attempt(uid, { status: 'error', code: err.code ?? 'chatgpt_error', message: err.message });
      throw err;
    }
  }

  /** Revokes the refresh token (best effort), clears the tokens, keeps the registration. true = confirmed. */
  async function endSession(row) {
    const tokens = store.tokens(row);
    const confirmed = tokens?.refreshToken ? await oidc.revoke(tokens.refreshToken, row.client_id) : true;
    store.update(row, { active: 0, status: 'signed_out', paused_until: null, last_error: null }, null);
    return confirmed;
  }

  /** Refresh near expiry; one at a time per registration so a rotating refresh token is never raced. */
  function refresh(row, force = false) {
    const running = refreshing.get(row.id);
    if (running) return running;
    const job = (async () => {
      const current = store.get(row.id);
      const tokens = store.tokens(current);
      if (!current || !tokens?.refreshToken) {
        if (current) store.update(current, { status: 'expired' }, null);
        throw chatgptError.signedOut();
      }
      const now = Date.now();
      if (!force && tokens.expiresAt - now > REFRESH_MARGIN_MS) return tokens;
      if (!force && tokens.earliestRefreshAt && now < tokens.earliestRefreshAt && tokens.expiresAt - now > 30_000) return tokens;
      const res = await oidc.token({ grant_type: 'refresh_token', client_id: current.client_id, refresh_token: tokens.refreshToken, resource: cfg.resource });
      if (res.status !== 200) {
        const code = upstreamCode(res.body);
        app.log.warn({ status: res.status, code, requestId: res.requestId }, 'chatgpt refresh failed');
        if (TERMINAL_REFRESH.has(code) || code === 'invalid_client') {
          store.update(current, { status: 'expired', last_error: code }, null);
          throw chatgptError.signedOut();
        }
        throw chatgptError.unavailable();
      }
      const next = tokenSet(res.body, tokens);
      if (typeof res.body.id_token === 'string') {
        const who = await oidc.verifyIdToken(res.body.id_token, { clientId: current.client_id });
        if (who.sub !== current.subject) {
          store.update(current, { status: 'expired', last_error: 'account_mismatch' }, null);
          throw chatgptError.mismatch();
        }
      }
      const plan = next.scope.split(' ').includes(PLAN_SCOPE);
      store.update(current, { scopes: next.scope, status: plan ? 'connected' : 'not_enabled' }, next);
      return next;
    })();
    refreshing.set(row.id, job);
    job.then(
      () => refreshing.delete(row.id),
      () => refreshing.delete(row.id),
    );
    return job;
  }

  async function session(userId) {
    need();
    const row = store.active(userId);
    if (!row) throw chatgptError.notConnected();
    if (row.status === 'not_enabled') throw chatgptError.notEnabled();
    if (row.status !== 'connected' || !row.tokens_enc) throw chatgptError.signedOut();
    return { row, tokens: await refresh(row) };
  }

  /** Runs `fn(accessToken)`; one forced refresh + retry when ChatGPT says the token is not accepted. */
  async function withToken(userId, fn) {
    let { row, tokens } = await session(userId);
    try {
      return await fn(tokens.accessToken, row);
    } catch (err) {
      if (!err.retryRefresh) throw err;
      tokens = await refresh(row, true);
      return fn(tokens.accessToken, row);
    }
  }

  const logFailure = (err, what) => {
    if (err?.diag) app.log.warn({ ...err.diag, ourCode: err.code }, `chatgpt ${what} failed`);
  };

  async function models(userId) {
    try {
      return await withToken(userId, (token) => listModels(cfg.apiBase, token));
    } catch (err) {
      logFailure(err, 'models');
      throw err;
    }
  }

  /**
   * One break / test line on the user's plan. `force` skips the usage-limit pause (the Test button).
   * @param {{ model: string, system: string, messages: { role: string, content: string }[], json?: boolean, force?: boolean }} req
   */
  async function chat(userId, req) {
    need();
    const active = store.active(userId);
    if (active?.paused_until && active.paused_until > Date.now() && !req.force) throw chatgptError.limit();
    const input = req.messages.map((m) => ({ role: m.role === 'system' ? 'developer' : m.role, content: m.content }));
    if (!input.some((m) => m.role === 'user')) input.push({ role: 'user', content: 'Go ahead.' });
    const body = {
      model: req.model,
      instructions: req.system,
      input,
      // radio lines need no long thinking; dropped if the model does not take it
      reasoning: { effort: 'low' },
      ...(req.json ? { text: { format: { type: 'json_object' } } } : {}),
    };
    try {
      return await withToken(userId, async (token) => {
        for (let i = 0; ; i++) {
          try {
            return await streamResponse(cfg.apiBase, token, body);
          } catch (err) {
            const param = String(err.param ?? '');
            if (err.code === 'chatgpt_unsupported' && i < 2 && body.reasoning && /reasoning/.test(param)) delete body.reasoning;
            else if (err.code === 'chatgpt_unsupported' && i < 2 && body.text && /text|format/.test(param)) delete body.text;
            else throw err;
          }
        }
      });
    } catch (err) {
      logFailure(err, 'response');
      const row = store.active(userId);
      if (row && err.code === 'chatgpt_limit') store.update(row, { paused_until: Date.now() + LIMIT_PAUSE_MS, last_error: err.code });
      else if (row && err.code === 'chatgpt_signed_out' && row.status === 'connected') store.update(row, { last_error: err.code });
      throw err;
    }
  }

  function status(userId) {
    const row = store.saved(userId);
    const a = store.getState(userId, ATTEMPT);
    const connected = Boolean(row?.active && row.status === 'connected' && row.tokens_enc);
    const paused = row?.paused_until && row.paused_until > Date.now() ? row.paused_until : undefined;
    return {
      enabled: cfg.enabled,
      connected,
      status: !row ? 'none' : row.active ? row.status : 'signed_out',
      ...(row?.subject ? { account: { email: row.email ?? undefined, name: row.name ?? undefined } } : {}),
      planUsage: Boolean(row?.active && String(row.scopes).split(' ').includes(PLAN_SCOPE)),
      ...(paused ? { limitedUntil: paused } : {}),
      ...(row?.last_error && row.active ? { lastError: row.last_error } : {}),
      welcome: connected && !store.getState(userId, WELCOMED),
      ...(a ? { attempt: a } : {}),
    };
  }

  async function disconnect(userId) {
    need();
    const row = store.active(userId);
    if (!row) return { revoked: true };
    return { revoked: await endSession(row) };
  }

  /** Account deletion: end every renewable session first (best effort). */
  async function forgetUser(userId) {
    for (const row of store.all(userId)) if (row.tokens_enc) await endSession(row).catch(() => false);
  }

  return {
    hostId: host,
    start,
    complete,
    status,
    disconnect,
    models,
    chat,
    forgetUser,
    welcomed: (userId) => store.setState(userId, WELCOMED, true),
    clearAttempt: (userId) => store.setState(userId, ATTEMPT, { status: 'idle' }),
    close: () => loopback.close(),
  };
}
