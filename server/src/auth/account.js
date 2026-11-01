// Local accounts, native code exchange, /api/me, link/unlink and account deletion.
import { HttpError } from '../errors.js';
import { forgetNotion } from '../integrations/notion/routes.js';
import { verifierMatches } from './binding.js';
import { putFlow, takeFlow } from './flows.js';
import { openTokens } from './oauth.js';
import { hashPassword, rateLimiter, verifyPassword } from './password.js';
import { PROVIDERS } from './providers.js';
import {
  clearSessionCookie,
  createSession,
  deleteSessionByToken,
  requireUser,
  sessionInfo,
  setSessionCookie,
} from './session.js';
import {
  createUser,
  deleteIdentity,
  deleteUser,
  findIdentity,
  findUserByEmail,
  getUser,
  listIdentities,
  toApiUser,
  updateUser,
  upsertIdentity,
} from './users.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function credentials(body) {
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address');
  if (password.length < 8) throw new HttpError(400, 'weak_password', 'Use at least 8 characters');
  if (password.length > 512) throw new HttpError(400, 'weak_password', 'That password is too long');
  return { email, password };
}

/** Starts a session for the user: cookie for web, bearer token for the app (body.app = true). */
function issue(app, req, reply, user, asApp) {
  const kind = asApp ? 'app' : 'web';
  const { token } = createSession(app, user.id, kind, req.headers['user-agent']);
  if (!asApp) setSessionCookie(app, reply, token);
  return { user: toApiUser(app.db, user), kind, ...(asApp ? { token } : {}) };
}

