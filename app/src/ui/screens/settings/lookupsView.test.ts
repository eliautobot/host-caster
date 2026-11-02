import { describe, expect, it } from 'vitest';
import type { Dossier } from '@/core/types';
import { NO_BRAIN_REASON, byLine, deskLine, linkLabel, lookupMeta, lookupWhat, lookupSwitch, pickDossier, sortLookups, webDescription, webSwitch } from './lookupsView';

const dossier = (over: Partial<Dossier> = {}): Dossier => ({
  key: 'calendar:e1',
  version: 'v1',
  kind: 'calendar',
  title: 'Team sync',
  about: 'Weekly sync.',
  sources: ['The calendar event'],
  by: 'scripted',
  at: 1000,
  ...over,
});

describe('lookupSwitch', () => {
  it('is on by default with a real AI brain, and follows the listener', () => {
    expect(lookupSwitch(undefined, true)).toEqual({ checked: true, disabled: false });
    expect(lookupSwitch({ enabled: false }, true)).toEqual({ checked: false, disabled: false });
  });
  it('is off and disabled with a reason when no host has a brain', () => {
    const s = lookupSwitch({ enabled: true }, false);
    expect(s).toMatchObject({ checked: false, disabled: true, reason: NO_BRAIN_REASON });
    expect(s.reason).not.toContain(String.fromCharCode(0x2014));
  });
  it('web follows the main switch', () => {
    const on = lookupSwitch(undefined, true);
    expect(webSwitch(undefined, on)).toEqual({ checked: true, disabled: false });
    expect(webSwitch({ web: false }, on)).toEqual({ checked: false, disabled: false });
    expect(webSwitch(undefined, lookupSwitch({ enabled: false }, true))).toEqual({ checked: false, disabled: true });
    expect(webDescription(true)).toMatch(/Host-Caster AI allowance/);
    expect(webDescription(false)).toMatch(/this server's search/);
  });
});

describe('pickDossier', () => {
  const item = { key: 'calendar:e1', version: 'v2', scripted: dossier({ version: 'v2' }) };
  it('takes the newest researched dossier at the item version', () => {
    const old = dossier({ version: 'v2', by: 'ai', at: 10, about: 'old' });
    const newer = dossier({ version: 'v2', by: 'ai', at: 20, about: 'new' });
    const otherVersion = dossier({ version: 'v1', by: 'ai', at: 30, about: 'stale' });
    expect(pickDossier(item, [old, otherVersion, newer]).about).toBe('new');
  });
  it('falls back to the scripted dossier', () => {
    expect(pickDossier(item, [dossier({ version: 'v1', by: 'ai' })])).toBe(item.scripted);
  });
});

describe('words', () => {
  it('says who looked into it, or where the words came from', () => {
    expect(byLine({ by: 'ai', hostName: 'Mia', kind: 'calendar' })).toBe('Looked into by Mia');
    expect(byLine({ by: 'scripted', kind: 'calendar' })).toBe('From the event itself');
    expect(byLine({ by: 'scripted', kind: 'email' })).toBe('From the email itself');
  });
  it('labels links by their label or site, never the raw address', () => {
    expect(linkLabel({ url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet' })).toBe('Google Meet');
    expect(linkLabel({ url: 'https://www.example.com/a/very/long/path?with=query' })).toBe('example.com');
    expect(linkLabel({ url: 'not a url' })).toBe('Link');
  });
  it('describes the research desk', () => {
    const items = [{ key: 'calendar:e1', version: 'v1', title: 'Team sync' }];
    expect(deskLine({ running: 'calendar:e1@v1', queued: 2 }, items)).toBe('Looking into Team sync. 2 more waiting');
    expect(deskLine({ queued: 3 }, items)).toBe('3 waiting to be looked into');
    expect(deskLine({ queued: 0 }, items)).toBeUndefined();
  });
  it('writes the lookup line', () => {
    expect(lookupMeta({ host: 'Mia', purpose: 'call-in' }, '5 min ago')).toBe('Mia, answering your call-in · 5\u00a0min\u00a0ago');
    expect(lookupMeta({ purpose: 'research' }, 'now')).toBe('Getting ready for your day · now');
    expect(lookupMeta({}, 'now')).toBe('now');
  });
  it('splits a failed lookup into what and why', () => {
    expect(lookupWhat({ what: 'open link (did not work: This page needs a sign-in.)', ok: false })).toEqual({ title: 'Open link', reason: 'This page needs a sign-in.' });
    expect(lookupWhat({ what: 'Email: "Budget" from Dana', ok: true })).toEqual({ title: 'Email: "Budget" from Dana' });
    expect(lookupWhat({ what: 'web search', ok: false })).toEqual({ title: 'Web search' });
    expect(lookupWhat({ what: 'weather (did not work)', ok: false })).toEqual({ title: 'Weather' });
  });
  it('sorts newest first and drops repeats', () => {
    const a = { at: 1000, tool: 'weather', what: 'Weather: Chicago', ok: true };
    const b = { at: 5000, tool: 'web_search', what: 'Web search: "x"', ok: true };
    expect(sortLookups([a, b, { ...a, where: 'device' as const }]).map((l) => l.at)).toEqual([5000, 1000]);
  });
});
