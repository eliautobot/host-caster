// IMAP email summary (any provider: Fastmail, iCloud, Outlook app passwords, self-hosted). Credentials are stored
// sealed in the user's secrets (ref "imap"); the password never goes back to the client.
import { ImapFlow } from 'imapflow';
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { checkHost } from '../net/egress.js';
import { deleteSecret, getSecret, putSecret } from '../routes/secrets.js';
import { displayName } from './google.js';

const REF = 'imap';

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

async function summary(client, max) {
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
          subject: msg.envelope?.subject?.trim() || '(no subject)',
          important: flags.has('\\Flagged') || flags.has('$Important'),
          at: new Date(msg.internalDate ?? msg.envelope?.date ?? 0).getTime() || 0,
        });
      }
    }
    items.sort((a, b) => Number(b.important) - Number(a.important) || b.at - a.at);
    return { messages: items.slice(0, max), unread: uids.length };
  } finally {
    lock.release();
  }
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
    return withImap(app, saved, (c) => summary(c, max));
  });
}
