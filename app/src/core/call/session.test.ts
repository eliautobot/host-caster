import { describe, expect, it } from 'vitest';
import { FakeEars } from './fakeEars';
import { CallSession, isEcho, MicBlocked, type CallBrain, type CallDeps, type Ears, type HostLine, type Mouth, type TurnReply } from './session';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await wait(5);
  }
}

/** the call waits for the listener's turn (not the listening that runs while a host speaks) */
const turn = (s: CallSession, ears: FakeEars) => until(() => s.state.status === 'listening' && ears.listening);

const L = (text: string, hostId = 'maya'): HostLine => ({ hostId, text });

function brain(replies: (said: string, opts: { signal: AbortSignal; onLookup: () => void }) => Promise<TurnReply> | TurnReply = (s) => ({ lines: [L(`You said ${s}.`)] })): CallBrain & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lead: { id: 'maya', name: 'Maya' },
    greeting: () => [L("Hey Sam, you're on Test FM. What's up?")],
    reply: async (said, _h, opts) => {
      asked.push(said);
      return replies(said, opts);
    },
    holdLine: () => L('One sec, let me pull that up.'),
    stillThere: () => L('Sam, you still there?'),
    wrapUp: () => L("Sounds like you stepped away. I'll let you go."),
    signOff: () => L('Thanks for calling, Sam. Back to the music!'),
    limitWarning: (m) => L(`About ${m} minutes left.`),
    limit: () => L("That's our time."),
  };
}

function mouth(msPerLine = 30): Mouth & { said: string[]; stops: number } {
  let cur: (() => void) | undefined;
  const m = {
    said: [] as string[],
    stops: 0,
    async say(lines: HostLine[], opts: { signal: AbortSignal; onLine: (l: HostLine) => void }) {
      for (const l of lines) {
        if (opts.signal.aborted) return;
        opts.onLine(l);
        m.said.push(l.text);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, msPerLine);
          cur = () => {
            clearTimeout(t);
            resolve();
          };
          opts.signal.addEventListener('abort', cur);
        });
      }
    },
    stop() {
      m.stops++;
      cur?.();
    },
  };
  return m;
}

function setup(over: Partial<CallDeps> & { ears?: Ears } = {}) {
  const music = { held: 0, resumed: 0, async hold() {
    this.held++;
  }, async resume() {
    this.resumed++;
  } };
  const ears = (over.ears as FakeEars) ?? new FakeEars({ step: 5 });
  const b = (over.brain as ReturnType<typeof brain>) ?? brain();
  const m = (over.mouth as ReturnType<typeof mouth>) ?? mouth();
  const rang: number[] = [];
  const s = new CallSession({
    brain: b,
    ears,
    mouth: m,
    music,
    ring: async () => {
      rang.push(Date.now());
      await wait(20);
    },
    limits: { stillThereMs: 400, wrapUpMs: 400, holdAfterMs: 60, ...over.limits },
    ...(over.onEnd ? { onEnd: over.onEnd } : {}),
  });
  return { s, ears, b, m, music, rang };
}

