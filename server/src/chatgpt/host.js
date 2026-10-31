// The agent host id Sign in with ChatGPT asks for: one stable, opaque id per Host-Caster server install (the server is
// the host every signed-in user's ChatGPT plan requests run on). RFC 9278 JWK thumbprint URI of an Ed25519 public
// key made once and kept in DATA_DIR, persisted before the first authorization URL is built. Never user data.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'chatgpt-host.json';
const HOST_ID = /^(urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}|urn:uuid:[0-9a-f-]{36}|did:key:z[1-9A-HJ-NP-Za-km-z]+)$/;

/** RFC 7638 thumbprint of an OKP public JWK (required members crv, kty, x in lexicographic order). */
export function jwkThumbprintUri(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${createHash('sha256').update(canonical).digest('base64url')}`;
}

export const isHostId = (value) => HOST_ID.test(String(value ?? ''));

/** Reads DATA_DIR/chatgpt-host.json, creating it (0600, atomic) the first time. */
export function loadHostId(dataDir) {
  const file = join(dataDir, FILE);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (isHostId(saved?.hostId)) return saved.hostId;
    throw new Error(`${file} has no valid hostId; move it away to make a new one`);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const record = {
    hostId: jwkThumbprintUri(jwk),
    publicJwk: jwk,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    createdAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
  return record.hostId;
}
