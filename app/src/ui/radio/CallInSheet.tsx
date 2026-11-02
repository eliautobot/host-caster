import { useEffect, useRef, useState } from 'react';
import { BookHeart, CircleAlert, CircleCheck, Mic, Send, Square } from 'lucide-react';
import { actionEvents, doneLine, failedLine, type ActionRecord } from '@/core/actions';
import { memoryEvents } from '@/core/memory/store';
import { radio } from '@/core/radio';
import { canListen, listen, type ListenHandle } from '@/core/radio/listen';
import { useHosts } from '@/state/hosts';
import { useActiveStation } from '@/state/stations';
import { useTracker } from '@/state/tracker';
import { runAction } from '../actions';
import { ActionCard } from '../actions/ActionCard';
import { plain } from '../list/format';
import { AvatarStack, Button, Chip, Sheet, TextArea, toast } from '../components';
import { lineup } from '../screens/parts/StationCard';
import { Link } from '../components';
import './radio.css';
import '../screens/settings/memory.css';

const IDEAS = ['How is my day looking?', 'Play something upbeat next', 'Tell me a fun fact', 'Say hi to everyone'];
/** the "Remembered: ..." note shows this long after a call-in taught the hosts something */
const NOTE_MS = 15 * 60_000;

// the last card a call-in added (kept here: the sheet closes while the hosts answer)
let lastRemembered: { text: string; at: number } | undefined;
memoryEvents.on('change', ({ card, added }) => {
  if (added && card && (card.source === 'callin' || card.source === 'app')) lastRemembered = { text: card.text, at: Date.now() };
});

// the last thing the hosts did (or could not do) after a yes: a short note like the Remembered one
let lastResult: { action: ActionRecord; at: number } | undefined;
// a call-in that leads to a question ("Should I add it?"): the sheet that sent it opens again with the card
const openers = new Map<number, () => void>();
let lastSender: { id: number; at: number } | undefined;
let seq = 0;
const REOPEN_MS = 2 * 60_000;
actionEvents.on('change', ({ action }) => {
  if (action.status === 'done' || action.status === 'failed') lastResult = { action, at: Date.now() };
  if (action.status === 'proposed' && action.origin === 'call-in' && lastSender && Date.now() - lastSender.at < REOPEN_MS) {
    openers.get(lastSender.id)?.();
    lastSender = undefined;
  }
});

