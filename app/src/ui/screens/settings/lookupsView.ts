// Pure helpers for the lookups parts of "What your hosts can see": the switch state, the research desk line, the
// dossier shown for each item, link labels and the Lookups list words. No React, no storage: unit tested.
import type { ResearchItem } from '@/core/agent/brief';
import type { Lookup } from '@/core/agent/lookups';
import type { DeskStatus } from '@/core/agent/research';
import type { Connections, Dossier, LinkRef } from '@/core/types';

export interface LookupSwitch {
  /** what the switch shows */
  checked: boolean;
  disabled: boolean;
  /** why it is off and cannot be turned on */
  reason?: string;
}

export const NO_BRAIN_REASON = "Your hosts read scripted lines, so they don't look things up. Give a host an AI brain in Hosts.";

/** On by default when a host on the station has a real AI brain; off and disabled when none has. */
export function lookupSwitch(lookups: Connections['lookups'], hasBrain: boolean): LookupSwitch {
  if (!hasBrain) return { checked: false, disabled: true, reason: NO_BRAIN_REASON };
  return { checked: lookups?.enabled !== false, disabled: false };
}

/** The web switch: on unless turned off, and only when looking things up is on. */
export function webSwitch(lookups: Connections['lookups'], main: LookupSwitch): { checked: boolean; disabled: boolean } {
  return { checked: main.checked && lookups?.web !== false, disabled: !main.checked };
}

export function webDescription(online: boolean): string {
  return online ? 'Uses your Host-Caster AI allowance. Only the search words are sent.' : "Uses this server's search. Only the search words are sent.";
}

/** The item's dossier at its current version (the newest one researched), else the one made from its own fields. */
export function pickDossier(item: Pick<ResearchItem, 'key' | 'version' | 'scripted'>, dossiers: Dossier[]): Dossier {
  let best: Dossier | undefined;
  for (const d of dossiers) {
    if (d.key !== item.key || d.version !== item.version) continue;
    if (!best || d.at > best.at) best = d;
  }
  return best ?? item.scripted;
}

/** "Looked into by Mia" or where the words came from. */
export function byLine(d: Pick<Dossier, 'by' | 'hostName' | 'kind'>): string {
  if (d.by === 'ai') return d.hostName ? `Looked into by ${d.hostName}` : 'Looked into by your host';
  return d.kind === 'email' ? 'From the email itself' : d.kind === 'news' ? 'From the headline itself' : 'From the event itself';
}

/** A link's label, or the site's name; never a long raw address. */
export function linkLabel(l: LinkRef): string {
  const label = l.label?.trim();
  if (label) return label;
  try {
    const host = new URL(l.url).hostname.replace(/^www\./, '');
    return host || 'Link';
  } catch {
    return 'Link';
  }
}

/** What the research desk is doing, in a few words; undefined when it is idle. */
export function deskLine(status: Pick<DeskStatus, 'running' | 'queued'>, items: Pick<ResearchItem, 'key' | 'version' | 'title'>[]): string | undefined {
  const waiting = status.queued > 0 ? `${status.queued} more waiting` : '';
  if (status.running) {
    const item = items.find((i) => `${i.key}@${i.version}` === status.running);
    const what = item ? `Looking into ${item.title}` : 'Looking into something coming up';
    return waiting ? `${what}. ${waiting}` : what;
  }
  return status.queued > 0 ? `${status.queued} waiting to be looked into` : undefined;
}

const PURPOSE: Record<string, string> = {
  research: 'getting ready for your day',
  'call-in': 'answering your call-in',
  question: 'answering your AI app',
};

const capital = (t: string) => t.replace(/^./, (c) => c.toUpperCase());

/** The small line under a lookup: who, why and when (the time never splits over two lines). */
export function lookupMeta(l: Pick<Lookup, 'host' | 'purpose'>, when: string): string {
  const why = l.purpose ? (PURPOSE[l.purpose] ?? l.purpose) : '';
  const who = l.host ? `${l.host}${why ? `, ${why}` : ''}` : capital(why);
  return [who, when.replace(/ /g, '\u00a0')].filter(Boolean).join(' · ');
}

/** What was read, as a title; a failed lookup ("open link (did not work: the reason)", "weather (did not work)") gets
 * its reason apart. */
export function lookupWhat(l: Pick<Lookup, 'what' | 'ok'>): { title: string; reason?: string } {
  const m = /^(.+?) \(did not work(?:: (.+?))?\)?$/.exec(l.what);
  if (!l.ok && m) return { title: capital(m[1]!.trim()), ...(m[2] ? { reason: m[2].trim() } : {}) };
  return { title: capital(l.what.trim()) };
}

/** Newest first, and each lookup once (the device's own copy and the account's can both list one). */
export function sortLookups(list: Lookup[]): Lookup[] {
  const seen = new Set<string>();
  return [...list]
    .sort((a, b) => b.at - a.at)
    .filter((l) => {
      const k = `${l.tool}|${l.what}|${Math.round(l.at / 1000)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
