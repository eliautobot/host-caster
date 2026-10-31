// GET /auth/:provider/start and /auth/:provider/callback for Google and X (web cookie or native deep link).
import { HttpError } from '../errors.js';
import { appChallengeOf, bindBrowser, browserMatches } from './binding.js';
import { putFlow, pkcePair, takeFlow } from './flows.js';
import { PROVIDERS, parseScopeList, shortGoogleScopes } from './providers.js';
import { createSession, setSessionCookie } from './session.js';
import { createUser, findIdentity, findUserByEmail, getIdentity, getUser, upsertIdentity } from './users.js';

/** Only in-app hash routes are allowed as return targets ("/settings/account"). */
function safeReturn(value, fallback) {
  const v = String(value ?? '');
  return /^\/[A-Za-z0-9/_?=&.-]*$/.test(v) && !v.startsWith('//') ? v : fallback;
}

export const sealTokens = (app, provider, subject, tokens) =>
  app.sealer.seal(JSON.stringify(tokens), `identity:${provider}:${subject}`);

export function openTokens(app, identity) {
  if (!identity?.tokens_enc) return undefined;
  try {
    return JSON.parse(app.sealer.open(identity.tokens_enc, `identity:${identity.provider}:${identity.subject}`));
  } catch {
    return undefined;
  }
}

function withQuery(base, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
  return q ? `${base}${base.includes('?') ? '&' : '?'}${q}` : base;
}

function appRedirect(app, params) {
  return withQuery(`${app.config.appScheme}://auth`, params);
}

function webRedirect(app, route, params = {}) {
  return `${app.config.publicUrl}/#${withQuery(route, params)}`;
}

