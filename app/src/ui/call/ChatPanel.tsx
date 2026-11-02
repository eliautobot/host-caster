import { useEffect, useRef, useState } from 'react';
import { BookHeart, MessageCircle, Search, Send, X } from 'lucide-react';
import type { ActionRecord } from '@/core/actions';
import { hostChat, type ChatMessage } from '@/core/call';
import { useHostChat } from '@/state/call';
import { useHosts } from '@/state/hosts';
import { useActiveStation } from '@/state/stations';
import { useTracker } from '@/state/tracker';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { ActionCard } from '../actions/ActionCard';
import { Avatar, AvatarStack, Chip, IconButton, Link, Sheet, TextArea, Toggle, cx } from '../components';
import { lineup } from '../screens/parts/StationCard';
import './call.css';

const IDEAS = ["How's my day looking?", 'Play something upbeat next', 'Remember that I like jazz', 'Remind me to call Mom at 6'];

/** An action's Yes/No card; it arrives after its message, so it scrolls itself into view once. */
function NewCard({ action }: { action: ActionRecord }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);
  return (
    <div ref={box}>
      <ActionCard action={action} className="aw-chat__action" />
    </div>
  );
}

function Thread({ messages }: { messages: ChatMessage[] }) {
  const hosts = useHosts((h) => h.hosts);
  const lookingUp = useHostChat((s) => s.lookingUp);
  const pending = useTracker((t) => t.pending);
  const refreshPending = useTracker((t) => t.refreshPending);
  // the cards stay with their message after the yes or no (the card shows what happened)
  const [cards, setCards] = useState<Record<string, ActionRecord>>({});
  const asked = messages.filter((m) => m.actionId).map((m) => m.actionId!).join(',');
  useEffect(() => {
    if (asked) void refreshPending();
  }, [asked, refreshPending]);
  useEffect(() => {
    if (pending && asked.split(',').includes(pending.id) && !cards[pending.id]) setCards((c) => ({ ...c, [pending.id]: pending }));
  }, [pending, asked, cards]);
  return (
    <>
      {messages.map((m) => {
        const h = m.who === 'host' ? hosts.find((x) => x.id === m.hostId) : undefined;
        const card = m.actionId ? cards[m.actionId] : undefined;
        return (
          <div key={m.id} className={cx('aw-chat__msg', `aw-chat__msg--${m.who}`)}>
            {m.who === 'host' && <span className="aw-chat__avatar">{h && <Avatar avatar={h.avatar} name={h.name} size={28} />}</span>}
            <div className="aw-chat__body">
              {m.who === 'host' && <span className="aw-chat__name">{h?.name ?? 'Host'}</span>}
              {m.pending && !m.text ? (
                <span className="aw-chat__bubble aw-chat__typing" aria-label={`${h?.name ?? 'The host'} is typing`}>
                  {lookingUp ? (
                    <span className="aw-chat__looking">
                      <Search aria-hidden /> Looking it up...
                    </span>
                  ) : (
                    <span className="aw-chat__dots" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </span>
              ) : (
                <span className="aw-chat__bubble">{m.text}</span>
              )}
              {m.notice && <span className="aw-chat__notice">{m.notice}</span>}
              {m.remembered && (
                <span className="aw-chat__remembered" role="status">
                  <BookHeart aria-hidden />
                  <span>
                    Remembered: {m.remembered}.{' '}
                    <Link to="/settings/memory" onClick={() => hostChat.setOpen(false)}>
                      See what your hosts remember
                    </Link>
                  </span>
                </span>
              )}
              {card && <NewCard key={card.id} action={card} />}
            </div>
          </div>
        );
      })}
    </>
  );
}

function ChatBody({ onClose, side }: { onClose: () => void; side: boolean }) {
  const s = useHostChat();
  const station = useActiveStation();
  const all = useHosts((h) => h.hosts);
  const hosts = station ? lineup(all, station.hostIds) : [];
  const names = hosts.map((h) => h.name).join(' & ') || 'your hosts';
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const last = s.messages.at(-1);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [s.messages.length, last?.text.length]);
  const send = (msg = text) => {
    if (!msg.trim()) return;
    void hostChat.send(msg);
    setText('');
  };
  return (
    <div className={cx('aw-chat', side && 'aw-chat--side')}>
      {side && (
        <header className="aw-chat__head">
          {hosts.length > 0 && <AvatarStack people={hosts} size={30} />}
          <span className="aw-chat__title">
            <strong>Message the hosts</strong>
            <span className="aw-truncate">{names}</span>
          </span>
          <IconButton icon={X} label="Close the chat" onClick={onClose} />
        </header>
      )}
      <div className="aw-chat__log" ref={log} role="log" aria-label="Chat with the hosts">
        {s.messages.length === 0 ? (
          <div className="aw-chat__empty">
            <MessageCircle aria-hidden />
            <p>
              Write to {names}. They answer right away, and the music keeps playing.
            </p>
            <div className="aw-chat__ideas">
              {IDEAS.map((i) => (
                <Chip key={i} size="sm" onClick={() => send(i)}>
                  {i}
                </Chip>
              ))}
            </div>
          </div>
        ) : (
          <Thread messages={s.messages} />
        )}
      </div>
      <form
        className="aw-chat__compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <TextArea
          aria-label="Message"
          className="aw-chat__input"
          placeholder={`Message ${hosts[0]?.name ?? 'the hosts'}...`}
          value={text}
          onChange={setText}
          rows={1}
          autoResize
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <IconButton icon={Send} label="Send" variant="primary" type="submit" disabled={!text.trim()} />
      </form>
      <div className="aw-chat__foot">
        <Toggle size="sm" checked={s.onAir} onChange={(on) => void hostChat.setOnAir(on)} label="Hosts may mention our chat on air" />
      </div>
    </div>
  );
}

/** "Message the hosts": a bottom sheet on phones, a side panel next to the app on computers. */
export function ChatPanel() {
  const open = useHostChat((s) => s.open);
  const isDesktop = useIsDesktop();
  const close = () => hostChat.setOpen(false);
  if (isDesktop) {
    if (!open) return null;
    return (
      <aside className="aw-chat-side" aria-label="Message the hosts">
        <ChatBody onClose={close} side />
      </aside>
    );
  }
  return (
    <Sheet open={open} onClose={close} size="md" title="Message the hosts" className="aw-chat-sheet">
      <ChatBody onClose={close} side={false} />
    </Sheet>
  );
}
