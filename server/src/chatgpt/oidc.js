// OpenAI's OpenID Connect side of Sign in with ChatGPT: discovery, the JWKS, ID token checks, token and revocation
// requests. node:crypto only (no JOSE dependency). Endpoints come from the issuer's discovery document.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { HttpError } from '../errors.js';
import { chatgptError } from './errors.js';

const DISCOVERY_TTL = 60 * 60 * 1000;
const CLOCK_SKEW_S = 5;

async function getJson(url, init = {}, timeoutMs = 15000) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw chatgptError.unavailable();
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, requestId: res.headers.get('x-request-id') ?? res.headers.get('openai-request-id') ?? undefined };
}

/** One client per server: cached discovery + keys. */
export function createOidc(issuer) {
  let discovery;
  let discoveredAt = 0;
  let keys;

  async function config() {
    if (discovery && Date.now() - discoveredAt < DISCOVERY_TTL) return discovery;
    const res = await getJson(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    const d = res.body;
    if (res.status !== 200 || !d || d.issuer !== issuer || !d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
      throw chatgptError.unavailable();
    }
    discovery = d;
    discoveredAt = Date.now();
    return d;
  }

  async function loadKeys(force = false) {
    if (keys && !force) return keys;
    const d = await config();
    const res = await getJson(d.jwks_uri, { headers: { accept: 'application/json' } });
    if (res.status !== 200 || !Array.isArray(res.body?.keys)) throw chatgptError.unavailable();
    keys = res.body.keys;
    return keys;
  }

  async function keyFor(kid) {
    let key = (await loadKeys()).find((k) => k.kid === kid);
    // an unfamiliar kid: the issuer may have rotated its keys
    if (!key) key = (await loadKeys(true)).find((k) => k.kid === kid);
    return key;
  }

  /**
   * Verifies an ID token's signature (RS256 or ES256 from the JWKS) and claims.
   * @param {string} idToken
   * @param {{ clientId: string, nonce?: string }} expect
   * @returns {Promise<{ sub: string, email?: string, name?: string }>}
   */
  async function verifyIdToken(idToken, { clientId, nonce }) {
    const bad = () => new HttpError(400, 'chatgpt_identity', 'The ChatGPT identity could not be verified. Please sign in again.');
    const parts = String(idToken ?? '').split('.');
    if (parts.length !== 3) throw bad();
    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw bad();
    }
    if (!['RS256', 'ES256'].includes(header?.alg) || typeof header.kid !== 'string') throw bad();
    const jwk = await keyFor(header.kid);
    if (!jwk) throw bad();
    let ok = false;
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      const data = Buffer.from(`${parts[0]}.${parts[1]}`);
      const sig = Buffer.from(parts[2], 'base64url');
      ok =
        header.alg === 'RS256'
          ? verifySignature('sha256', data, key, sig)
          : verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch {
      ok = false;
    }
    if (!ok) throw bad();
    const d = await config();
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      payload.iss !== d.issuer ||
      !aud.includes(clientId) ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (aud.length > 1 && payload.azp !== clientId) ||
      typeof payload.exp !== 'number' ||
      payload.exp + CLOCK_SKEW_S < now ||
      typeof payload.iat !== 'number' ||
      payload.iat - CLOCK_SKEW_S > now ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce)
    ) {
      throw bad();
    }
    return {
      sub: payload.sub,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    };
  }

  /** Form POST to the token endpoint. Returns { status, body, requestId }. */
  async function token(fields) {
    const d = await config();
    return getJson(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /** Ends the renewable session. true = confirmed (HTTP 200), false = not confirmed after a retry. */
  async function revoke(refreshToken, clientId) {
    let d;
    try {
      d = await config();
    } catch {
      return false;
    }
    if (!d.revocation_endpoint) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(d.revocation_endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 200) return true;
        if (res.status < 500) return false;
      } catch {
        // network trouble: retry with backoff
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
    return false;
  }

  return { config, verifyIdToken, token, revoke };
}
