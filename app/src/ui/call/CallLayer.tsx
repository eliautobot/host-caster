import { useEffect } from 'react';
import { memoryEvents } from '@/core/memory/store';
import { toast } from '../components';
import { CallScreen } from './CallScreen';
import { ChatPanel } from './ChatPanel';

/** The live call screen and the hosts' chat, over every page (mounted once in the app shell). */
export function CallLayer() {
  // what a call or a chat taught the hosts: a quiet note
  useEffect(
    () =>
      memoryEvents.on('change', ({ card, added }) => {
        if (added && card?.source === 'callin') toast({ title: 'Remembered', description: card.text });
      }),
    [],
  );
  return (
    <>
      <ChatPanel />
      <CallScreen />
    </>
  );
}
