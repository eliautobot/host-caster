import { describe, expect, it } from 'vitest';
import type { Host } from '../types';
import { actionsSheet, callSystem, replyLines, transcript } from './brain';

const host = (id: string, name: string) => ({ id, name, topics: [], catchphrases: [], avoid: [], energy: 3, humor: 3, verbosity: 2 }) as unknown as Host;
const maya = host('maya', 'Maya');
const jules = host('jules', 'Jules');

describe("the hosts' side of a call", () => {
  it('reply lines: the lead by default, a "Name:" line for the co-host, labels and stage directions dropped', () => {
    expect(replyLines('Maya: Sure thing, Sam!\nJules: And I approve. *laughs*', maya, [maya, jules])).toEqual([
      { hostId: 'maya', text: 'Sure thing, Sam!' },
      { hostId: 'jules', text: 'And I approve.' },
    ]);
    expect(replyLines('Tomorrow you have the dentist at 3.\nThat is it.', maya, [maya, jules])).toEqual([{ hostId: 'maya', text: 'Tomorrow you have the dentist at 3. That is it.' }]);
    expect(replyLines('', maya, [maya])).toEqual([]);
  });

  it('the real status of what the hosts offered to do: never "done" unless it is', () => {
    const sheet = actionsSheet([
      { summary: 'Add "Lunch with Sam" to your Google Calendar on Saturday', status: 'cancelled' },
      { summary: 'Add "Dentist" to your Google Calendar on Friday', status: 'done' },
      { summary: 'Add "Gym" to your Google Calendar on Monday', status: 'proposed' },
    ]);
    expect(sheet).toMatch(/Lunch with Sam.*NOT done \(the listener said no\)/);
    expect(sheet).toMatch(/Dentist.*: done/);
    expect(sheet).toMatch(/Gym.*NOT done/);
    expect(actionsSheet([])).toBe('');
    expect(callSystem('text', { name: 'Test FM' } as never, maya, 'Sam')).toMatch(/Never say something was added, booked/);
  });

  it('the conversation so far, newest last, with names', () => {
    const t = transcript(
      [
        { id: 1, who: 'host', hostId: 'maya', text: 'Hey Sam!', at: 1 },
        { id: 2, who: 'you', text: 'hi', at: 2 },
      ],
      new Map([['maya', 'Maya']]),
      'Sam',
    );
    expect(t).toBe('Maya: Hey Sam!\nSam: hi');
  });

  it('voice and chat prompts: short spoken turns vs short texts, the call never ended by the host', () => {
    const v = callSystem('voice', { name: 'Test FM' } as never, maya, 'Sam', jules);
    expect(v).toMatch(/live on the phone/);
    expect(v).toMatch(/Never say goodbye or end the call yourself/);
    expect(v).toMatch(/co-host Jules/);
    expect(callSystem('text', { name: 'Test FM' } as never, maya, 'Sam')).toMatch(/no em dashes/);
  });
});
