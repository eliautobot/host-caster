// ChatGPT plan errors as the client sees them. Every code starts with chatgpt_ so the app can tell them apart (and
// never 401: that means "not signed in to Host-Caster"). OpenAI's own code, status and request id go to the log.
import { HttpError } from '../errors.js';

export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

const RECONNECT = 'Open Settings, Brains and use Continue with ChatGPT to connect again.';

export const chatgptError = {
  off: () => new HttpError(404, 'chatgpt_off', 'ChatGPT plan brains are turned off on this Host-Caster server'),
  notConnected: () => new HttpError(409, 'chatgpt_not_connected', `Your ChatGPT account is not connected. ${RECONNECT}`),
  signedOut: () => new HttpError(409, 'chatgpt_signed_out', `Your ChatGPT sign-in expired or was removed. ${RECONNECT}`),
  notEnabled: () =>
    new HttpError(403, 'chatgpt_not_enabled', 'ChatGPT plan use is off for Host-Caster. Turn it on in Settings, Brains, or use an API key brain.'),
  notEligible: () =>
    new HttpError(403, 'chatgpt_not_eligible', 'This ChatGPT account or workspace cannot use its plan in other apps. Use an API key brain instead.'),
  limit: () =>
    new HttpError(429, 'chatgpt_limit', "ChatGPT usage limit reached. Review your plan or this app's limit in ChatGPT settings."),
  unavailable: () => new HttpError(503, 'chatgpt_unavailable', 'ChatGPT is not available right now. Host-Caster will try again later.'),
  unsupported: (param) =>
    Object.assign(new HttpError(400, 'chatgpt_unsupported', `ChatGPT plan use does not support this request${param ? ` (${param})` : ''}.`), { param }),
  model: () => new HttpError(400, 'chatgpt_model', 'This model is not available for your ChatGPT account. Pick another model.'),
  denied: () => new HttpError(400, 'chatgpt_denied', 'ChatGPT sign-in was not completed. Try again when you are ready.'),
  flow: (msg) => new HttpError(400, 'chatgpt_flow', msg),
  mismatch: () =>
    new HttpError(409, 'chatgpt_account_mismatch', 'That is a different ChatGPT account. Sign in with the account you connected before, or use a different account.'),
  failed: (msg = 'ChatGPT did not complete the request. Try again.') => new HttpError(502, 'chatgpt_error', msg),
};

/** Refresh answers that mean the session is over (sign in again). */
export const TERMINAL_REFRESH = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/** Reads OpenAI's error code from the shapes it uses: { error: { code } }, { error: "code" }, { code }, { detail }. */
export function upstreamCode(body) {
  if (!body || typeof body !== 'object') return undefined;
  const e = body.error;
  const code = typeof e === 'string' ? e : (e?.code ?? e?.type ?? body.code);
  return typeof code === 'string' ? code.replace(/^subscription_sharing_v2_/, 'subscription_sharing_') : undefined;
}

export const upstreamParam = (body) => (typeof body?.error?.param === 'string' ? body.error.param : undefined);

export const bodyShape = (body) =>
  body && typeof body === 'object' ? `{${Object.keys(body).slice(0, 6).join(',')}}` : typeof body;

/**
 * Responses-layer or admission failure -> our error. `status` is the HTTP status (0 for an in-stream event).
 * @returns {HttpError & { retryRefresh?: boolean }}
 */
export function responsesError(status, body) {
  const code = upstreamCode(body);
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return chatgptError.limit();
    case 'subscription_sharing_user_not_eligible':
      return chatgptError.notEligible();
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return chatgptError.unavailable();
    case 'subscription_sharing_unsupported_capability':
      return chatgptError.unsupported(upstreamParam(body));
    case 'subscription_sharing_route_not_supported':
      return chatgptError.failed('ChatGPT plan use does not support this request route.');
    case 'subscription_sharing_invalid_user':
      return Object.assign(chatgptError.signedOut(), { retryRefresh: true });
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return chatgptError.notEnabled();
    case 'model_not_found':
      return chatgptError.model();
    default:
      break;
  }
  if (status === 401) return Object.assign(chatgptError.signedOut(), { retryRefresh: true });
  if (status === 403) return chatgptError.failed('ChatGPT refused the request (a policy or region check). Use an API key brain for now.');
  if (status === 429 || status === 503 || status === 502 || status === 504) return chatgptError.unavailable();
  return chatgptError.failed();
}
