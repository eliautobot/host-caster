// /api/actions: the hosts propose, the listener confirms, the app has the server act (see registry.js for what is
// allowed). The confirmation is a one-time token bound to this user, this action and the exact payload; it lives
// 2 minutes and is spent in the same transaction that starts the work.
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { hasGoogleScope } from '../integrations/google-auth.js';
import { prepare as prepareGoogle, runAction as runGoogle, undoAction as undoGoogle } from './google.js';
import { prepareNotion, runNotion, undoNotion } from './notion.js';
import { ORIGINS, TYPES, VIAS, describe, isTimeZone, levelOf, normalize, payloadHash } from './registry.js';
import {
  cancelRow,
  claimExecution,
  claimUndo,
  confirmRow,
  finishExecution,
  finishUndo,
  getRow,
  insertProposal,
  listRows,
  prune,
  rowByRef,
  secretsOf,
  toAction,
  usedToday,
} from './store.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_RE = /^[A-Za-z0-9:_.-]{1,100}$/;
const STATUSES = ['proposed', 'confirmed', 'executing', 'done', 'failed', 'cancelled', 'expired', 'undone'];

const notFound = () => new HttpError(404, 'not_found', 'No such action');

// each action type's service does the work: Google (calendar, tasks, invitations) or Notion
const isNotion = (type) => TYPES[type]?.service === 'notion';
const prepare = (app, userId, type, payload, opts) => (isNotion(type) ? prepareNotion(app, userId, opts) : prepareGoogle(app, userId, type, payload, opts));
const runAction = (app, userId, action) => (isNotion(action.type) ? runNotion(app, userId, action) : runGoogle(app, userId, action));
const undoAction = (app, userId, type, undo) => (isNotion(type) ? undoNotion(app, userId, undo) : undoGoogle(app, userId, type, undo));

function idOf(req) {
  const id = String(req.params.id ?? '').toLowerCase();
  if (!ID_RE.test(id)) throw notFound();
  return id;
}

/** errors that carry the current action answer { error, action } */
async function answer(reply, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.action) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message }, action: err.action });
    }
    throw err;
  }
}

export async function actionRoutes(app) {
  const caps = app.config.actions;

  app.post('/api/actions/propose', async (req, reply) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid_action', 'Send { type, payload, origin }', { field: 'body' });
    const ref = b.ref === undefined || b.ref === null ? undefined : String(b.ref);
    if (ref !== undefined && !REF_RE.test(ref)) throw new HttpError(400, 'invalid_action', 'ref is not valid', { field: 'ref' });
    if (ref) {
      const old = rowByRef(app, user.id, ref);
      if (old) return reply.status(200).send({ action: toAction(app, old) });
    }
    const now = Date.now();
    const payload = normalize(b.type, b.payload, { now });
    if (!ORIGINS.includes(b.origin)) throw new HttpError(400, 'invalid_action', `origin must be one of ${ORIGINS.join(', ')}`, { field: 'origin' });
    const said = typeof b.said === 'string' ? b.said.slice(0, 500) : undefined;
    const tz = isTimeZone(b.tz) ? b.tz : undefined;
    // the proposals cap first (cheap), then Google (the write scope, the task or invitation as it is now)
    if (usedToday(app, user.id, now).proposals >= caps.proposalsPerDay) {
      throw new HttpError(429, 'proposals_limit', `Your hosts suggested ${caps.proposalsPerDay} things today, the most for one day. Try again tomorrow.`);
    }
    const context = await prepare(app, user.id, b.type, payload, { tz });
    const { summary, others } = describe(b.type, payload, context, now);
    prune(app, now);
    const { row, existing } = insertProposal(app, user.id, {
      type: b.type,
      level: levelOf(b.type, context),
      origin: b.origin,
      ref,
      payload,
      payloadHash: payloadHash(b.type, payload),
      summary,
      others,
      said,
      context,
      ttlMs: caps.proposalTtlMs,
      perDay: caps.proposalsPerDay,
    });
    return reply.status(existing ? 200 : 201).send({ action: toAction(app, row) });
  });

  // used = actions run in the last 24 hours (the perDay cap), usedProposals = proposals (the proposalsPerDay cap)
  app.get('/api/actions/status', async (req) => {
    const user = requireUser(req);
    const used = usedToday(app, user.id);
    return {
      calendarWrite: hasGoogleScope(app, user.id, 'calendarEvents'),
      tasks: hasGoogleScope(app, user.id, 'tasks'),
      caps: { perDay: caps.perDay, proposalsPerDay: caps.proposalsPerDay },
      used: used.actions,
      usedProposals: used.proposals,
    };
  });

  app.get('/api/actions', async (req) => {
    const user = requireUser(req);
    const status = STATUSES.includes(req.query?.status) ? req.query.status : undefined;
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    return { actions: listRows(app, user.id, { limit, status }).map((r) => toAction(app, r)) };
  });

  app.get('/api/actions/:id', async (req) => {
    const user = requireUser(req);
    const row = getRow(app, user.id, idOf(req));
    if (!row) throw notFound();
    return { action: toAction(app, row) };
  });

  app.post('/api/actions/:id/confirm', async (req, reply) =>
    answer(reply, () => {
      const user = requireUser(req);
      const id = idOf(req);
      const b = req.body ?? {};
      if (!VIAS.includes(b.via)) throw new HttpError(400, 'invalid_request', `via must be one of ${VIAS.join(', ')} (an AI app never confirms)`);
      if (b.via === 'auto') {
        // "allowed without asking" (the listener's own Settings choice) is for level 2 only: never when others see it
        const current = getRow(app, user.id, id);
        if (current && current.level !== 2) throw new HttpError(400, 'invalid_request', 'Others will see this one, so it needs a yes or a tap');
      }
      const { row, token } = confirmRow(app, user.id, id, { payloadHash: b.payloadHash, via: b.via, tokenTtlMs: caps.tokenTtlMs, perDay: caps.perDay });
      return token ? { token, action: toAction(app, row) } : { action: toAction(app, row) };
    }),
  );

  app.post('/api/actions/:id/execute', async (req, reply) =>
    answer(reply, async () => {
      const user = requireUser(req);
      const id = idOf(req);
      const b = req.body ?? {};
      const current = getRow(app, user.id, id);
      if (!current) throw notFound();
      // the payload sent now must be the one confirmed (same shape rules; no clock checks: it was checked when proposed)
      let hash = null;
      try {
        hash = payloadHash(current.type, normalize(current.type, b.payload));
      } catch {
        hash = null;
      }
      const row = claimExecution(app, user.id, id, { token: b.token, hash, perDay: caps.perDay });
      const secrets = secretsOf(app, row);
      const outcome = await runAction(app, user.id, { id: row.id, type: row.type, origin: row.origin, payload: secrets.payload, context: secrets.context });
      return { action: toAction(app, finishExecution(app, row, outcome)) };
    }),
  );

  app.post('/api/actions/:id/cancel', async (req) => {
    const user = requireUser(req);
    return { action: toAction(app, cancelRow(app, user.id, idOf(req))) };
  });

  app.post('/api/actions/:id/undo', async (req, reply) =>
    answer(reply, async () => {
      const user = requireUser(req);
      const id = idOf(req);
      const { row, claimed } = claimUndo(app, user.id, id);
      if (!claimed) return { action: toAction(app, row) };
      const { undo } = secretsOf(app, row);
      const outcome = await undoAction(app, user.id, row.type, undo);
      return { action: toAction(app, finishUndo(app, row, outcome)) };
    }),
  );
}
