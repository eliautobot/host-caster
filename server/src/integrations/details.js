// The details behind a calendar event or an email, as clean short text the hosts can use: description without HTML or
// links (the links are kept apart, never read aloud), organizer, guests and who said yes, the listener's own answer,
// the video call (provider only), attachments by title, how it repeats; an email's text without quotes and
// signatures, and the calendar invitation inside it. Pure functions (tests feed real Google API shapes).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: ', ', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '-', middot: '-' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/** Lines that are dial-in boilerplate (numbers, codes, PINs): never on air. */
const DIAL_IN = /meeting id|passcode|password|pin[:#]|dial[- ]in|one tap|join by phone|find your local number|\+\d[\d\s().-]{7,}|^#+$|^tel:|more phone numbers|join with google meet|join zoom meeting|join on your computer|microsoft teams meeting|click here to join|learn more about meet|^-::~/i;

/**
 * HTML or plain text -> clean text: tags out, entities decoded, links collected apart (label + url) and taken out of
 * the text, conference boilerplate removed, blank lines collapsed, capped at `max` characters (at a word).
 * @returns {{ text: string, links: { url: string, label?: string }[] }}
 */
export function cleanText(input, max = 600) {
  let s = String(input ?? '');
  const links = [];
  const addLink = (url, label) => {
    const u = decodeEntities(url).replace(/[.,;:]+$/, '');
    if (!/^https?:\/\//i.test(u) || links.some((l) => l.url === u)) return;
    links.push(label && label !== u ? { url: u, label } : { url: u });
  };
  // Google's own conference block in descriptions sits between "-::~:~::~" lines
  s = s.replace(/-::~[:~]+::-?[\s\S]*?(-::~[:~]+::-?|$)/g, '\n');
  if (/<[a-z][\s\S]*>/i.test(s)) {
    s = s
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
        const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        addLink(href, label && !/^https?:/i.test(label) ? label.slice(0, 80) : undefined);
        return label && !/^https?:/i.test(label) ? label : ' ';
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  }
  s = decodeEntities(s);
  for (const m of s.matchAll(URL_RE)) addLink(m[0]);
  s = s.replace(URL_RE, ' ').replace(/[<>]/g, ' ');
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => !DIAL_IN.test(l) && !/^[-_=*~.]{3,}$/.test(l));
  s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: capText(s, max), links: links.slice(0, 6) };
}

