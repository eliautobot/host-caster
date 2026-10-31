import { useEffect, useRef, useState } from 'react';
import { Mic, Send, Square } from 'lucide-react';
import { radio } from '@/core/radio';
import { canListen, listen, type ListenHandle } from '@/core/radio/listen';
import { useHosts } from '@/state/hosts';
import { useActiveStation } from '@/state/stations';
import { runAction } from '../actions';
import { AvatarStack, Button, Chip, Sheet, TextArea, toast } from '../components';
import { lineup } from '../screens/parts/StationCard';
import './radio.css';

const IDEAS = ['How is my day looking?', 'Play something upbeat next', 'Tell me a fun fact', 'Say hi to everyone'];

/** "Talk to the hosts": type or say something; the hosts answer on air right away. */
export function CallInSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const station = useActiveStation();
  const all = useHosts((s) => s.hosts);
  const hosts = station ? lineup(all, station.hostIds) : [];
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);
  const handle = useRef<ListenHandle | null>(null);
  const stoppedByUser = useRef(false);
  const names = hosts.map((h) => h.name).join(' & ') || 'your hosts';

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
    // talkNow resolves after the answer has aired; hang up as soon as the hosts are writing it
    let settled = false;
    const done = runAction(() => radio.talkNow(said)).finally(() => (settled = true));
    await Promise.race([done, new Promise((r) => setTimeout(r, 600))]);
    setSending(false);
    if (settled && !(await done)) return;
    setText('');
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
        {hosts.length > 0 && (
          <div className="aw-callin__hosts">
            <AvatarStack people={hosts} size={34} />
            <span>On the line: {names}</span>
          </div>
        )}
        <TextArea
          label="What do you want to say?"
                    placeholder={listening ? 'Listening... say it now' : 'Shout-out, question, song request...'}
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
      </div>
    </Sheet>
  );
}
