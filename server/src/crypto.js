// Secrets at rest: AES-256-GCM with SECRET_KEY. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

/**
 * @param {Buffer} key 32 bytes
 * @param {string} plaintext
 * @param {string} [aad] binds the ciphertext to a context (e.g. `${userId}:${ref}`)
 */
export function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Reverses seal(); throws when the value was tampered with or the key/aad differ. */
export function open(key, sealed, aad) {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error('not a sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Bound helpers so routes never handle the raw key. */
export function createSealer(key) {
  return {
    seal: (plaintext, aad) => seal(key, plaintext, aad),
    open: (sealed, aad) => open(key, sealed, aad),
  };
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Purpose-specific subkey (cookie signing, CSRF ...) derived from SECRET_KEY. */
export const deriveKey = (key, purpose) => createHmac('sha256', key).update(`hostcaster:${purpose}`).digest();

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
