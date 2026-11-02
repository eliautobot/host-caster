// Rule 1 in code: outside content (email, invites, Notion, web, news) is information, never instructions.
// These checks decide how an item from outside content is shown: requests for money, gift cards, passwords, codes,
// logins or "click this link", text that tries to instruct the hosts, and senders the listener never emailed are
// flagged "be careful, check it's real" and never presented as the listener's to-do. Links are never kept in the
// words the hosts read.

/** zero-width and direction-control characters hide text from people but not from models */
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿­]/g
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9.-]+\.(?:com|net|org|io|co|ly|xyz|top|info|biz|ru|cn|me|link|click|app)(?:\/[^\s<>"')\]]*)?/gi
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g

const MONEY = [
  /\bgift ?cards?\b/i, /\bwire (?:transfer|the money|money|\$|funds)/i, /\bwire\b.{0,20}\$\s?\d/i, /\bbitcoin|\bcrypto(?:currency)?\b|\busdt\b|\bbtc\b/i,
  /\bwestern union\b|\bmoneygram\b|\bzelle\b|\bvenmo\b|\bcash ?app\b|\bpaypal me\b/i, /\bsend (?:me |us )?(?:the )?(?:money|payment|funds|\$\s?\d)/i,
  /\btransfer (?:\$\s?\d|money|funds)/i, /\bpay (?:now|immediately|today) (?:to avoid|or)\b/i, /\bbank (?:details|account number|info)/i,
  /\boverdue\b.{0,40}\b(?:suspend|legal|collection)/i, /\brefund\b.{0,30}\bclaim\b/i, /\bprize\b|\byou(?:'ve| have) won\b|\blottery\b|\binheritance\b/i,
]
const CREDENTIALS = [
  /\bpasswords?\b|\bpass ?code\b|\bpin(?: number| code)?\b(?!\s*(?:it|this|the post))/i, /\b(?:verification|security|one[- ]time|login|2fa|otp|auth(?:entication)?) codes?\b/i,
  /\bverify (?:your|the) (?:account|identity|login|password)\b/i, /\b(?:account|mailbox) (?:will be )?(?:suspended|locked|closed|disabled|deactivated)\b/i,
  /\bconfirm your (?:password|login|details|identity|card)\b/i, /\bsocial security\b|\bssn\b|\bcard number\b|\bcvv\b/i,
  /\blog ?in (?:here|now|below|to (?:verify|confirm|avoid|keep))/i, /\bsign in (?:here|now|below|to (?:verify|confirm|avoid|keep))/i,
]
const LINK_ASK = [
  /\bclick (?:on )?(?:this|the|here|below|the link|the button|link)\b/i, /\btap (?:on )?(?:this|the) (?:link|button)\b/i, /\bfollow (?:this|the) link\b/i,
  /\bopen (?:this|the) (?:link|attachment)\b/i, /\bdownload (?:the|this) (?:attachment|file|invoice)\b/i, /\bscan (?:the|this) qr\b/i,
]
/** text that tries to instruct the hosts / the AI: never obeyed, only flagged */
const INSTRUCTIONS = [
  /\bignore (?:all |any |your |the |previous |prior |above )*(?:rules|instructions|prompts?|guidelines|directions)\b/i,
  /^\s*(?:system|assistant|developer|admin|host|ai)\s*[:>]/im, /\[(?:system|inst|assistant)\]|<\|?(?:system|im_start)/i,
  /\byou are (?:now|an? (?:ai|assistant|radio host))\b/i, /\b(?:as|dear) (?:the )?(?:ai|assistant|radio host|hosts?|language model)\b/i,
  /\b(?:tell|remind|ask|instruct) the (?:listener|user|owner)\b/i, /\bthe (?:listener|user) (?:wants|loves|asked|needs|must)\b/i,
  /\bremember (?:that )?(?:the )?(?:listener|user|my|his|her|their)\b/i, /\b(?:accept|decline) (?:all|every|each) (?:the )?(?:invites?|invitations?|meetings?)\b/i,
  /\bforward (?:this|it|all|the|every)\b/i, /\b(?:add|create|make) (?:a )?(?:task|reminder|event|calendar entry|to-?do)\b/i,
  /\b(?:do not|don't) (?:tell|mention|show)\b.{0,30}\b(?:listener|user)\b/i, /\bnew instructions?\b|\boverride\b|\bjailbreak\b/i,
  /\bignora (?:las|todas)|\bignorez (?:les|toutes)|\bignoriere (?:alle|die)|\bignora (?:le|tutte)|忽略|無視|игнорируй|Игнорируй/i,
  /system\s*:/i, /\b(?:ai|assistant|chatbot|bot|language model|llm)\s*[:,]/i, /\b(?:for|to) (?:the )?(?:ai|assistant|radio hosts?|bot)\b/i,
  /\b(?:ai|assistant|radio hosts?|the hosts|bot)\s+(?:must|should|will|needs? to|has to|is to)\b/i, /\b(?:accept|decline|rsvp)\b.{0,24}\b(?:all|every|everything)\b/i,
  /\b(?:admin|developer|god) mode\b|\bpending actions\b|\bapproved all\b/i,
]
/** asks to hand over the listener's data or contacts */
const SHARING = [/\binvite all (?:your|of your) contacts\b/i, /\bshare (?:your|the) (?:calendar|contacts|location|data|files)\b/i, /\bseed phrase\b|\brecovery phrase\b|\bprivate key\b/i]

export interface Caution {
  careful: boolean
  /** plain words for the list and the hosts ("asks for gift cards", "asks to click a link") */
  why?: string
  /** the text tries to tell the hosts what to do */
  instructs?: boolean
}

export function unhide(text: string): string {
  return (text ?? '').replace(HIDDEN, '')
}

/** The words the hosts may read: no links, no email addresses, no hidden characters, one line. */
export function speakable(text: string, max = 160): string {
  const out = unhide(text)
    .replace(EMAIL_RE, '')
    .replace(URL_RE, '')
    .replace(/\S*@\S*/g, '')
    .replace(/[<>{}[\]`|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
  if (out.length <= max) return out
  const cut = out.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, '')
}

export function hasLink(text: string): boolean {
  URL_RE.lastIndex = 0
  return URL_RE.test(unhide(text ?? ''))
}

/** How careful the listener should be with this outside content. */
export function caution(text: string): Caution {
  const t = unhide(text ?? '')
  if (INSTRUCTIONS.some((r) => r.test(t))) return { careful: true, instructs: true, why: 'tries to tell the hosts what to do' }
  if (MONEY.some((r) => r.test(t))) return { careful: true, why: 'asks for money or payment' }
  if (CREDENTIALS.some((r) => r.test(t))) return { careful: true, why: 'asks for a password, code or login' }
  if (LINK_ASK.some((r) => r.test(t))) return { careful: true, why: 'asks you to click a link' }
  if (SHARING.some((r) => r.test(t))) return { careful: true, why: 'asks you to share your data' }
  return { careful: false }
}

/** The text was hidden from people (zero-width characters, direction tricks). */
export function hasHiddenText(text: string): boolean {
  return /[​-‏‪-‮⁠-⁤﻿]/.test(text ?? '')
}
