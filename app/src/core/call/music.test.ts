import { beforeEach, describe, expect, it, vi } from 'vitest';

const log: string[] = [];
const state = { status: 'playing' as string, other: true };

vi.mock('../player', () => ({
  player: {
    get state() {
      return { status: state.status };
    },
    duck: (l: number, ms: number) => log.push(`duck ${l} ${ms}`),
    unduck: (ms: number) => log.push(`unduck ${ms}`),
    pause: () => {
      log.push('pause');
      state.status = 'paused';
    },
    play: async () => {
      log.push('play');
      state.status = 'playing';
    },
  },
}));

vi.mock('../native', () => ({
  anyApp: {
    nowPlaying: async () => ({ key: 'x', title: 'Song', playing: state.other }),
    control: async (a: string) => {
      log.push(`other ${a}`);
      return true;
    },
  },
  audioFocus: {
    hold: async () => {
      log.push('focus hold');
      return 'granted';
    },
    releaseHold: async () => {
      log.push('focus release');
    },
  },
}));

const { callMusic } = await import('./music');

describe('the music during a call', () => {
  beforeEach(() => {
    log.length = 0;
    state.status = 'playing';
    state.other = true;
  });

  it('own music: a quick fade, a pause, then play with a fade-in where it was', async () => {
    const m = callMusic(() => ({ anyApp: false }));
    await m.hold();
    expect(log).toEqual(['duck 0 280', 'pause', 'unduck 0']);
    expect(state.status).toBe('paused');
    log.length = 0;
    await m.resume();
    expect(log).toEqual(['duck 0 0', 'play', 'unduck 900']);
    expect(state.status).toBe('playing');
  });

  it('own music that was already paused stays paused after the call', async () => {
    state.status = 'paused';
    const m = callMusic(() => ({ anyApp: false }));
    await m.hold();
    await m.resume();
    expect(log).toEqual([]);
    expect(state.status).toBe('paused');
  });

  it('any-app mode: the other app pauses, Host-Caster holds the focus, then gives it back and presses play', async () => {
    const m = callMusic(() => ({ anyApp: true }));
    await m.hold();
    expect(log).toEqual(['other pause', 'focus hold']);
    log.length = 0;
    await m.resume();
    expect(log).toEqual(['focus release', 'other play']);
  });

  it('any-app mode: an app that was not playing is not started after the call', async () => {
    state.other = false;
    const m = callMusic(() => ({ anyApp: true }));
    await m.hold();
    await m.resume();
    expect(log).toEqual(['focus hold', 'focus release']);
  });

  it('resume only undoes hold once', async () => {
    const m = callMusic(() => ({ anyApp: false }));
    await m.hold();
    await m.resume();
    log.length = 0;
    await m.resume();
    expect(log).toEqual([]);
  });
});
