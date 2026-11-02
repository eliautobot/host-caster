// The details behind an item of the listener's day, in the few words a host needs: what it is about, who is in it,
// the listener's answer, the video call (never the link), what to prepare. Pure: used by the prompts, by the
// scripted fallback, by the scripted dossier and by "What your hosts can see".
import type { CalendarEvent, ContextPacket, Dossier, EmailSummary, Headline, RsvpStatus } from '../types';
import { subscribedOnly } from '../tracker/owned';

const ANSWER: Record<RsvpStatus, string> = { accepted: 'said yes', declined: 'said no', tentative: 'said maybe', needsAction: 'has not answered' };

/**
 * The first sentences of a text: a description written in lines ("Agenda", "1. Vendor numbers") reads as one line
 * joined with semicolons; numbered points and initials do not end a sentence.
 */
export const firstSentences = (text: string | undefined, n = 2, max = 240): string => {
  const lines = String(text ?? '').split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return '';
  const t = lines.length > 1 ? lines.join('; ').replace(/:;/g, ':') : lines[0]!;
  const parts = t.split(/(?<=[a-z]{2}[.!?])\s+(?=[A-Z])/).slice(0, n).join(' ');
  return parts.length > max ? `${parts.slice(0, max).replace(/\s+\S*$/, '')}...` : parts;
};

/** "Dana Reyes (organizer, said yes), Mike Chen (said yes), Priya Shah (said maybe)" and "and 2 more". */
export function peopleWords(e: Pick<CalendarEvent, 'attendees' | 'guests' | 'organizer'>, max = 5): string | undefined {
  const others = (e.attendees ?? []).filter((a) => !a.self);
  if (!others.length) return e.organizer ? `${e.organizer} (organizer)` : undefined;
  const shown = others.slice(0, max).map((a) => `${a.name} (${[a.organizer ? 'organizer' : '', ANSWER[a.status]].filter(Boolean).join(', ')})`);
  const more = Math.max(0, (e.guests ?? others.length + 1) - 1 - shown.length);
  return `${shown.join(', ')}${more ? `, and ${more} more` : ''}`;
}

/** The email that goes with an event: its invitation, or a message whose subject names the event. */
export function linkedEmails(e: CalendarEvent, mail: EmailSummary[] = []): EmailSummary[] {
  const googleId = e.id.includes(':') ? e.id.slice(e.id.lastIndexOf(':') + 1) : e.id;
  const base = googleId.replace(/_\d{8}(T\d{6}Z?)?$/, '');
  const title = e.title.toLowerCase().replace(/^(invitation|updated invitation):\s*/i, '').trim();
  return mail.filter((m) => {
    const inv = m.invite;
    if (inv?.eventId && (inv.eventId === googleId || inv.eventId === base || googleId.startsWith(`${inv.eventId}_`))) return true;
    if (inv?.uid && e.uid && inv.uid === e.uid) return true;
    return title.length >= 6 && m.subject.toLowerCase().includes(title);
  });
}

/** Lines for FACTS about one event (compact: small local models read this too). */
export function eventDetailFacts(e: CalendarEvent, mail: EmailSummary[] = [], d?: Dossier): string[] {
  const out: string[] = [];
  const about = d?.about || firstSentences(e.description, 2, 220);
  if (about) out.push(`WHAT IT IS ABOUT: ${about}`);
  const people = peopleWords(e);
  if (people) out.push(`WHO: ${people}${e.guests && e.guests > 1 ? ` (${e.guests} invited)` : ''}.`);
  const notes: string[] = [];
  if (e.invitation) notes.push(`${e.organizer ?? 'someone'} invited the listener and they have not answered yet`);
  else if (e.myResponse === 'tentative') notes.push('the listener said maybe');
  if (e.video) notes.push(`it is a ${e.video.provider} call (never read the link)`);
  if (e.recurrence) notes.push(`it repeats ${e.recurrence}`);
  if (e.attachments?.length) notes.push(`attached: ${e.attachments.slice(0, 2).join(', ')}`);
  if (notes.length) out.push(`ALSO: ${notes.join('; ')}.`);
  // a holiday or other subscribed calendar: the hosts may mention the day, never a to-do for it
  const prep = d?.prepare?.length && !subscribedOnly(e) ? d.prepare.slice(0, 2).join('; ') : '';
  if (prep) out.push(`TO PREPARE: ${prep}.`);
  else {
    const m = linkedEmails(e, mail).find((x) => x.body && !x.invite);
    if (m) out.push(`RELATED EMAIL from ${m.from}: ${firstSentences(m.body, 2, 200)}`);
  }
  return out;
}

export function emailDetailFacts(m: EmailSummary, d?: Dossier): string[] {
  const out: string[] = [];
  const gist = d?.about || firstSentences(m.body, 2, 220);
  if (gist) out.push(`WHAT IT SAYS: ${gist}`);
  if (m.invite) out.push(`It is a calendar ${m.invite.method === 'cancel' ? 'cancellation' : m.invite.method === 'reply' ? `answer (${m.invite.answer ?? 'replied'})` : 'invitation'}${m.invite.title ? ` for ${m.invite.title}` : ''}.`);
  if (m.threadSize && m.threadSize > 2) out.push(`It is part of a conversation of ${m.threadSize} messages.`);
  if (d?.prepare?.length) out.push(`TO DO: ${d.prepare.slice(0, 2).join('; ')}.`);
  return out;
}

export function newsDetailFacts(d?: Dossier): string[] {
  return d?.by === 'ai' && d.about ? [`WHAT THE ARTICLE SAYS: ${d.about}`] : [];
}

// ---- the scripted dossier: made from the item's own fields, no network --------------------------------------------

