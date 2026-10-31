// Local account passwords: scrypt (N=2^15, r=8, p=1), stored as scrypt$N$r$p$salt$hash (base64url).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLen: 32 };
const maxmem = 64 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFKC'), salt, PARAMS.keyLen, { ...PARAMS, maxmem });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // same work for unknown users so timing does not reveal which emails exist
    await scrypt('x', 'hostcaster-dummy-salt', PARAMS.keyLen, { ...PARAMS, maxmem });
    return false;
  }
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Tiny in-memory limiter: max `limit` hits per key per window. */
export function rateLimiter(limit = 10, windowMs = 10 * 60 * 1000) {
  const hits = new Map();
  return {
    hit(key) {
      const t = Date.now();
      const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      arr.push(t);
      hits.set(key, arr);
      if (hits.size > 5000) hits.delete(hits.keys().next().value);
      return arr.length <= limit;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
