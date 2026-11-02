// A message from the listener's own AI app (MCP) that asks the hosts to do something: it counts as the listener's
// words (it may add to Your list right away), but levels 2-3 still wait for the listener's own yes (a call-in or a
// tap). An AI-app message never confirms anything itself.
import { getInbox, markInboxUsed } from '../context/sources'
import { getSettings } from '../db'
import { stationBrain } from '../radio/notionWrite'
import { parseTrackerCommand } from '../tracker/commands'
import type { Station } from '../types'
import { takeActionTurn, type ActionTurn } from './callin'
import { mightAskToAct } from './understand'

export async function nextInboxAction(station: Station, now = Date.now()): Promise<ActionTurn | undefined> {
  const settings = await getSettings()
  const items = await getInbox(settings.connections.aiApps?.enabled !== false, now)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const candidates = items.filter((i) => i.kind === 'note' && (mightAskToAct(i.text) || parseTrackerCommand(i.text, { now: new Date(now), tz })))
  if (!candidates.length) return undefined
  const brain = await stationBrain(station).catch(() => undefined)
  for (const item of candidates.slice(0, 2)) {
    const turn = await takeActionTurn({ said: item.text, origin: 'ai-app', brain, ref: `inbox:${item.id}`, now }).catch(() => undefined)
    if (!turn) continue
    await markInboxUsed([item.id])
    return turn
  }
  return undefined
}
