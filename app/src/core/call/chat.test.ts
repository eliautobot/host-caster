import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, unknown>();
const asked: { said: string; history: string[] }[] = [];
let reply: (said: string) => { lines: { hostId: string; text: string }[]; actionId?: string; remembered?: string } = (said) => ({ lines: [{ hostId: 'maya', text: `Sure, about ${said}. That is all I know.` }] });

vi.mock('../db', () => ({
  getSettings: async () => ({ activeStationId: 'st' }),
  getStation: async () => ({ id: 'st', name: 'Test FM', hostIds: ['maya'] }),
  kvGet: async (k: string) => (kv.has(k) ? { key: k, value: kv.get(k) } : undefined),
  kvSet: async (k: string, v: unknown) => void kv.set(k, v),
}));
vi.mock('../radio', () => ({ radio: { state: { stationId: 'st' }, requestSong: async () => undefined, musicHooks: () => undefined, nowPlaying: undefined } }));
vi.mock('../context/context', () => ({ summarize: () => undefined }));
vi.mock('./brain', () => ({
  hostsBrain: async () => ({
    lead: { id: 'maya', name: 'Maya' },
    reply: async (said: string, history: { text: string }[]) => {
      asked.push({ said, history: history.map((h) => h.text) });
      return reply(said);
    },
  }),
}));

const { hostChat } = await import('./chat');
const { chatNoteForAir } = await import('./onair');

describe('the hosts chat', () => {
  beforeEach(() => {
    hostChat.clear();
    asked.length = 0;
    kv.clear();
    hostChat.setOpen(true);
  });

  it('a message gets an answer right away, with the thread so far', async () => {
    await hostChat.send('hello there');
    await hostChat.send('what is next?');
    const m = hostChat.state.messages;
    expect(m.map((x) => x.who)).toEqual(['you', 'host', 'you', 'host']);
    expect(m[1]!.text).toMatch(/about hello there/);
    expect(m.every((x) => !x.pending)).toBe(true);
    expect(asked[1]!.history).toContain('hello there');
    expect(asked[1]!.history.at(-1)).toBe('what is next?');
    expect(hostChat.state.lastReplyMs).toBeGreaterThanOrEqual(0);
  });

  it('the thread is kept for the session (kv) and the unread count grows while closed', async () => {
    hostChat.setOpen(false);
    await hostChat.send('one');
    expect(hostChat.state.unread).toBe(1);
    hostChat.setOpen(true);
    expect(hostChat.state.unread).toBe(0);
    const saved = kv.get('chat:thread') as { messages: { text: string }[] };
    expect(saved.messages.map((x) => x.text)).toContain('one');
  });

  it('an action question puts its card on the last host message; a memory is noted', async () => {
    reply = () => ({ lines: [{ hostId: 'maya', text: 'Sure.' }, { hostId: 'maya', text: 'Just to check: add Dentist? Just say yes or no.' }], actionId: 'a1', remembered: 'You like jazz' });
    await hostChat.send('add dentist friday at 3');
    const host = hostChat.state.messages.filter((x) => x.who === 'host');
    expect(host.length).toBe(2);
    expect(host[0]!.actionId).toBeUndefined();
    expect(host[1]!.actionId).toBe('a1');
    expect(host[1]!.remembered).toBe('You like jazz');
  });

  it('"Hosts may mention our chat on air": off by default, on gives the newest message once', async () => {
    await hostChat.send('my sister got a new job');
    expect(await chatNoteForAir()).toBeUndefined();
    await hostChat.setOnAir(true);
    expect(await chatNoteForAir()).toMatch(/my sister got a new job/);
    expect(await chatNoteForAir()).toBeUndefined();
  });
});
