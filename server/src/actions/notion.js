// Notion writes as actions (docs/AGENT.md, section 6): the hosts propose a to-do or a note for the page the listener
// chose for them, the listener says yes (or allowed it without asking), and the server appends it. Undo moves only
// that block to Notion's trash. The same proposal, one-time confirmation, log and undo as the Google actions, so a
// tool's policy (allowed / ask first / off) means the same for every outside service.
import { HttpError } from '../errors.js';
import { checkId, notionClient } from '../integrations/notion/api.js';
import { forgetContext } from '../integrations/notion/read.js';
import { getLink, markUndone } from '../integrations/notion/store.js';
import { writeForUser } from '../integrations/notion/routes.js';

/** Checks Notion can take it now (connected, writes on, a page chosen) and returns the page for the read-back. */
export async function prepareNotion(app, userId, { tz } = {}) {
  if (!app.config.notion?.enabled) throw new HttpError(409, 'notion_not_configured', 'Notion is not set up on this server');
  const link = getLink(app, userId);
  if (!link) throw new HttpError(409, 'notion_not_connected', 'Connect Notion first');
  if (!link.settings.writesOn) throw new HttpError(403, 'notion_writes_off', 'Adding notes to Notion is turned off in Settings');
  if (!link.settings.write) throw new HttpError(409, 'notion_no_page', 'No Notion page is chosen for the hosts to write to');
  return { pageTitle: link.settings.write.title ?? 'Host-Caster', ...(tz ? { tz } : {}) };
}

/** Appends the confirmed to-do or note (once: the action id is the write's ref). Never throws. */
export async function runNotion(app, userId, action) {
  try {
    const r = await writeForUser(app, userId, {
      kind: action.payload.kind,
      text: action.payload.text,
      source: action.origin === 'ai-app' ? 'app' : 'call',
      tz: action.context?.tz,
      ref: `action:${action.id}`,
    });
    if (!r.ok) return { ok: false, code: r.code === 'rate_limited' ? 'upstream_rate_limited' : 'upstream_error', message: `Notion did not take it: ${r.message}`, attempts: 1 };
    return {
      ok: true,
      result: { pageTitle: r.pageTitle ?? r.activity?.pageTitle, activityId: r.activity?.id },
      undo: { blockId: r.activity?.blockId, activityId: r.activity?.id },
      attempts: 1,
    };
  } catch (err) {
    const message = err instanceof HttpError ? err.message : 'Notion did not answer';
    if (!(err instanceof HttpError)) app.log.error({ err }, 'notion action failed');
    return { ok: false, code: 'upstream_error', message, attempts: 1 };
  }
}

/** Moves only the block this action added to Notion's trash. { ok } or { ok: false, code: 'undo_failed', message }. */
export async function undoNotion(app, userId, undo) {
  try {
    if (!undo?.blockId) return { ok: false, code: 'undo_failed', message: 'Notion did not say what it added, so there is nothing to undo.' };
    try {
      await notionClient(app, userId).call('DELETE', `/v1/blocks/${checkId(undo.blockId)}`);
    } catch (err) {
      // already gone (the listener removed it in Notion): undone either way
      if (err.code !== 'notion_not_shared' && err.code !== 'not_found') throw err;
    }
    forgetContext(userId);
    if (undo.activityId) markUndone(app, userId, undo.activityId);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'undo_failed', message: `Notion ${err?.code === 'notion_not_connected' ? 'is not connected anymore' : 'did not answer'}, so the note is still on the page.` };
  }
}

