// Server config from env (and .env). See ARCHITECTURE.md "Server" and docs/SELF-HOSTING.md.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The hosted service's code (src/online) is not part of every copy (the public source leaves it out). */
export const HAS_ONLINE_EDITION = existsSync(new URL('./online/index.js', import.meta.url));

/** Without src/online every install is self-hosted. */
function selfHostedOnly(env) {
  if (String(env.HOSTCASTER_EDITION ?? 'selfhosted').trim().toLowerCase() === 'online') {
    throw new Error('HOSTCASTER_EDITION=online: this copy of Host-Caster has no online edition (self-hosted only)');
  }
  return Object.freeze({ enabled: false });
}

const { onlineConfig } = HAS_ONLINE_EDITION ? await import('./online/config.js') : { onlineConfig: selfHostedOnly };

export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8')).version;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** "400,1200": the pauses before the 2nd and 3rd try of an action Google did not answer */
function backoffFrom(value) {
  const ms = list(value).map(Number);
  return ms.length === 2 && ms.every((n) => Number.isFinite(n) && n >= 0) ? ms : [400, 1200];
}

const list = (value) =>
  String(value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const trimSlash = (url) => String(url).replace(/\/+$/, '');

/**
 * TRUST_PROXY: which proxies may set X-Forwarded-For (the client address rate limits use). A number = that many hops
 * (a hosting proxy that appends the real address is one hop, and keeps whatever the client sent before it), true/false, or
 * addresses/CIDRs/names (loopback, linklocal, uniquelocal). Default: 1 hop online, local proxies self-hosted.
 */
export function trustProxyFrom(value, online) {
  const v = String(value ?? '').trim();
  if (!v) return online ? 1 : 'loopback,linklocal,uniquelocal';
  if (/^\d+$/.test(v)) return Number(v);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

/**
 * Loads KEY=value pairs from a .env file into process.env (existing vars win): the given path, else .env in the
 * working directory, else .env at the repo root (where .env.example lives).
 */
export function loadEnvFile(path) {
  const candidates = path ? [path] : [resolve('.env'), join(SERVER_DIR, '..', '.env')];
  const found = candidates.find((p) => existsSync(p));
  if (found) process.loadEnvFile(found);
  return found;
}

/** MUSIC_DIR -> absolute path; a folder that does not exist turns the server library off (with a warning). */
function musicDirFrom(value) {
  if (!value) return undefined;
  const dir = resolve(value);
  if (existsSync(dir)) return dir;
  console.warn(`[hostcaster] MUSIC_DIR ${dir} does not exist; the server music library is off`);
  return undefined;
}

/** 32-byte key: SECRET_KEY (base64) or DATA_DIR/secret.key, generated on first start. */
export function loadSecretKey(value, dataDir) {
  const parse = (b64, from) => {
    const key = Buffer.from(b64.trim(), 'base64');
    if (key.length !== 32) throw new Error(`${from} must be 32 bytes, base64 encoded`);
    return key;
  };
  if (value) return parse(value, 'SECRET_KEY');
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return parse(readFileSync(file, 'utf8'), file);
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

/**
 * Provider endpoints. Real defaults; every URL can be overridden by env so tests can run a fake OAuth server.
 * These are operator-declared (trusted) endpoints and do not go through the private-address guard.
 */
function providerUrls(env) {
  return {
    google: {
      authUrl: env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      revokeUrl: env.GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
      userinfoUrl: env.GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo',
      apiBase: trimSlash(env.GOOGLE_API_BASE ?? 'https://www.googleapis.com'),
    },
    x: {
      authUrl: env.X_AUTH_URL ?? 'https://x.com/i/oauth2/authorize',
      tokenUrl: env.X_TOKEN_URL ?? 'https://api.x.com/2/oauth2/token',
      revokeUrl: env.X_REVOKE_URL ?? 'https://api.x.com/2/oauth2/revoke',
      apiBase: trimSlash(env.X_API_BASE ?? 'https://api.x.com'),
    },
    elevenlabsBase: trimSlash(env.ELEVENLABS_API_BASE ?? 'https://api.elevenlabs.io'),
    // Notion connection (hosts read the pages a user shares and add notes when asked). OAuth and API share one base.
    notion: {
      authUrl: env.NOTION_AUTH_URL ?? 'https://api.notion.com/v1/oauth/authorize',
      apiBase: trimSlash(env.NOTION_API_BASE ?? 'https://api.notion.com'),
    },
    // Sign in with ChatGPT (ChatGPT plan usage for open-source apps). The resource stays the public API audience.
    chatgpt: {
      issuer: trimSlash(env.CHATGPT_ISSUER ?? 'https://auth.openai.com'),
      apiBase: trimSlash(env.CHATGPT_API_BASE ?? 'https://api.openai.com/v1'),
      resource: env.CHATGPT_RESOURCE ?? 'https://api.openai.com/v1',
    },
  };
}

/**
 * @param {Record<string, string | undefined>} env
 */
/**
 * Web search for the hosts. Online: Host-Caster AI's own (OpenRouter, metered per user). Self-hosted: the operator's
 * SearXNG (SEARXNG_URL), Brave Search (BRAVE_SEARCH_API_KEY) or Tavily (TAVILY_API_KEY); WEB_SEARCH_PROVIDER picks one
 * when several are set; none = the hosts are simply not offered web search.
 */
export function webSearchFrom(env, online) {
  if (online) return Object.freeze({ provider: 'hostcaster' });
  const searxngUrl = trimSlash(env.SEARXNG_URL ?? '');
  const braveKey = env.BRAVE_SEARCH_API_KEY ?? '';
  const tavilyKey = env.TAVILY_API_KEY ?? '';
  const have = { searxng: Boolean(searxngUrl), brave: Boolean(braveKey), tavily: Boolean(tavilyKey) };
  const wanted = String(env.WEB_SEARCH_PROVIDER ?? '').trim().toLowerCase();
  const provider = wanted === 'off' ? '' : have[wanted] ? wanted : ['searxng', 'brave', 'tavily'].find((p) => have[p]) ?? '';
  return Object.freeze({ provider, searxngUrl, braveKey, tavilyKey });
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 8660);
  const dataDir = resolve(env.DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });

  const urls = providerUrls(env);
  const google = { clientId: env.GOOGLE_CLIENT_ID ?? '', clientSecret: env.GOOGLE_CLIENT_SECRET ?? '' };
  const x = { clientId: env.X_CLIENT_ID ?? '', clientSecret: env.X_CLIENT_SECRET ?? '' };
  const googleOn = Boolean(google.clientId && google.clientSecret);
  const xOn = Boolean(x.clientId && x.clientSecret);
  const publicUrl = trimSlash(env.PUBLIC_URL ?? `http://localhost:${port}`);
  // HOSTCASTER_EDITION=online: the hosted service (accounts, plans, included AI). Its rules override a few self-hosted
  // settings below; with the default (selfhosted) every value is exactly what it was.
  const online = onlineConfig(env, { dataDir, publicUrl });
  if (online.enabled && !publicUrl.startsWith('https://') && !online.allowHttp) {
    throw new Error('The online edition needs an https PUBLIC_URL (ONLINE_ALLOW_HTTP=1 for a local lab)');
  }

  return Object.freeze({
    version: VERSION,
    edition: online.enabled ? 'online' : 'selfhosted',
    online,
    port,
    host: env.HOST ?? '0.0.0.0',
    trustProxy: trustProxyFrom(env.TRUST_PROXY, online.enabled),
    publicUrl,
    /** Secure cookies when the public URL is https (or forced with COOKIE_SECURE). */
    cookieSecure: bool(env.COOKIE_SECURE, publicUrl.startsWith('https://')),
    dataDir,
    dbFile: join(dataDir, 'hostcaster.db'),
    secretKey: loadSecretKey(env.SECRET_KEY, dataDir),
    google: Object.freeze({ ...google, ...urls.google, enabled: googleOn }),
    x: Object.freeze({ ...x, ...urls.x, enabled: xOn }),
    elevenlabsBase: urls.elevenlabsBase,
    /** Notion: each user connects their own workspace through the server owner's public Notion connection */
    notion: Object.freeze({
      ...urls.notion,
      clientId: env.NOTION_CLIENT_ID ?? '',
      clientSecret: env.NOTION_CLIENT_SECRET ?? '',
      enabled: Boolean(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET),
      version: env.NOTION_VERSION ?? '2026-03-11',
    }),
    /** "Use your ChatGPT plan" brains: each user signs in with their own ChatGPT account (no keys to configure) */
    chatgpt: Object.freeze({
      ...urls.chatgpt,
      enabled: online.enabled ? online.chatgptPlan : bool(env.CHATGPT_PLAN, true),
      /** the 127.0.0.1 port in the sign-in callback address; 0 = any free port */
      callbackPort: Number(env.CHATGPT_CALLBACK_PORT ?? 1455),
      /** where the callback listener binds (0.0.0.0 inside Docker with the port published on 127.0.0.1) */
      callbackBind: env.CHATGPT_CALLBACK_BIND ?? '127.0.0.1',
    }),
    /** local password accounts; on by default only when no OAuth provider is configured (online: verified emails only) */
    allowLocalAccounts: online.enabled ? false : bool(env.ALLOW_LOCAL_ACCOUNTS, !googleOn && !xOn),
    /** stop new accounts (existing users can still sign in) */
    allowSignups: bool(env.ALLOW_SIGNUPS, true),
    sessionDays: Number(env.SESSION_DAYS ?? 60),
    /** synced songs, playlist lists and unplayable marks per account (tombstones not counted) */
    syncMaxItems: Math.max(100, Number(env.SYNC_MAX_ITEMS ?? 50000) || 50000),
    /** past versions of each account's synced doc kept for a restore (sealed, the oldest pruned) */
    syncDocRevisions: Math.max(1, Math.floor(Number(env.SYNC_DOC_REVISIONS ?? 20)) || 20),
    /** online: songs stay on the user's devices */
    musicDir: online.enabled ? undefined : musicDirFrom(env.MUSIC_DIR),
    /** scan MUSIC_DIR when the server starts (new and changed files only) */
    scanOnStart: bool(env.LIBRARY_SCAN_ON_START, true),
    /** user-supplied URLs may reach private/LAN addresses (never cloud metadata) */
    allowPrivateFetch: online.enabled ? false : bool(env.ALLOW_PRIVATE_FETCH, false),
    /** extra ranges/hosts user-supplied URLs may reach: CIDRs, IPs, host names or host:port (ignored online) */
    fetchAllow: Object.freeze(online.enabled ? [] : list(env.FETCH_ALLOW)),
    /** the hosts' lookups (agent tools): caps per account and day, and the web search provider */
    agent: Object.freeze({
      lookupsPerDay: Math.max(1, Number(env.AGENT_LOOKUPS_PER_DAY ?? 400) || 400),
      webSearchesPerDay: Math.max(0, Number(env.AGENT_WEB_SEARCHES_PER_DAY ?? 40) || 0),
      search: webSearchFrom(env, online.enabled),
    }),
    /** what the hosts may do in the listener's Google account, only after they confirm (actions/) */
    actions: Object.freeze({
      perDay: Math.max(1, Number(env.ACTIONS_PER_DAY ?? 50) || 50),
      proposalsPerDay: Math.max(1, Number(env.ACTION_PROPOSALS_PER_DAY ?? 200) || 200),
      /** test knobs: how long a proposal and a confirmation token live, Google's answer time, the retry pauses */
      proposalTtlMs: Math.max(50, Number(env.ACTIONS_PROPOSAL_TTL_MS ?? 600_000) || 600_000),
      tokenTtlMs: Math.max(50, Number(env.ACTIONS_TOKEN_TTL_MS ?? 120_000) || 120_000),
      googleTimeoutMs: Math.max(100, Number(env.ACTIONS_GOOGLE_TIMEOUT_MS ?? 10_000) || 10_000),
      backoffMs: Object.freeze(backoffFrom(env.ACTIONS_BACKOFF_MS)),
      retryAfterCapMs: 3000,
    }),
    appScheme: env.APP_SCHEME ?? 'hostcaster',
    /** optional; the Spotify integration in the client uses PKCE and only needs the public client id */
    spotifyClientId: env.SPOTIFY_CLIENT_ID ?? '',
    /** built client served as static files */
    appDist: resolve(env.APP_DIST ?? join(SERVER_DIR, '..', 'app', 'dist')),
    logLevel: env.LOG_LEVEL ?? 'info',
  });
}