/** Cuts at a word near `max` and adds "...". */
export function capText(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}...`;
}

/** "dana.reyes@example.com" -> "Dana Reyes"; a display name wins; never the whole address. */
export function personName(displayName, email) {
  const n = String(displayName ?? '').replace(/["<>]/g, '').trim();
  if (n && !n.includes('@')) return n;
  const local = String(email || n).split('@')[0] ?? '';
  const words = local.replace(/[0-9]+/g, ' ').split(/[._+-]+/).map((w) => w.trim()).filter((w) => w.length > 1);
  if (!words.length) return 'someone';
  return words.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

const VIDEO = [
  [/meet\.google\.com\//i, 'Google Meet'],
  [/(^|[./])zoom\.us\/(j|my|w)\//i, 'Zoom'],
  [/teams\.(microsoft|live)\.com\//i, 'Microsoft Teams'],
  [/webex\.com\//i, 'Webex'],
  [/whereby\.com\//i, 'Whereby'],
  [/(gotomeeting|gotomeet)\.(com|me)\//i, 'GoTo Meeting'],
  [/chime\.aws\//i, 'Amazon Chime'],
  [/meet\.jit\.si\//i, 'Jitsi'],
  [/discord\.(gg|com\/invite)\//i, 'Discord'],
  [/facetime\.apple\.com\//i, 'FaceTime'],
];

/** The video call of an event: Google's conferenceData, hangoutLink, or a known link in the location/description. */
export function videoCall(ev, extraText = '') {
  const cd = ev?.conferenceData;
  const entry = cd?.entryPoints?.find((p) => p?.entryPointType === 'video' && p.uri);
  if (entry) return { provider: cd.conferenceSolution?.name || providerOf(entry.uri) || 'a video call', url: entry.uri };
  if (ev?.hangoutLink) return { provider: 'Google Meet', url: ev.hangoutLink };
  for (const text of [ev?.location, ev?.description, extraText]) {
    for (const m of String(text ?? '').matchAll(URL_RE)) {
      const provider = providerOf(m[0]);
      if (provider) return { provider, url: decodeEntities(m[0]).replace(/[.,;:]+$/, '') };
    }
  }
  return undefined;
}

export function providerOf(url) {
  return VIDEO.find(([re]) => re.test(url))?.[1];
}

const FREQ = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const DAYS = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };

/** RRULE lines -> "weekly", "every 2 weeks", "every weekday", "monthly", "yearly", "daily". */
export function recurrenceWords(rules) {
  const rule = (Array.isArray(rules) ? rules : [rules]).map(String).find((r) => /^RRULE:/i.test(r) || /FREQ=/i.test(r));
  if (!rule) return undefined;
  const p = Object.fromEntries(rule.replace(/^RRULE:/i, '').split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  const unit = FREQ[p.FREQ?.toUpperCase()];
  if (!unit) return undefined;
  const n = Number(p.INTERVAL || 1);
  const days = (p.BYDAY ?? '').split(',').filter(Boolean).map((d) => d.slice(-2).toUpperCase());
  if (unit === 'week' && days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.includes(d))) return 'every weekday';
  const base = n > 1 ? `every ${n} ${unit}s` : unit === 'day' ? 'daily' : `${unit}ly`;
  if (unit === 'week' && days.length && days.length < 5) return `${base} on ${days.map((d) => DAYS[d]).filter(Boolean).join(' and ')}`;
  return base;
}

const STATUS = new Set(['accepted', 'declined', 'tentative', 'needsAction']);
const MAX_GUESTS = 12;

/**
 * Google event -> the extra fields the hosts get: description (clean), links, organizer, creator, attendees with their
 * answers, guests count, my response, invitation, video, attachments, recurrence, link, updated, uid.
 * `master` = the recurring series (for "weekly"); `max` caps the description.
 */
export function eventDetails(ev, { master, max = 400 } = {}) {
  const out = {};
  const { text, links } = cleanText(ev.description ?? '', max);
  if (text) out.description = text;
  const video = videoCall(ev);
  const otherLinks = links.filter((l) => !video || l.url !== video.url).filter((l) => !providerOf(l.url));
  if (otherLinks.length) out.links = otherLinks.slice(0, 4);
  if (ev.organizer && !ev.organizer.self) out.organizer = personName(ev.organizer.displayName, ev.organizer.email);
  if (ev.organizer?.self) out.organizerSelf = true;
  if (ev.creator && !ev.creator.self) out.creator = personName(ev.creator.displayName, ev.creator.email);
  const people = (ev.attendees ?? []).filter((a) => a && !a.resource);
  if (people.length) {
    out.guests = people.length + people.reduce((n, a) => n + (Number(a.additionalGuests) || 0), 0);
    out.attendees = people.slice(0, MAX_GUESTS).map((a) => ({
      name: personName(a.displayName, a.email),
      status: STATUS.has(a.responseStatus) ? a.responseStatus : 'needsAction',
      ...(a.organizer ? { organizer: true } : {}),
      ...(a.self ? { self: true } : {}),
      ...(a.optional ? { optional: true } : {}),
    }));
    const me = people.find((a) => a.self);
    if (me && STATUS.has(me.responseStatus)) out.myResponse = me.responseStatus;
    if (out.myResponse === 'needsAction' && !ev.organizer?.self) out.invitation = true;
  }
  const rooms = (ev.attendees ?? []).filter((a) => a?.resource).map((a) => a.displayName).filter(Boolean);
  if (rooms.length) out.rooms = rooms.slice(0, 3);
  if (video) out.video = video;
  const files = (ev.attachments ?? []).map((a) => String(a?.title ?? '').trim()).filter(Boolean);
  if (files.length) out.attachments = files.slice(0, 6);
  const rec = recurrenceWords(master?.recurrence ?? ev.recurrence ?? []);
  if (rec) out.recurrence = rec;
  else if (ev.recurringEventId) out.recurring = true;
  if (ev.htmlLink) out.link = ev.htmlLink;
  const updated = Date.parse(ev.updated ?? '');
  if (Number.isFinite(updated)) out.updated = updated;
  if (ev.iCalUID) out.uid = ev.iCalUID;
  return out;
}

// ---- Email -----------------------------------------------------------------------------------------------------------

const b64 = (data) => Buffer.from(String(data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function header(payload, name) {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Every leaf part of a Gmail payload, depth first. */
export function leafParts(payload) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    if (Array.isArray(p.parts) && p.parts.length) p.parts.forEach(walk);
    else out.push(p);
  };
  walk(payload);
  return out;
}

/** A reply's quoted history and the signature go; what the person wrote stays. */
export function stripQuoted(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .{4,200} wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^From: .+/.test(line) && out.length > 2) break;
    if (/^-- ?$/.test(line)) break;
    if (/^Sent from my (iPhone|iPad|Android|phone)/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * A Gmail message's readable text: text/plain when there is one, else the HTML as text; quotes and signatures out,
 * links kept apart. `max` caps it.
 * @returns {{ text: string, links: { url: string, label?: string }[] }}
 */
export function messageText(msg, max = 1500) {
  const parts = leafParts(msg?.payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data && !p.filename);
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data && !p.filename);
  if (plain) {
    const raw = b64(plain.body.data).toString('utf8');
    const fromHtml = html ? cleanText(b64(html.body.data).toString('utf8'), 100_000).links : [];
    const cleaned = cleanText(stripQuoted(raw), max);
    const links = [...fromHtml, ...cleaned.links].filter((l, i, a) => a.findIndex((x) => x.url === l.url) === i);
    return { text: cleaned.text, links: links.slice(0, 6) };
  }
  if (html) {
    const h = b64(html.body.data).toString('utf8').replace(/<div[^>]*class="gmail_quote"[\s\S]*$/i, '').replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
    return cleanText(h, max);
  }
  return { text: capText(decodeEntities(msg?.snippet ?? ''), max), links: [], snippetOnly: true };
}

/** The calendar part (text/calendar or an .ics file): inline data, or the attachment id to fetch. */
export function calendarPart(msg) {
  const parts = leafParts(msg?.payload);
  return parts.find((p) => p.mimeType === 'text/calendar') ?? parts.find((p) => p.mimeType === 'application/ics' || /\.ics$/i.test(p.filename ?? ''));
}

const INVITE_SUBJECT = /^(invitation|updated invitation|invitation from google calendar|canceled event|cancelled event|event canceled|accepted|declined|tentatively accepted|new event|updated event)\b[^:]{0,40}:/i;

/** Does this message look like a calendar invitation (or an answer to one)? Cheap: headers and parts only. */
export function looksLikeInvite(msg) {
  const sender = `${header(msg?.payload, 'Sender')} ${header(msg?.payload, 'From')}`;
  return /calendar-notification@google\.com|noreply@calendar|calendar-server/i.test(sender) || INVITE_SUBJECT.test(header(msg?.payload, 'Subject')) || Boolean(calendarPart(msg));
}

/** Google's eid parameter (base64url of "<eventId> <calendar id>") -> the event id (an instance keeps its _date). */
export function eventIdFromEid(eid) {
  try {
    const raw = b64(eid).toString('utf8');
    const id = raw.split(/\s+/)[0] ?? '';
    return /^[a-z0-9_]{5,1024}$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Unfolds an iCalendar text and reads the first VEVENT's UID, SUMMARY, DTSTART and the METHOD. */
export function icsSummary(text) {
  const lines = String(text ?? '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const get = (name) => {
    const line = lines.find((l) => l.toUpperCase().startsWith(`${name}:`) || l.toUpperCase().startsWith(`${name};`));
    return line ? line.slice(line.indexOf(':') + 1).replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1').trim() : undefined;
  };
  const method = get('METHOD')?.toLowerCase();
  return { method, uid: get('UID'), title: get('SUMMARY'), start: get('DTSTART') };
}

/**
 * What an invitation email points at: method (request | reply | cancel), event id (from Google's eid links), uid
 * (from the calendar part when it is inline or given as `icsText`), and the title from the subject.
 */
export function inviteOf(msg, icsText) {
  if (!looksLikeInvite(msg)) return undefined;
  const out = {};
  const subject = header(msg.payload, 'Subject');
  const sm = /^([^:]{3,40}):\s*(.+?)(?:\s+@\s+.+)?$/.exec(subject);
  if (sm) {
    out.title = sm[2].trim();
    const word = sm[1].toLowerCase();
    out.method = /cancel/.test(word) ? 'cancel' : /accepted|declined/.test(word) ? 'reply' : 'request';
    if (/accepted/.test(word)) out.answer = /tentatively/.test(word) ? 'tentative' : 'accepted';
    if (/declined/.test(word)) out.answer = 'declined';
    // Google holds an invitation from someone new: it is not on the calendar until answered in the email itself
    if (/unknown sender/.test(word)) out.unknownSender = true;
  }
  for (const p of leafParts(msg.payload)) {
    if (!p.body?.data || !/text\/(html|plain)/.test(p.mimeType ?? '')) continue;
    const m = /[?&](?:amp;)?eid=([A-Za-z0-9_-]{8,})/.exec(b64(p.body.data).toString('utf8'));
    const id = m && eventIdFromEid(m[1]);
    if (id) {
      out.eventId = id;
      break;
    }
  }
  const part = calendarPart(msg);
  const ics = icsText ?? (part?.body?.data ? b64(part.body.data).toString('utf8') : undefined);
  if (ics) {
    const s = icsSummary(ics);
    if (s.uid) out.uid = s.uid;
    if (s.method) out.method = s.method === 'reply' ? 'reply' : s.method === 'cancel' ? 'cancel' : 'request';
    if (s.title) out.title = s.title;
  }
  return out;
}
