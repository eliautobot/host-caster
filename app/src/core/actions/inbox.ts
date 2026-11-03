// A note from the listener's own AI app (MCP). With an AI brain the hosts' agent reads it (agent/kit, turn 'ai-app'):
// it may add to Your list or Notion right away and propose Google changes, but only the listener's own yes (a call,
// the chat, a call-in) or a tap runs those; an AI app never confirms. A note that is only information stays in the
// break's notes. Without an AI brain the plain command reader keeps working (Your list, Notion).
import { effectsTurn } from '../agent/kit/effects'
import { agentTurn } from '../agent/kit/turn'
import type { Effect } from '../agent/kit/types'
import { toolContext } from '../agent/research'
import { getInbox, markInboxUsed } from '../context/sources'
import { getProfile, getSettings } from '../db'
import { kvGet, kvSet } from '../db/kv'
import { learnFromWords } from '../memory/learn'
import type { NotionWrite } from '../radio/notionAsk'
import { nextInboxNotionWrite, stationHost } from '../radio/notionWrite'
import { parseTrackerCommand } from '../tracker/commands'
import type { InboxItem, Station } from '../types'
import { takeActionTurn, type ActionTurn } from './callin'

export interface InboxTurn {
  action?: ActionTurn
  notion?: NotionWrite
}

const SEEN = 'agent:inbox-read'
const DEADLINE_MS = 20_000

const lead = 'Your AI app asked me to do something. '

/** What the agent did for one note, as the break's closing line (ActionTurn). */
async function turnOf(effects: Effect[]): Promise<ActionTurn | undefined> {
  const t = await effectsTurn(effects)
  const changes = effects.filter((e): e is Extract<Effect, { kind: 'changed' }> => e.kind === 'changed').map((e) => e.change.what)
  if (t) return t.kind === 'asked' ? { ...t, line: `${lead}${t.line}` } : t
  if (!changes.length) return undefined
  return { kind: 'added', fact: `FROM THE LISTENER'S AI APP, DONE: ${changes.join('; ')}.`, line: `Your AI app asked me to help, so: ${changes.join('; ')}.` }
}

async function agentInbox(station: Station, items: InboxItem[], now: number): Promise<InboxTurn | undefined> {
  const who = await stationHost(station).catch(() => undefined)
  if (!who) return undefined
  const seen = new Set((await kvGet<string[]>(SEEN))?.value ?? [])
  const item = items.find((i) => i.kind === 'note' && i.text.trim() && !seen.has(i.id))
  if (!item) return { }
  await kvSet(SEEN, [...seen, item.id].slice(-200))
  const settings = await getSettings()
  const profile = await getProfile()
  const listener = profile.callMe || profile.name || 'the listener'
  const res = await agentTurn({
    turn: 'ai-app',
    brain: who.brain,
    system: [
      `You are ${who.host.name}, a host on the radio station ${station.name}. ${listener}'s own AI app (their assistant) sent the hosts a note.`,
      'When the note asks the hosts to do something you can do, do it with your tools. When it is only information, do nothing and answer "noted".',
      'Answer in one short sentence: what you did.',
    ].join('\n'),
    user: `NOW: ${new Date(now).toString().slice(0, 21)}\n\nTHE NOTE FROM THE AI APP: "${item.text.slice(0, 600)}"`,
    said: item.text,
    heard: item.text,
    ctx: await toolContext(settings, { news: [] }, who.host, 'question'),
    maxSteps: 3,
    maxCalls: 4,
    deadline: now + DEADLINE_MS,
    maxTokens: 200,
  })
  // the note is the listener's own words: what the agent did not remember itself is learned from (never twice)
  if (!res.effects.some((e) => e.kind === 'memory')) void learnFromWords(item.text, 'app', { stationId: station.id }).catch(() => undefined)
  if (!res.effects.length) return {}
  await markInboxUsed([item.id])
  const notion = res.effects.find((e): e is Extract<Effect, { kind: 'notion' }> => e.kind === 'notion')?.write
  const action = await turnOf(res.effects)
  return { ...(action ? { action } : {}), ...(notion ? { notion } : {}) }
}

/** The next AI-app note the hosts act on (one per break). */
export async function nextInboxTurn(station: Station, now = Date.now()): Promise<InboxTurn | undefined> {
  const settings = await getSettings()
  const items = await getInbox(settings.connections.aiApps?.enabled !== false, now)
  const byAgent = await agentInbox(station, items, now).catch(() => undefined)
  if (byAgent) return byAgent.action || byAgent.notion ? byAgent : undefined
  // no AI brain: the plain command reader (a Notion note, then Your list)
  const notion = await nextInboxNotionWrite(station).catch(() => undefined)
  if (notion) return { notion }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  for (const item of items.filter((i) => i.kind === 'note' && parseTrackerCommand(i.text, { now: new Date(now), tz })).slice(0, 2)) {
    const turn = await takeActionTurn({ said: item.text, origin: 'ai-app', ref: `inbox:${item.id}`, now }).catch(() => undefined)
    if (!turn) continue
    await markInboxUsed([item.id])
    return { action: turn }
  }
  return undefined
}