export async function oauthRoutes(app) {
  app.get('/auth/:provider/start', async (req, reply) => {
    const provider = PROVIDERS[req.params.provider];
    if (!provider) throw new HttpError(404, 'not_found', 'Unknown sign-in provider');
    const q = req.query ?? {};
    const isApp = q.app === '1' || q.app === 'true';
    if (!provider.enabled(app.config)) {
      const error = 'provider_disabled';
      return reply.redirect(isApp ? appRedirect(app, { error }) : webRedirect(app, '/sign-in', { error }));
    }
    // the app proves at /api/auth/exchange that it started this sign-in (an app without it is too old)
    const appChallenge = isApp ? appChallengeOf(q) : undefined;
    if (isApp && !appChallenge) return reply.redirect(appRedirect(app, { error: 'app_outdated' }));

    // Linking (or adding Google scopes) to an existing account: a link ticket (native) or the cookie session (web).
    let linkUserId;
    let viaTicket = false;
    if (q.link && q.link !== '1') {
      // a ticket names an account but anyone could open its URL, so only the app that holds the verifier finishes
      // the link (/api/auth/link/finish): web pages cannot use tickets
      const ticket = isApp ? takeFlow(app.db, 'link', String(q.link)) : undefined;
      if (!ticket) {
        const error = 'link_expired';
        return reply.redirect(isApp ? appRedirect(app, { error }) : webRedirect(app, '/settings/account', { error }));
      }
      linkUserId = ticket.userId;
      viaTicket = true;
    } else if (req.user && (q.link === '1' || q.scopes)) {
      linkUserId = req.user.id;
    }

    const extra = provider.id === 'google' ? parseScopeList(q.scopes) : [];
    let loginHint;
    if (linkUserId && provider.id === 'google') {
      const existing = getIdentity(app.db, linkUserId, 'google');
      if (existing) loginHint = JSON.parse(existing.profile || '{}').email;
    }
    const { verifier, challenge } = pkcePair();
    const state = putFlow(app.db, 'oauth', {
      provider: provider.id,
      userId: linkUserId ?? null,
      data: {
        verifier,
        app: isApp,
        appChallenge,
        viaTicket,
        bind: bindBrowser(app, req, reply),
        extra,
        returnTo: safeReturn(q.return, linkUserId ? '/settings/account' : '/'),
      },
    });
    return reply.redirect(provider.authUrl(app.config, { state, challenge, extra, loginHint }));
  });

  app.get('/auth/:provider/callback', async (req, reply) => {
    const provider = PROVIDERS[req.params.provider];
    if (!provider) throw new HttpError(404, 'not_found', 'Unknown sign-in provider');
    const q = req.query ?? {};
    const flow = takeFlow(app.db, 'oauth', String(q.state ?? ''));
    if (!flow || flow.provider !== provider.id) {
      return reply.redirect(webRedirect(app, '/sign-in', { error: 'state_invalid' }));
    }
    const { data } = flow;
    const fail = (error) =>
      reply.redirect(data.app ? appRedirect(app, { error }) : webRedirect(app, flow.userId ? data.returnTo : '/sign-in', { error }));
    // the browser that started the sign-in must be the one finishing it
    if (!browserMatches(app, req, data.bind)) return fail('state_invalid');
    if (q.error) return fail(q.error === 'access_denied' ? 'access_denied' : 'provider_error');
    if (!q.code) return fail('missing_code');

    let tokens;
    let who;
    try {
      tokens = await provider.exchange(app.config, { code: String(q.code), verifier: data.verifier });
      who = await provider.profile(app.config, tokens);
    } catch (err) {
      req.log.warn({ err: err.message, provider: provider.id }, 'oauth callback failed');
      return fail(err.code ?? 'provider_error');
    }

    const existing = findIdentity(app.db, provider.id, who.subject);
    const prevTokens = existing ? openTokens(app, existing) : undefined;
    // Google sends a refresh token only on consent; keep the old one when a later sign-in omits it.
    const merged = { ...tokens, refresh_token: tokens.refresh_token ?? prevTokens?.refresh_token };
    const scopes = provider.id === 'google' ? shortGoogleScopes(tokens.scope).join(' ') : 'users.read tweet.read';

    let userId;
    if (flow.userId) {
      if (!getUser(app.db, flow.userId)) return fail('account_gone');
      if (existing && existing.user_id !== flow.userId) return fail('identity_in_use');
      if (data.viaTicket) {
        // the app finishes the link with its bearer session and verifier (see binding.js)
        const linkcode = putFlow(app.db, 'linkfinish', {
          provider: provider.id,
          userId: flow.userId,
          data: {
            challenge: data.appChallenge,
            subject: who.subject,
            scopes,
            tokensEnc: sealTokens(app, provider.id, who.subject, merged),
            profile: who.profile,
            avatarUrl: who.avatarUrl ?? null,
          },
        });
        return reply.redirect(appRedirect(app, { linkcode, provider: provider.id }));
      }
      userId = flow.userId;
    } else if (existing) {
      userId = existing.user_id;
    } else {
      // Online edition: every stored email is verified (codes, Google, Apple), so a Google sign-in with the same
      // verified email joins that account. Self-hosted: never merge by email (a local account's email is unverified).
      const online = app.config.online.enabled;
      const sameEmail = online && who.email ? findUserByEmail(app.db, who.email) : undefined;
      if (sameEmail?.email_verified_at) userId = sameEmail.id;
      else {
        if (!app.config.allowSignups) return fail('signups_closed');
        const emailFree = who.email && !findUserByEmail(app.db, who.email);
        userId = createUser(app.db, { name: who.name, email: emailFree ? who.email : null, avatarUrl: who.avatarUrl ?? null }).id;
        // Google only gives the email when it is verified
        if (online && emailFree) app.db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(Date.now(), userId);
      }
    }
    upsertIdentity(app.db, {
      userId,
      provider: provider.id,
      subject: who.subject,
      scopes,
      tokensEnc: sealTokens(app, provider.id, who.subject, merged),
      profile: who.profile,
    });
    const user = getUser(app.db, userId);
    if (!user.avatar_url && who.avatarUrl) app.db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(who.avatarUrl, userId);

    const linked = Boolean(flow.userId);
    if (data.app) {
      if (linked) return reply.redirect(appRedirect(app, { linked: provider.id }));
      const code = putFlow(app.db, 'exchange', { provider: provider.id, userId, data: { challenge: data.appChallenge } });
      return reply.redirect(appRedirect(app, { code }));
    }
    if (!linked || !req.user || req.user.id !== userId) {
      const { token } = createSession(app, userId, 'web', req.headers['user-agent']);
      setSessionCookie(app, reply, token);
    }
    return reply.redirect(webRedirect(app, data.returnTo, linked ? { linked: provider.id } : { signedIn: provider.id }));
  });
}
