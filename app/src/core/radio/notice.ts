// What Home says after a break the scripted fallback or the device voice had to cover, with a link that fixes it when
// there is one (a ChatGPT plan at its usage limit: Manage usage in ChatGPT settings).
import { isChatGPTLimit, MANAGE_USAGE_URL } from '../api/chatgpt';
import { isIncludedCode } from '../api/online';
import { linksToPlans, sellsPlans } from '../native/platform';

/** Plans are sold here (web, desktop) or the phone app links to the website's plans (its plan page has the button). */
const plansOffered = sellsPlans || linksToPlans;
import type { RadioState } from '../types';
import type { PreparedBreak } from './prepare';

type Notice = Pick<RadioState, 'notice' | 'noticeLink'>;

/** The fix for a stand-in: ChatGPT usage settings, or the Host-Caster plan page (included AI used up or paused). */
function linkFor(code: string | undefined): Notice['noticeLink'] {
  if (isChatGPTLimit(code)) return { label: 'Manage usage', url: MANAGE_USAGE_URL };
  if (isIncludedCode(code) && (plansOffered || code !== 'included_plan_required')) return { label: 'See your plan', url: '/settings/plan' };
  return undefined;
}

/** A phone app without the plan link: "comes with the X plan" becomes a plain fact about this account. */
function reason(text: string, code: string | undefined): string {
  if (plansOffered || code !== 'included_plan_required') return text;
  return /voice/i.test(text) ? 'Host-Caster Voices are not included with this account.' : 'Host-Caster AI is not included with this account.';
}

export function standInNotice(b: Pick<PreparedBreak, 'standIn' | 'standInFor' | 'standInCode'>): Notice {
  if (!b.standIn) return {};
  // no detail = both (older prepared breaks)
  const brain = b.standInFor ? Boolean(b.standInFor.brain) : true;
  const voice = b.standInFor ? Boolean(b.standInFor.voice) : true;
  const who = brain && voice ? 'The scripted fallback and this device’s voice' : brain ? 'The scripted fallback' : 'This device’s voice';
  return {
    notice: `${who} stood in: ${reason(b.standIn, b.standInCode)}`,
    noticeLink: linkFor(b.standInCode),
  };
}

/** A skipped break (no stand-in possible). */
export function skippedNotice(message: string, code?: string): Notice {
  return {
    notice: `Break skipped: ${reason(message, code)}`,
    noticeLink: linkFor(code),
  };
}