/** "Talk to the hosts": type or say something; the hosts answer on air right away. */
export function CallInSheet({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen?: () => void }) {
  const station = useActiveStation();
  const all = useHosts((s) => s.hosts);
  const hosts = station ? lineup(all, station.hostIds) : [];
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);
  const handle = useRef<ListenHandle | null>(null);
  const stoppedByUser = useRef(false);
  const names = hosts.map((h) => h.name).join(' & ') || 'your hosts';
  const [remembered, setRemembered] = useState(lastRemembered);
  useEffect(
    () =>
      memoryEvents.on('change', ({ card, added }) => {
        if (!added || !card || card.source !== 'callin') return;
        setRemembered(lastRemembered);
        // the sheet is usually closed by then: a quiet note says what was kept
        toast({ title: 'Remembered', description: card.text });
      }),
    [],
  );
  useEffect(() => {
    if (open) setRemembered(lastRemembered);
  }, [open]);
  const note = remembered && Date.now() - remembered.at < NOTE_MS ? remembered : undefined;

  // a question waiting for a yes: shown here, and the sheet stays open while it waits
  const pending = useTracker((s) => s.pending);
  const refreshPending = useTracker((s) => s.refreshPending);
  const [shown, setShown] = useState<ActionRecord>();
  const [result, setResult] = useState(lastResult);
  const myId = useRef(0);
  if (!myId.current) myId.current = ++seq;
  useEffect(() => {
    if (!onOpen) return;
    const id = myId.current;
    openers.set(id, onOpen);
    return () => void openers.delete(id);
  }, [onOpen]);
  useEffect(() => {
    if (pending && open) setShown(pending);
  }, [pending, open]);
  useEffect(() => {
    if (open) {
      void refreshPending();
      setResult(lastResult);
    } else setShown(undefined);
  }, [open, refreshPending]);
  const resultNote = !shown && result && Date.now() - result.at < NOTE_MS ? result.action : undefined;

  useEffect(() => {
    if (!open) {
      handle.current?.stop();
      setListening(false);
    }
  }, [open]);

  const send = async (msg: string) => {
    const said = msg.trim();
    if (!said) return;
    setSending(true);
    // the answer to a question that waits ("yes", "no"): stay open and show what happened on the card
    const answering = Boolean(useTracker.getState().pending);
    lastSender = { id: myId.current, at: Date.now() };
    // talkNow resolves after the answer has aired; hang up as soon as the hosts are writing it
    let settled = false;
    const done = runAction(() => radio.talkNow(said)).finally(() => (settled = true));
    await Promise.race([done, new Promise((r) => setTimeout(r, 600))]);
    setSending(false);
    if (settled && !(await done)) return;
    setText('');
    if (answering || useTracker.getState().pending) return;
    onClose();
    toast({ title: `${hosts[0]?.name ?? 'The host'} picked up`, description: 'They will answer on air in a moment.' });
  };

  const mic = async () => {
    if (listening) {
      stoppedByUser.current = true;
      handle.current?.stop();
      return;
    }
    stoppedByUser.current = false;
    setListening(true);
    const h = listen({ lang: hosts[0]?.language, onPartial: setText });
    handle.current = h;
    try {
      const said = await h.result;
      setListening(false);
      if (said) {
        setText(said);
        await send(said);
      } else if (!stoppedByUser.current) {
        // silence or no match: say so, or the button just flips back to Speak and nothing seems to happen
        toast({ title: 'Didn’t catch that', description: 'Try again a little closer to the phone, or type it.' });
      }
    } catch (err) {
      setListening(false);
      toast.error('Could not hear you', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="sm"
      title="Talk to the hosts"
      description={`${names} will answer on air, right after you hang up.`}
      footer={
        <>
          {canListen() && (
            <Button icon={listening ? Square : Mic} onClick={mic} className={listening ? 'aw-callin__listening' : undefined}>
              {listening ? 'Stop' : 'Speak'}
            </Button>
          )}
          <Button variant="primary" icon={Send} loading={sending} disabled={!text.trim()} onClick={() => send(text)}>
            Go on air
          </Button>
        </>
      }
    >
      <div className="aw-callin">
        {shown && <ActionCard key={shown.id} action={shown} className="aw-callin__action" />}
        {hosts.length > 0 && (
          <div className="aw-callin__hosts">
            <AvatarStack people={hosts} size={34} />
            <span>On the line: {names}</span>
          </div>
        )}
        <TextArea
          label="What do you want to say?"
                    placeholder={listening ? 'Listening... say it now' : pending && pending.id === shown?.id ? 'Say yes or no, or anything else...' : 'Shout-out, question, song request...'}
          value={text}
          onChange={setText}
          rows={3}
          autoResize
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <div className="aw-callin__ideas">
          {IDEAS.map((idea) => (
            <Chip key={idea} size="sm" onClick={() => setText(idea)}>
              {idea}
            </Chip>
          ))}
        </div>
        {resultNote && (
          <p className={resultNote.status === 'done' ? 'aw-callin-remembered' : 'aw-callin-remembered aw-callin-remembered--failed'} role="status">
            {resultNote.status === 'done' ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
            <span>
              {plain(resultNote.status === 'done' ? doneLine(resultNote) : failedLine(resultNote))}{' '}
              <Link to="/list?view=done" onClick={onClose}>
                See what your hosts did
              </Link>
            </span>
          </p>
        )}
        {note && (
          <p className="aw-callin-remembered" role="status">
            <BookHeart aria-hidden />
            <span>
              Remembered: {note.text}.{' '}
              <Link to="/settings/memory" onClick={onClose}>
                See what your hosts remember
              </Link>
            </span>
          </p>
        )}
      </div>
    </Sheet>
  );
}
