// IMAP email summary (any provider: Fastmail, iCloud, Outlook app passwords, self-hosted). Credentials are stored
// sealed in the user's secrets (ref "imap"); the password never goes back to the client.
import { ImapFlow } from 'imapflow';
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { checkHost } from '../net/egress.js';
import { deleteSecret, getSecret, putSecret } from '../routes/secrets.js';
import { capText, cleanText, stripQuoted } from './details.js';
import { displayName } from './google.js';

const REF = 'imap';

/** The sender's address, lowercase (the app uses it to tell a new sender from a known one). */
const addressOf = (from) => {
  const a = String(from?.address ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(a) ? { address: a.slice(0, 120) } : {};
};

export const defaultImapFactory = (opts) => new ImapFlow(opts);

function readCreds(body, saved) {
  const host = String(body?.host ?? saved?.host ?? '').trim().toLowerCase();
  const user = String(body?.user ?? saved?.user ?? '').trim();
  const password = body?.password ? String(body.password) : saved?.password;
  const secure = body?.secure !== undefined ? Boolean(body.secure) : (saved?.secure ?? true);
  const port = Number(body?.port ?? saved?.port ?? (secure ? 993 : 143));
  if (!host || !/^[a-z0-9.-]+$/.test(host)) throw new HttpError(400, 'invalid_request', 'Enter the IMAP server name');
  if (!user) throw new HttpError(400, 'invalid_request', 'Enter the user name');
  if (!password) throw new HttpError(400, 'invalid_request', 'Enter the password (an app password for Gmail, iCloud or Outlook)');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'invalid_request', 'Bad port');
  return { host, port, secure, user, password };
}

