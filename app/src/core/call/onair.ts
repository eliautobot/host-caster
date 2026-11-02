// "Hosts may mention our chat on air" (off by default): the next break may bring up the listener's newest chat
// message, once. Kept apart from chat.ts so the break writer (radio/prepare.ts) does not import the radio itself.
import { kvGet, kvSet } from '../db';

export const CHAT_KEY = 'chat:thread';
export const CHAT_ON_AIR_KEY = 'chat:onair';
const AIRED_KEY = 'chat:aired';

/** A line for the break's notes: the listener's newest chat message not aired yet (marked as aired once used). */
export async function chatNoteForAir(now = Date.now()): Promise<string | undefined> {
  if ((await kvGet<boolean>(CHAT_ON_AIR_KEY).catch(() => undefined))?.value !== true) return undefined;
  const row = (await kvGet<{ at: number; messages: { who: string; text: string; at: number }[] }>(CHAT_KEY).catch(() => undefined))?.value;
  const aired = (await kvGet<number>(AIRED_KEY).catch(() => undefined))?.value ?? 0;
  const mine = row?.messages.filter((m) => m.who === 'you' && m.at > aired && now - m.at < 2 * 3600_000).at(-1);
  if (!mine) return undefined;
  await kvSet(AIRED_KEY, mine.at).catch(() => undefined);
  return `In the station's chat earlier, the listener wrote to the hosts: "${mine.text.slice(0, 160)}" (you may mention it once, warmly)`;
}
