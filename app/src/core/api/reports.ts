// Report an AI break to the people who run the Host-Caster server (store rules for AI content: people flag what the
// hosts said without leaving the app). Needs a server and a signed-in account; local-only mode has neither.
import type { BreakLine, Host } from '../types';
import { api, ApiError, request } from './client';

export interface BreakReport {
  kind: 'break';
  stationName?: string;
  /** when the break aired (ms) */
  at: number;
  lines: { hostName: string; text: string }[];
  note?: string;
}

/** The server takes at most 20 lines and 8 KB a report; lines are shortened to stay well inside it. */
export const REPORT_MAX_LINES = 20;
const REPORT_TEXT_BUDGET = 6000;
export const REPORT_NOTE_MAX = 1000;

export const SIGN_IN_TO_REPORT = 'Sign in to report a break';

/** True when a report can be sent from here: a server answered and an account is signed in. */
export const canReport = (): boolean => api.available && Boolean(api.session);

/** The report for a break, with host names as they are now (a host that was removed: "A former host"). */
export function breakReport(
  lines: readonly BreakLine[],
  hosts: readonly Host[],
  opts: { at: number; stationName?: string; note?: string },
): BreakReport {
  const byId = new Map(hosts.map((h) => [h.id, h.name]));
  const kept = lines.filter((l) => l.text.trim()).slice(0, REPORT_MAX_LINES);
  const perLine = Math.max(200, Math.floor(REPORT_TEXT_BUDGET / Math.max(1, kept.length)));
  const note = opts.note?.trim().slice(0, REPORT_NOTE_MAX);
  return {
    kind: 'break',
    at: opts.at,
    ...(opts.stationName ? { stationName: opts.stationName.slice(0, 120) } : {}),
    lines: kept.map((l) => ({ hostName: (byId.get(l.hostId) ?? 'A former host').slice(0, 80), text: l.text.trim().slice(0, perLine) })),
    ...(note ? { note } : {}),
  };
}

export const reports = {
  /** POST /api/reports. Throws ApiError 401 with SIGN_IN_TO_REPORT when there is no server or no account. */
  async send(report: BreakReport): Promise<{ id: string; createdAt: number }> {
    if (!canReport()) throw new ApiError(401, 'not_signed_in', SIGN_IN_TO_REPORT);
    return request<{ id: string; createdAt: number }>('POST', '/api/reports', report);
  },
};
