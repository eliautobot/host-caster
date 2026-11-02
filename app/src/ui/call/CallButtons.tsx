import { MessageCircle, Phone } from 'lucide-react';
import { hostChat, liveCall } from '@/core/call';
import { useHostChat, useLiveCall } from '@/state/call';
import { Button, IconButton, cx } from '../components';
import './call.css';

/** Starts a call (the call screen opens at once and shows any problem). */
export function startCall(): void {
  void liveCall.start();
}

export function openChat(): void {
  hostChat.setOpen(true);
}

function Unread({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="aw-unread" aria-label={`${n} new ${n === 1 ? 'message' : 'messages'}`}>
      {n > 9 ? '9+' : n}
    </span>
  );
}

/**
 * The two ways to reach the hosts: Call (a live voice call, the music pauses) and Message (a chat, the music plays).
 * sheet = Now Playing's on-air strip, icons = the player bar and the mini player, hero = Home.
 */
export function CallButtons({ variant = 'sheet', className }: { variant?: 'sheet' | 'icons' | 'hero'; className?: string }) {
  const unread = useHostChat((s) => s.unread);
  const inCall = useLiveCall((s) => s.open && s.status !== 'ended');
  if (variant === 'icons') {
    return (
      <span className={cx('aw-callbtns aw-callbtns--icons', className)}>
        <IconButton icon={Phone} label="Call the station" size="sm" variant="solid" onClick={startCall} disabled={inCall} />
        <span className="aw-callbtns__badged">
          <IconButton icon={MessageCircle} label="Message the hosts" size="sm" variant="solid" onClick={openChat} />
          <Unread n={unread} />
        </span>
      </span>
    );
  }
  const size = variant === 'hero' ? 'lg' : 'sm';
  return (
    <span className={cx('aw-callbtns', `aw-callbtns--${variant}`, className)}>
      <Button size={size} variant="secondary" icon={Phone} onClick={startCall} disabled={inCall} className="aw-callbtns__call" aria-label="Call the station">
        <span className="aw-callbtns__long">{variant === 'hero' ? 'Call the station' : 'Call'}</span>
        <span className="aw-callbtns__short">Call</span>
      </Button>
      <span className="aw-callbtns__badged">
        <Button size={size} variant="secondary" icon={MessageCircle} onClick={openChat} className="aw-callbtns__msg" aria-label={unread ? `Message the hosts, ${unread} new` : 'Message the hosts'}>
          <span className="aw-callbtns__long">{variant === 'hero' ? 'Message the hosts' : 'Message'}</span>
          <span className="aw-callbtns__short">Message</span>
        </Button>
        <Unread n={unread} />
      </span>
    </span>
  );
}
