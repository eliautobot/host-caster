import { create } from 'zustand';
import { hostChat, liveCall, type ChatState, type LiveCallState } from '@/core/call';

/** Mirrors core/call liveCall.state for React. Call liveCall.* directly for actions. */
export const useLiveCall = create<LiveCallState>(() => liveCall.state);
/** Mirrors core/call hostChat.state. */
export const useHostChat = create<ChatState>(() => hostChat.state);

let started = false;
export function startCallStores(): void {
  if (started) return;
  started = true;
  liveCall.on((s) => useLiveCall.setState(s, true));
  hostChat.on((s) => useHostChat.setState(s, true));
  void hostChat.load();
}

// started on first import (the call layer is in the app shell)
startCallStores();