export function eventVersion(e: CalendarEvent): string {
  return String(e.updated ?? `${e.start}|${e.title}|${e.description?.length ?? 0}|${e.guests ?? 0}`);
}

export function scriptedEventDossier(e: CalendarEvent, mail: EmailSummary[] = [], now = Date.now()): Dossier {
  const linked = linkedEmails(e, mail);
  const about =
    firstSentences(e.description, 2, 240) ||
    [e.recurrence ? `A ${e.recurrence} event` : 'An event', e.calendar ? `on the ${e.calendar} calendar` : '', e.location ? `at ${e.location}` : ''].filter(Boolean).join(' ') + '.';
  const who = [
    ...(e.organizer ? [`${e.organizer} (organizer)`] : []),
    ...(e.attendees ?? []).filter((a) => !a.self && !a.organizer).slice(0, 8).map((a) => `${a.name} (${ANSWER[a.status]})`),
  ];
  const prepare = [...(e.attachments ?? []).slice(0, 3).map((t) => `Look at ${t}`)];
  const questions: string[] = [];
  if (e.invitation) questions.push('The invitation is not answered yet.');
  if (!e.description && !linked.length) questions.push('The event has no description.');
  return {
    key: `calendar:${e.id}`,
    version: eventVersion(e),
    kind: 'calendar',
    title: e.title,
    about,
    ...(who.length ? { who } : {}),
    ...(prepare.length ? { prepare } : {}),
    links: [...(e.video ? [{ url: e.video.url, label: e.video.provider }] : []), ...(e.links ?? []).slice(0, 3), ...(e.link ? [{ url: e.link, label: 'Open in calendar' }] : [])],
    ...(questions.length ? { questions } : {}),
    sources: ['The calendar event', ...linked.slice(0, 2).map((m) => `Email from ${m.from}`)],
    by: 'scripted',
    at: now,
  };
}

export function scriptedEmailDossier(m: EmailSummary, now = Date.now()): Dossier {
  return {
    key: `email:${m.id}`,
    version: m.id,
    kind: 'email',
    title: m.subject,
    about: firstSentences(m.body || m.snippet, 2, 240) || `A message from ${m.from}.`,
    who: [m.from],
    ...(m.links?.length ? { links: m.links.slice(0, 3) } : {}),
    sources: ['The email'],
    by: 'scripted',
    at: now,
  };
}

export function scriptedNewsDossier(h: Headline, now = Date.now()): Dossier {
  return { key: h.id, version: h.id, kind: 'news', title: h.title, about: `${h.source} headline: ${h.title}.`, ...(h.url ? { links: [{ url: h.url, label: h.source }] } : {}), sources: ['The headline'], by: 'scripted', at: now };
}

/** Every item the research desk looks at, with its version: events in the next 36 hours, important mail, the top headlines. */
export interface ResearchItem {
  key: string;
  version: string;
  kind: Dossier['kind'];
  title: string;
  /** what is already known, for the model (compact JSON) */
  known: string;
  /** higher first */
  priority: number;
  scripted: Dossier;
}

const HOUR = 3_600_000;

export function researchItems(packet: Pick<ContextPacket, 'calendar' | 'email' | 'news'>, now = Date.now()): ResearchItem[] {
  const out: ResearchItem[] = [];
  const mail = packet.email ?? [];
  for (const e of packet.calendar ?? []) {
    if (e.start > now + 36 * HOUR || (e.end ?? e.start + HOUR) < now) continue;
    const linked = linkedEmails(e, mail);
    const known = {
      id: e.id,
      title: e.title,
      start: e.allDay ? new Date(e.start).toDateString() : new Date(e.start).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      ...(e.allDay ? { allDay: true } : {}),
      ...Object.fromEntries((['location', 'calendar', 'description', 'organizer', 'guests', 'attendees', 'myResponse', 'invitation', 'attachments', 'recurrence', 'links'] as const).filter((k) => e[k] !== undefined).map((k) => [k, e[k]])),
      ...(e.video ? { video: e.video.provider } : {}),
      ...(linked.length ? { relatedEmails: linked.slice(0, 2).map((m) => ({ id: m.id, from: m.from, subject: m.subject, text: (m.body ?? m.snippet ?? '').slice(0, 400) })) } : {}),
    };
    const soon = e.start - now < 6 * HOUR ? 20 : 0;
    out.push({ key: `calendar:${e.id}`, version: eventVersion(e), kind: 'calendar', title: e.title, known: JSON.stringify(known), priority: 60 + soon + (e.invitation ? 25 : 0) + (e.description || e.guests ? 10 : 0) - (e.allDay ? 30 : 0) - (subscribedOnly(e) ? 30 : 0), scripted: scriptedEventDossier(e, mail, now) });
  }
  for (const m of mail.slice(0, 6)) {
    if (!m.important && !m.invite) continue;
    const known = { id: m.id, from: m.from, subject: m.subject, at: new Date(m.at).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }), ...(m.body ? { text: m.body } : m.snippet ? { snippet: m.snippet } : {}), ...(m.threadSize ? { messagesInThread: m.threadSize } : {}), ...(m.invite ? { invitation: m.invite } : {}), ...(m.links?.length ? { links: m.links } : {}) };
    out.push({ key: `email:${m.id}`, version: m.id, kind: 'email', title: m.subject, known: JSON.stringify(known), priority: m.invite ? 40 : 50, scripted: scriptedEmailDossier(m, now) });
  }
  for (const h of (packet.news ?? []).slice(0, 2)) {
    if (!h.url) continue;
    out.push({ key: h.id, version: h.id, kind: 'news', title: h.title, known: JSON.stringify({ id: h.id, title: h.title, source: h.source }), priority: 30, scripted: scriptedNewsDossier(h, now) });
  }
  return out.sort((a, b) => b.priority - a.priority);
}