function loadSaved(app, userId) {
  const raw = getSecret(app, userId, REF);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Connects (pinned to the validated address, TLS name = the host), runs fn, logs out. */
async function withImap(app, creds, fn) {
  const target = await checkHost(creds.host, creds.port, app.egressCtx.egress, app.egressCtx.resolver);
  const client = app.imapFactory({
    host: target.address,
    servername: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
    emitLogs: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { servername: creds.host },
  });
  client.on?.('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    const auth = err?.authenticationFailed || /auth/i.test(String(err?.responseText ?? err?.message));
    throw new HttpError(400, auth ? 'imap_auth_failed' : 'imap_failed', auth ? 'The server refused the user name or password' : `Could not connect: ${err?.message ?? err}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close?.());
  }
}

async function summary(client, max, withBodies = 0) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    const recent = uids.slice(-Math.max(max * 2, max));
    const items = [];
    if (recent.length) {
      for await (const msg of client.fetch(recent, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
        const from = msg.envelope?.from?.[0];
        const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags ?? []);
        items.push({
          id: `imap:${msg.uid}`,
          from: from ? displayName(from.name ? `${from.name} <${from.address}>` : (from.address ?? '')) : '',
          ...addressOf(from),
          subject: msg.envelope?.subject?.trim() || '(no subject)',
          important: flags.has('\\Flagged') || flags.has('$Important'),
          at: new Date(msg.internalDate ?? msg.envelope?.date ?? 0).getTime() || 0,
        });
      }
    }
    items.sort((a, b) => Number(b.important) - Number(a.important) || b.at - a.at);
    const top = items.slice(0, max);
    // the first few: what they say, not only who sent them (BODY.PEEK, so nothing is marked read)
    for (const item of top.slice(0, withBodies)) {
      const body = await messageBody(client, Number(item.id.slice(5)), 700).catch(() => undefined);
      if (body?.text) item.body = body.text;
    }
    return { messages: top, unread: uids.length };
  } finally {
    lock.release();
  }
}

/** The text/plain part (else text/html) of a message structure: its part id. */
function textPart(node) {
  const leaves = [];
  const walk = (n) => (n?.childNodes?.length ? n.childNodes.forEach(walk) : n && leaves.push(n));
  walk(node);
  const ok = (n) => n.disposition !== 'attachment';
  return leaves.find((n) => n.type === 'text/plain' && ok(n)) ?? leaves.find((n) => n.type === 'text/html' && ok(n));
}

async function readStream(stream, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    chunks.push(c);
    size += c.length;
    if (size > maxBytes) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One message's own words (quotes and signature out), links apart; read with BODY.PEEK (stays unread). */
async function messageBody(client, uid, max) {
  const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  const part = msg && textPart(msg.bodyStructure);
  if (!part) return undefined;
  const { content } = await client.download(String(uid), part.part ?? '1', { uid: true });
  const raw = await readStream(content);
  return cleanText(part.type === 'text/html' ? raw.replace(/<div[^>]*class="gmail_quote"[\s\S]*$/i, '').replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '') : stripQuoted(raw), max);
}

const imapUid = (id) => {
  const uid = Number(String(id ?? '').replace(/^imap:/, ''));
  if (!Number.isInteger(uid) || uid <= 0) throw new HttpError(400, 'invalid_request', 'Unknown message id');
  return uid;
};

function savedOrThrow(app, userId) {
  const saved = loadSaved(app, userId);
  if (!saved) throw new HttpError(409, 'imap_not_configured', 'Add your IMAP account first');
  return saved;
}

export const imapConfigured = (app, userId) => Boolean(loadSaved(app, userId));

/** Inbox messages whose subject, sender or text has the words (newest first, at most 8). For the hosts' lookups. */
export async function imapSearch(app, userId, query, max = 8) {
  const q = String(query ?? '').trim().slice(0, 120);
  if (!q) throw new HttpError(400, 'invalid_request', 'Say what to look for');
  return withImap(app, savedOrThrow(app, userId), async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ or: [{ subject: q }, { from: q }, { body: q }] }, { uid: true })) || [];
      const items = [];
      const recent = uids.slice(-max);
      if (recent.length) {
        for await (const msg of client.fetch(recent, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const from = msg.envelope?.from?.[0];
          items.push({
            id: `imap:${msg.uid}`,
            from: from ? displayName(from.name ? `${from.name} <${from.address}>` : (from.address ?? '')) : '',
            ...addressOf(from),
            subject: msg.envelope?.subject?.trim() || '(no subject)',
            at: new Date(msg.internalDate ?? msg.envelope?.date ?? 0).getTime() || 0,
            source: 'imap',
          });
        }
      }
      return items.sort((a, b) => b.at - a.at);
    } finally {
      lock.release();
    }
  });
}

/** One message in full (its text up to 3,000 characters). */
export async function imapRead(app, userId, id) {
  const uid = imapUid(id);
  return withImap(app, savedOrThrow(app, userId), async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true }, { uid: true });
      if (!msg) throw new HttpError(404, 'not_found', 'That message is gone');
      const from = msg.envelope?.from?.[0];
      const body = await messageBody(client, uid, 3000).catch(() => undefined);
      return {
        id: `imap:${uid}`,
        from: from ? displayName(from.name ? `${from.name} <${from.address}>` : (from.address ?? '')) : '',
        ...addressOf(from),
        subject: msg.envelope?.subject?.trim() || '(no subject)',
        at: new Date(msg.internalDate ?? msg.envelope?.date ?? 0).getTime() || 0,
        body: body?.text ? capText(body.text, 3000) : undefined,
        links: body?.links?.length ? body.links.slice(0, 4) : undefined,
        source: 'imap',
      };
    } finally {
      lock.release();
    }
  });
}

export async function imapRoutes(app) {
  app.get('/api/imap', async (req) => {
    const saved = loadSaved(app, requireUser(req).id);
    if (!saved) return { configured: false };
    const { password: _p, ...rest } = saved;
    return { configured: true, ...rest };
  });

  app.post('/api/imap/test', async (req) => {
    const user = requireUser(req);
    const creds = readCreds(req.body, loadSaved(app, user.id));
    const res = await withImap(app, creds, (c) => summary(c, 1));
    return { ok: true, unread: res.unread };
  });

  app.put('/api/imap', async (req) => {
    const user = requireUser(req);
    const creds = readCreds(req.body, loadSaved(app, user.id));
    const res = await withImap(app, creds, (c) => summary(c, 1));
    putSecret(app, user.id, REF, JSON.stringify(creds));
    const { password: _p, ...rest } = creds;
    return { configured: true, ...rest, unread: res.unread };
  });

  app.delete('/api/imap', async (req, reply) => {
    deleteSecret(app, requireUser(req).id, REF);
    return reply.status(204).send();
  });

  app.get('/api/imap/summary', async (req) => {
    const user = requireUser(req);
    const saved = loadSaved(app, user.id);
    if (!saved) throw new HttpError(409, 'imap_not_configured', 'Add your IMAP account first');
    const max = Math.max(1, Math.min(25, Number(req.query?.max ?? 10) || 10));
    return withImap(app, saved, (c) => summary(c, max, 3));
  });
}