describe('live call state machine', () => {
  it('rings, picks up with the greeting, holds the music, and listens', async () => {
    const { s, m, music, rang } = setup();
    const statuses: string[] = [];
    s.on((st) => statuses.at(-1) !== st.status && statuses.push(st.status));
    const done = s.start();
    await until(() => s.state.status === 'listening');
    expect(music.held).toBe(1);
    expect(rang.length).toBe(1);
    expect(m.said[0]).toMatch(/you're on Test FM/);
    expect(s.state.startedAt).toBeDefined();
    expect(s.state.metrics.pickupMs).toBeLessThan(500);
    expect(statuses.slice(0, 3)).toEqual(['ringing', 'speaking', 'listening']);
    await s.hangUp();
    await done;
  });

  it('listen -> think -> speak -> listen, with captions of both sides', async () => {
    const { s, ears, b } = setup();
    void s.start();
    await turn(s, ears);
    const partials: string[] = [];
    s.on((st) => st.partial && partials.push(st.partial));
    await ears.hear("what's on my calendar tomorrow");
    await until(() => s.state.lines.some((l) => l.who === 'host' && /You said/.test(l.text)));
    await until(() => s.state.status === 'listening');
    expect(b.asked).toEqual(["what's on my calendar tomorrow"]);
    expect(partials).toContain("what's on");
    expect(s.state.lines.map((l) => l.who)).toEqual(['host', 'you', 'host']);
    expect(s.state.metrics.turns[0]!.replyMs).toBeGreaterThanOrEqual(0);
    await s.hangUp();
  });

  it('several turns in a row keep going until the listener hangs up', async () => {
    const { s, ears, b } = setup();
    void s.start();
    for (const said of ['hello there', 'remember I like jazz', 'play something upbeat']) {
      await turn(s, ears);
      await ears.hear(said);
      await until(() => b.asked.includes(said));
    }
    await until(() => s.state.status === 'listening');
    expect(b.asked.length).toBe(3);
    expect(s.state.status).toBe('listening');
    await s.hangUp();
    expect(s.state.status).toBe('ended');
  });

  it('hang up: one sign-off line, then the music comes back once', async () => {
    const { s, ears, m, music } = setup();
    const ends: string[] = [];
    void s.start();
    s.on((st) => st.status === 'ended' && ends.push(st.endedReason ?? ''));
    await turn(s, ears);
    await s.hangUp();
    await s.hangUp();
    expect(m.said.at(-1)).toMatch(/Thanks for calling/);
    expect(music.resumed).toBe(1);
    expect(s.state.endedReason).toBe('you');
    expect(ends).toEqual(['you']);
  });

  it('"thanks, that\'s it" ends the call like hanging up', async () => {
    const { s, ears, b, music, m } = setup();
    const done = s.start();
    await turn(s, ears);
    await ears.hear("thanks, that's it");
    await done;
    expect(b.asked).toEqual([]);
    expect(s.state.endedReason).toBe('goodbye');
    expect(m.said.at(-1)).toMatch(/Thanks for calling/);
    expect(music.resumed).toBe(1);
  });

  it('barge-in by voice: talking over the host stops them and becomes the next turn', async () => {
    const long = brain((said) => ({ lines: said === 'tell me a long story' ? [L('Once upon a time there was a radio.'), L('It played songs all day.'), L('The end of a very long story.')] : [L(`Short answer about ${said}.`)] }));
    const { s, ears, m, b } = setup({ brain: long, mouth: mouth(150) });
    void s.start();
    await turn(s, ears);
    await ears.hear('tell me a long story');
    await until(() => s.state.status === 'speaking' && /Once upon/.test(s.state.caption ?? ''));
    await until(() => ears.listening);
    const stops = m.stops;
    await ears.hear('wait what about tomorrow');
    await until(() => b.asked.includes('wait what about tomorrow'));
    expect(m.stops).toBeGreaterThan(stops);
    expect(m.said).not.toContain('The end of a very long story.');
    await s.hangUp();
  });

  it('the host does not stop for its own voice picked up by the mic (echo)', () => {
    expect(isEcho('once upon a time there', 'Once upon a time there was a radio.')).toBe(true);
    expect(isEcho('wait what about tomorrow', 'Once upon a time there was a radio.')).toBe(false);
  });

  it('barge-in by tapping the mic while the host speaks', async () => {
    const long = brain(() => ({ lines: [L('One.'), L('Two.'), L('Three.'), L('Four.')] }));
    const { s, ears, m } = setup({ brain: long, mouth: mouth(150), ears: new FakeEars({ overlap: false, step: 5 }) });
    void s.start();
    await turn(s, ears);
    await ears.hear('count to four');
    await until(() => s.state.caption === 'One.');
    s.talk();
    await until(() => s.state.status === 'listening');
    expect(m.said).not.toContain('Four.');
    await s.hangUp();
  });

  it('a slow lookup: the host holds the line, then answers', async () => {
    const slow = brain(async (said, opts) => {
      opts.onLookup();
      await wait(250);
      return { lines: [L(`Tomorrow you have the dentist at 3 (${said}).`)] };
    });
    const { s, ears, m } = setup({ brain: slow });
    void s.start();
    await turn(s, ears);
    await ears.hear("what's on my calendar tomorrow");
    await until(() => m.said.some((t) => /dentist/.test(t)));
    const hold = m.said.indexOf('One sec, let me pull that up.');
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(m.said.findIndex((t) => /dentist/.test(t)));
    await s.hangUp();
  });

  it('silence: "still there?" after the first quiet stretch, then a kind wrap-up and the music', async () => {
    const { s, m, music } = setup({ ears: new FakeEars({ step: 5 }) });
    const done = s.start();
    await done;
    expect(m.said).toContain('Sam, you still there?');
    expect(m.said.at(-1)).toMatch(/stepped away/);
    expect(s.state.endedReason).toBe('silence');
    expect(music.resumed).toBe(1);
  });

  it('a word after "still there?" keeps the call going', async () => {
    const { s, ears, b } = setup();
    void s.start();
    await until(() => s.state.lines.some((l) => /still there/.test(l.text)));
    await turn(s, ears);
    await ears.hear('yes sorry I am here');
    await until(() => b.asked.length === 1);
    await until(() => s.state.status === 'listening');
    expect(s.state.status).toBe('listening');
    await s.hangUp();
  });

  it('mute: nothing is heard until unmuted; typed words still reach the host', async () => {
    const { s, ears, b } = setup();
    void s.start();
    await turn(s, ears);
    s.toggleMute();
    expect(s.state.mic).toBe('muted');
    await until(() => !ears.listening);
    s.type('add milk to my list');
    await until(() => b.asked.includes('add milk to my list'));
    s.toggleMute();
    await until(() => s.state.mic === 'on' && ears.listening);
    await s.hangUp();
  });

  it('a refused microphone: the call goes on by typing', async () => {
    const blocked: Ears = { kind: 'web', overlap: false, listen: async () => Promise.reject(new MicBlocked('no')) };
    const { s, b } = setup({ ears: blocked });
    void s.start();
    await until(() => s.state.mic === 'blocked');
    s.type('hello');
    await until(() => b.asked.includes('hello'));
    await s.hangUp();
    expect(s.state.status).toBe('ended');
  });

  it('a failed brain: an honest "say that again", and the call goes on', async () => {
    const broken = brain(() => {
      throw new Error('boom');
    });
    const { s, ears, m } = setup({ brain: broken });
    void s.start();
    await turn(s, ears);
    await ears.hear('hello');
    await until(() => m.said.some((t) => /train of thought/.test(t)));
    await until(() => s.state.status === 'listening');
    await s.hangUp();
  });

  it('hang up while ringing: no greeting, no sign-off, the music comes back', async () => {
    const { s, m, music } = setup();
    const done = s.start();
    await s.hangUp();
    await done;
    expect(m.said).toEqual([]);
    expect(music.resumed).toBe(1);
  });

  it('length cap: a heads-up first, then the host ends the call', async () => {
    const { s, ears, m } = setup({ limits: { warnMs: 150, maxMs: 700, stillThereMs: 5000, wrapUpMs: 5000 } });
    const done = s.start();
    await turn(s, ears);
    await wait(200);
    await ears.hear('anything new');
    await until(() => m.said.some((t) => /minutes left/.test(t)));
    await done;
    expect(s.state.endedReason).toBe('limit');
    expect(m.said.at(-1)).toBe("That's our time.");
  });

  it('an action question: the call screen gets the card id, and it clears after the answer', async () => {
    let n = 0;
    const b = brain(() => (++n === 1 ? { lines: [L('Just to check: Dentist, Friday at 3 PM. Should I go ahead? Just say yes or no.')], actionId: 'a1' } : { lines: [L('Done.')] }));
    const { s, ears } = setup({ brain: b });
    void s.start();
    await turn(s, ears);
    await ears.hear('add dentist Friday at 3');
    await until(() => s.state.actionId === 'a1');
    await turn(s, ears);
    await ears.hear('yes');
    await until(() => s.state.lines.some((l) => l.text === 'Done.'));
    expect(s.state.actionId).toBeUndefined();
    await s.hangUp();
  });
});
