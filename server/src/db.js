// SQLite via node:sqlite (no native deps). Append migrations; never edit a shipped one.
import { DatabaseSync } from 'node:sqlite';
import { migrateBuiltinBrains } from './routes/syncDoc.js';

export const MIGRATIONS = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        email TEXT,
        avatar_url TEXT,
        password_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;

      CREATE TABLE identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        tokens_enc TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (provider, subject)
      );
      CREATE INDEX identities_user ON identities(user_id);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('web', 'app')),
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE INDEX sessions_expires ON sessions(expires_at);

      CREATE TABLE sync_docs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE secrets (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ref TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, ref)
      );

      CREATE TABLE inbox (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        source TEXT,
        until INTEGER,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX inbox_user_pending ON inbox(user_id, consumed_at);

      CREATE TABLE connector_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX connector_tokens_user ON connector_tokens(user_id);

      CREATE TABLE server_tracks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        album TEXT NOT NULL DEFAULT '',
        album_artist TEXT,
        year INTEGER,
        genre TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        mime TEXT,
        size INTEGER,
        mtime INTEGER,
        art_path TEXT,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX server_tracks_artist ON server_tracks(artist, album);
    `,
  },
  {
    id: 2,
    name: 'auth flows, connector urls, user state',
    sql: `
      -- OAuth round trips (state + PKCE verifier) and one-time codes (native exchange, link tickets).
      CREATE TABLE auth_flows (
        id TEXT PRIMARY KEY,           -- sha256 of the state / code / ticket
        kind TEXT NOT NULL,            -- oauth | exchange | link
        provider TEXT,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX auth_flows_expires ON auth_flows(expires_at);

      ALTER TABLE connector_tokens ADD COLUMN token_enc TEXT;
      ALTER TABLE identities ADD COLUMN profile TEXT NOT NULL DEFAULT '{}';

      -- Small per-user live state (now playing reported by the client for MCP tools).
      CREATE TABLE user_state (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `,
  },
  {
    id: 3,
    name: 'chatgpt plan connections',
    sql: `
      -- Sign in with ChatGPT registrations (one issued client id per user + ChatGPT account/workspace). The
      -- registration stays after sign-out so the next sign-in reuses it; tokens_enc is cleared on sign-out.
      CREATE TABLE chatgpt_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        subject TEXT,
        email TEXT,
        name TEXT,
        scopes TEXT NOT NULL DEFAULT '',
        tokens_enc TEXT,
        status TEXT NOT NULL DEFAULT 'pending',  -- pending | connected | not_enabled | expired | signed_out
        active INTEGER NOT NULL DEFAULT 0,
        paused_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (user_id, client_id)
      );
      CREATE INDEX chatgpt_accounts_user ON chatgpt_accounts(user_id, active);
    `,
  },
  {
    id: 4,
    name: 'online edition: verified emails, subscriptions, usage',
    sql: `
      -- Set when the user proved they own the email (a sign-in code, or Google/Apple said it is verified).
      ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

      -- One Stripe customer per user.
      CREATE TABLE billing_customers (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      -- Stripe subscriptions as last read from Stripe (the source of truth). Times in ms.
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,                    -- Stripe subscription id
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL,
        plan TEXT NOT NULL,                     -- voice | brain | both
        price_id TEXT,
        item_id TEXT,
        status TEXT NOT NULL,                   -- Stripe status: active, trialing, past_due, canceled ...
        current_period_start INTEGER,
        current_period_end INTEGER,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        grace_until INTEGER,                    -- a failed renewal keeps the plan until then
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX subscriptions_user ON subscriptions(user_id);

      -- Webhook idempotency: every event id handled once.
      CREATE TABLE stripe_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        result TEXT
      );

      -- Included AI spend per user, billing period and category (brain | voice | premium). 1 micro = 1e-6 USD.
      CREATE TABLE usage_totals (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period TEXT NOT NULL,
        category TEXT NOT NULL,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        units INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, period, category)
      );

      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period TEXT NOT NULL,
        at INTEGER NOT NULL,
        category TEXT NOT NULL,
        model TEXT,
        units INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 0,
        generation_id TEXT
      );
      CREATE INDEX usage_events_user ON usage_events(user_id, at);

      -- Platform-wide spend per UTC day (kept when accounts are deleted, so the daily guard cannot be reset).
      CREATE TABLE platform_spend (
        day TEXT PRIMARY KEY,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        alerted_at INTEGER
      );
    `,
  },
  {
    id: 5,
    name: 'hosts on the built-in brain get none (the scripted fallback is automatic now)',
    run: (db) => migrateBuiltinBrains(db),
  },
  {
    id: 6,
    name: 'synced songs, playlist lists and unplayable marks (per record, incremental)',
    sql: `
      -- One row per synced record: kind 'track' (a song that is a reference: YouTube, Spotify, a stream, a
      -- Subsonic or server library song; files never come here), 'members' (a playlist's songs in order, by
      -- track key) or 'unplayable' (a song that cannot play, by track key). json NULL = deleted (tombstone).
      -- updated_at is the device's edit time (newer wins); seq is the account's change counter for pulls.
      CREATE TABLE sync_items (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT,
        updated_at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (user_id, kind, id)
      );
      CREATE INDEX sync_items_seq ON sync_items(user_id, seq);

      -- Per account: the last seq handed out, and up to which seq tombstones were dropped (older cursors start over).
      CREATE TABLE sync_item_meta (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL DEFAULT 0,
        pruned_seq INTEGER NOT NULL DEFAULT 0,
        pruned_at INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    id: 7,
    name: 'reported AI breaks',
    sql: `
      -- A break someone flagged from the app (store rules: AI content can be reported without leaving the app).
      -- kind 'break'; json = { stationName?, at, lines: [{ hostName, text }], note? } as sent. Goes with the account.
      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX reports_user ON reports(user_id, created_at);
      CREATE INDEX reports_created ON reports(created_at);
    `,
  },
];

/** Applies pending migrations in order, each in its own transaction. Returns the ids applied. */
export function migrate(db, migrations = MIGRATIONS) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const done = new Set(db.prepare('SELECT id FROM migrations').all().map((r) => r.id));
  const applied = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      if (m.sql) db.exec(m.sql);
      if (m.run) m.run(db);
      db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} (${m.name}) failed: ${err.message}`, { cause: err });
    }
  }
  return applied;
}

/** Opens (creating if needed) and migrates the database. Use ':memory:' in tests. */
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}