export async function accountRoutes(app) {
  const limiter = rateLimiter(10, 10 * 60 * 1000);
  const localOn = () => {
    if (!app.config.allowLocalAccounts) throw new HttpError(403, 'local_disabled', 'Local accounts are off on this server');
  };

  app.post('/api/auth/local/signup', async (req, reply) => {
    localOn();
    if (!app.config.allowSignups) throw new HttpError(403, 'signups_closed', 'This server is not taking new accounts');
    const { email, password } = credentials(req.body);
    if (!limiter.hit(`signup:${req.ip}`)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.');
    if (findUserByEmail(app.db, email)) throw new HttpError(409, 'email_taken', 'An account with that email exists. Sign in instead.');
    const name = String(req.body?.name ?? '').trim().slice(0, 80) || email.split('@')[0];
    const user = createUser(app.db, { name, email, passwordHash: await hashPassword(password) });
    return reply.status(201).send(issue(app, req, reply, user, req.body?.app === true));
  });

  app.post('/api/auth/local/login', async (req, reply) => {
    localOn();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const key = `login:${req.ip}:${email}`;
    if (!limiter.hit(key)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
    const user = email ? findUserByEmail(app.db, email) : undefined;
    const ok = await verifyPassword(password, user?.password_hash);
    if (!user || !ok) throw new HttpError(401, 'bad_credentials', 'Wrong email or password');
    limiter.reset(key);
    return issue(app, req, reply, user, req.body?.app === true);
  });

  // Native: the one-time code from hostcaster://auth?code=... becomes a bearer token.
  app.post('/api/auth/exchange', async (req) => {
    const flow = takeFlow(app.db, 'exchange', String(req.body?.code ?? ''));
    // only the app that started the sign-in holds the verifier (another app that caught the deep link does not)
    const user = flow && verifierMatches(flow.data.challenge, req.body?.verifier) && getUser(app.db, flow.userId);
    if (!user) throw new HttpError(400, 'code_invalid', 'That sign-in link expired. Try again.');
    const { token } = createSession(app, user.id, 'app', req.headers['user-agent']);
    return { user: toApiUser(app.db, user), kind: 'app', token };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth?.token) deleteSessionByToken(app, req.auth.token);
    clearSessionCookie(app, reply);
    return reply.status(204).send();
  });

  // Native linking, last step: the code from hostcaster://auth?linkcode= plus the verifier only this app holds, with
  // this account's bearer session. Anyone else who opened the ticket's URL cannot finish it.
  app.post('/api/auth/link/finish', async (req) => {
    const user = requireUser(req);
    const flow = takeFlow(app.db, 'linkfinish', String(req.body?.code ?? ''));
    if (!flow || flow.userId !== user.id || !verifierMatches(flow.data.challenge, req.body?.verifier)) {
      throw new HttpError(400, 'code_invalid', 'That link expired. Try again.');
    }
    const { subject, scopes, tokensEnc, profile, avatarUrl } = flow.data;
    const existing = findIdentity(app.db, flow.provider, subject);
    if (existing && existing.user_id !== user.id) {
      throw new HttpError(409, 'identity_in_use', 'That account is already linked to another Host-Caster account.');
    }
    upsertIdentity(app.db, { userId: user.id, provider: flow.provider, subject, scopes, tokensEnc, profile });
    if (!user.avatar_url && avatarUrl) app.db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, user.id);
    return { user: toApiUser(app.db, getUser(app.db, user.id)), linked: flow.provider };
  });

  // A ticket lets the system browser (native) link a provider or add Google scopes to this account.
  app.post('/api/auth/link-ticket', async (req) => {
    const user = requireUser(req);
    return { ticket: putFlow(app.db, 'link', { userId: user.id }) };
  });

  app.get('/api/me', async (req) => {
    const user = requireUser(req);
    return { user: { ...toApiUser(app.db, user), ...app.onlineHooks?.meExtras(user) }, ...sessionInfo(req) };
  });

  app.patch('/api/me', async (req) => {
    const user = requireUser(req);
    const name = req.body?.name;
    if (name !== undefined && (typeof name !== 'string' || name.length > 80)) {
      throw new HttpError(400, 'invalid_request', 'Name must be up to 80 characters');
    }
    return { user: toApiUser(app.db, updateUser(app.db, user.id, { name: name?.trim() })) };
  });

  // Add (or change) a password so the account can also sign in locally.
  app.put('/api/me/password', async (req) => {
    localOn();
    const user = requireUser(req);
    const email = user.email ?? req.body?.email;
    const { password } = credentials({ email, password: req.body?.password });
    if (user.password_hash && !(await verifyPassword(String(req.body?.current ?? ''), user.password_hash))) {
      throw new HttpError(401, 'bad_credentials', 'Your current password is wrong');
    }
    if (!user.email) {
      const taken = findUserByEmail(app.db, email);
      if (taken && taken.id !== user.id) throw new HttpError(409, 'email_taken', 'That email is used by another account');
    }
    const next = updateUser(app.db, user.id, { passwordHash: await hashPassword(password), email: user.email ?? String(email).toLowerCase() });
    return { user: toApiUser(app.db, next) };
  });

  app.delete('/api/me/identities/:provider', async (req) => {
    const user = requireUser(req);
    const provider = req.params.provider;
    const identities = listIdentities(app.db, user.id);
    const ways = identities.length + (user.password_hash ? 1 : 0);
    const has = provider === 'local' ? Boolean(user.password_hash) : identities.some((i) => i.provider === provider);
    if (!has) throw new HttpError(404, 'not_linked', 'That sign-in is not linked');
    if (ways <= 1) throw new HttpError(409, 'last_sign_in', 'This is your only way to sign in. Link another one first.');
    if (provider === 'local') {
      app.db.prepare('UPDATE users SET password_hash = NULL, updated_at = ? WHERE id = ?').run(Date.now(), user.id);
    } else {
      const identity = identities.find((i) => i.provider === provider);
      await PROVIDERS[provider]?.revoke(app.config, openTokens(app, identity));
      deleteIdentity(app.db, user.id, provider);
    }
    return { user: toApiUser(app.db, getUser(app.db, user.id)) };
  });

  // Sign out every device (keeps the current session when keepThis = true).
  app.delete('/api/me/sessions', async (req) => {
    const user = requireUser(req);
    if (req.body?.keepThis && req.auth?.sessionId) {
      app.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(user.id, req.auth.sessionId);
    } else {
      app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    }
    return { ok: true };
  });

  // Delete the account and everything stored for it (cascades), revoking provider tokens first.
  app.delete('/api/me', async (req, reply) => {
    const user = requireUser(req);
    // online edition: the subscription is cancelled first; if that fails nothing is deleted
    await app.onlineHooks?.beforeDeleteUser(user, listIdentities(app.db, user.id));
    for (const identity of listIdentities(app.db, user.id)) {
      await PROVIDERS[identity.provider]?.revoke(app.config, openTokens(app, identity));
    }
    await app.chatgpt.forgetUser(user.id);
    await forgetNotion(app, user.id);
    deleteUser(app.db, user.id);
    clearSessionCookie(app, reply);
    return reply.status(204).send();
  });
}
