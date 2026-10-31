// Reported AI breaks: app store rules ask that people can flag what the AI hosts said without leaving the app.
// POST /api/reports (signed in, both editions) stores the break's lines and an optional note for the server owner;
// the online edition also emails a copy (onlineHooks.onReport). Reports go with the account when it is deleted.
import { randomUUID } from 'node:crypto';
import { requireUser } from '../auth/session.js';
import { HttpError } from '../errors.js';

export const REPORT_LIMITS = Object.freeze({ maxBytes: 8 * 1024, maxLines: 20, perDay: 20 });
const DAY = 24 * 60 * 60 * 1000;

const bad = (message) => new HttpError(400, 'invalid_report', message);

/** Optional (or required) trimmed text of at most `max` characters. */
function textOf(value, name, max, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`${name} is missing`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const v = value.trim();
  if (required && !v) throw bad(`${name} is missing`);
  if (v.length > max) throw bad(`${name} is too long`);
  return v;
}

/**
 * Checks a report body: { kind: 'break', stationName?, at, lines: [{ hostName, text }], note? }. Returns the clean
 * report; throws 400, or 413 when it is over 8 KB.
 */
export function parseReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Send a report');
  if (body.kind !== 'break') throw bad('kind must be "break"');
  const at = body.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > Date.now() + DAY) throw bad('at must be when the break aired (ms)');
  const lines = body.lines;
  if (!Array.isArray(lines) || lines.length === 0) throw bad('lines are missing');
  if (lines.length > REPORT_LIMITS.maxLines) throw bad(`A report holds at most ${REPORT_LIMITS.maxLines} lines`);
  const report = {
    kind: 'break',
    at: Math.round(at),
    lines: lines.map((l, i) => {
      if (!l || typeof l !== 'object' || Array.isArray(l)) throw bad(`line ${i + 1} is not a line`);
      return { hostName: textOf(l.hostName, 'hostName', 80), text: textOf(l.text, 'text', REPORT_LIMITS.maxBytes, true) };
    }),
  };
  const stationName = textOf(body.stationName, 'stationName', 120);
  if (stationName) report.stationName = stationName;
  const note = textOf(body.note, 'note', 2000);
  if (note) report.note = note;
  if (Buffer.byteLength(JSON.stringify(report)) > REPORT_LIMITS.maxBytes) {
    throw new HttpError(413, 'report_too_large', 'That report is too long. Shorten the note and try again.');
  }
  return report;
}

/** Reports made since `since` (ms), for the admin summary. */
export const reportsSince = (db, since) => Number(db.prepare('SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?').get(since).n);

export async function reportRoutes(app) {
  app.post('/api/reports', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const user = requireUser(req);
    const report = parseReport(req.body);
    const t = Date.now();
    // per account, counted in the database (no await between the count and the insert)
    const today = app.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND created_at > ?').get(user.id, t - DAY).n;
    if (today >= REPORT_LIMITS.perDay) throw new HttpError(429, 'rate_limited', 'You sent many reports today. Try again tomorrow.');
    const id = randomUUID();
    const { kind, ...json } = report;
    app.db.prepare('INSERT INTO reports (id, user_id, kind, json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, user.id, kind, JSON.stringify(json), t);
    app.onlineHooks?.onReport?.({ id, user, report });
    return reply.status(201).send({ id, createdAt: t });
  });
}
