// core/call: live calls with the station (voice) and the hosts' chat (text).
export { liveCall, type LiveCallState } from './live';
export { hostChat, type ChatMessage, type ChatState } from './chat';
export { chatNoteForAir } from './onair';
export { clockOf, isGoodbye } from './phrases';
export type { CallLine, CallStatus, MicState } from './session';

// e2e hooks (debug builds only): fake ears so a test can "speak" into the call
if (typeof window !== 'undefined' && import.meta.env.VITE_HOSTCASTER_DEBUG === '1') {
  const w = window as unknown as { __hostcaster?: Record<string, unknown> };
  void Promise.all([import('./live'), import('./chat'), import('./ears'), import('./fakeEars')]).then(([live, chat, ears, fake]) => {
    const g = (w.__hostcaster ??= {});
    let current: InstanceType<typeof fake.FakeEars> | undefined;
    g.call = {
      live: live.liveCall,
      chat: chat.hostChat,
      /** from now on calls hear what hear(text) says (overlap: talking over a host stops them) */
      fakeEars(opts: { overlap?: boolean } = {}) {
        current = new fake.FakeEars({ overlap: opts.overlap ?? false, step: 60 });
        ears.useEars(current);
      },
      hear: (text: string) => current?.hear(text),
      listening: () => Boolean(current?.listening),
    };
  });
}
