import { useEffect, useRef, useState } from 'react';
import { Keyboard, Mic, MicOff, PhoneOff, Send } from 'lucide-react';
import { clockOf, liveCall } from '@/core/call';
import { useLiveCall } from '@/state/call';
import { useHosts } from '@/state/hosts';
import { useTracker } from '@/state/tracker';
import { ActionCard } from '../actions/ActionCard';
import { onNativeBack } from '../nativeBack';
import { Avatar, Button, IconButton, cx } from '../components';
import './call.css';

const STATUS: Record<string, string> = {
  ringing: 'Calling...',
  listening: 'Listening',
  thinking: 'Thinking...',
  speaking: 'Talking',
  ending: 'Hanging up...',
  ended: 'Call ended',
};

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The live call: who is on the line, the call timer, both sides' captions, Mute / Talk / Hang up. */
export function CallScreen() {
  const s = useLiveCall();
  const hosts = useHosts((h) => h.hosts);
  const live = s.open && s.status !== 'ended';
  const now = useNow(live);
  const lead = hosts.find((h) => h.id === s.leadId);
  const speaking = hosts.find((h) => h.id === s.speakingHostId);
  const shown = speaking ?? lead;
  const coHosts = s.hostIds.slice(1).map((id) => hosts.find((h) => h.id === id)).filter((h): h is NonNullable<typeof h> => Boolean(h));
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const pending = useTracker((t) => t.pending);
  const refreshPending = useTracker((t) => t.refreshPending);
  const [elapsedEnd, setElapsedEnd] = useState(0);

  useEffect(() => {
    if (s.actionId) void refreshPending();
  }, [s.actionId, refreshPending]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [s.lines.length, s.partial]);
  // no microphone here: typing is the way to talk
  useEffect(() => {
    if (s.mic === 'none' || s.mic === 'blocked') setTyping(true);
  }, [s.mic]);
  useEffect(() => {
    if (s.status === 'ended' && s.open) {
      setElapsedEnd(s.startedAt ? Date.now() - s.startedAt : 0);
      if (s.error) return;
      const t = setTimeout(() => liveCall.close(), 2600);
      return () => clearTimeout(t);
    }
    if (s.status === 'ringing') setTyping(false);
  }, [s.status, s.open, s.error, s.startedAt]);
  // Android back: a live call stays on screen (Hang up ends it); an ended call's screen closes
  useEffect(() => {
    if (!s.open) return;
    return onNativeBack(() => {
      if (!live) liveCall.close();
      return true;
    });
  }, [s.open, live]);
  // Escape hangs up (desktop), like the red button
  useEffect(() => {
    if (!s.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (live ? liveCall.hangUp() : liveCall.close());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.open, live]);

  if (!s.open) return null;
  const elapsed = s.startedAt ? (live ? now - s.startedAt : elapsedEnd) : 0;
  const left = s.startedAt ? s.maxMs - elapsed : s.maxMs;
  const status = s.error
    ? 'Could not call'
    : s.status === 'speaking' && speaking
      ? `${speaking.name} is talking`
      : s.status === 'thinking' && s.lookingUp
        ? 'Looking it up...'
        : s.status === 'listening' && s.mic === 'muted'
          ? 'Muted'
          : s.status === 'listening' && s.mic !== 'on'
            ? 'Type to talk'
            : STATUS[s.status];
  const card = s.actionId && pending?.id === s.actionId ? pending : undefined;
  const send = () => {
    const t = text.trim();
    if (!t) return;
    liveCall.type(t);
    setText('');
  };

  return (
    <div className={cx('aw-call', `aw-call--${s.status}`)} role="dialog" aria-modal="true" aria-label={`Call with ${s.stationName ?? 'the station'}`}>
      <div className="aw-call__panel">
        <header className="aw-call__top">
          <span className="aw-call__live" aria-hidden />
          <span className="aw-call__station aw-truncate">{s.stationName ?? 'Host-Caster'}</span>
          <span className="aw-call__timer" aria-label="Call time">
            {s.startedAt ? clockOf(elapsed) : '0:00'}
          </span>
        </header>

        <section className="aw-call__who" aria-live="polite">
          <span className={cx('aw-call__avatar', s.status === 'speaking' && 'aw-call__avatar--speaking', s.status === 'ringing' && 'aw-call__avatar--ringing')}>
            {shown && <Avatar avatar={shown.avatar} name={shown.name} size={112} speaking={s.status === 'speaking'} />}
          </span>
          <h2 className="aw-call__name">{shown?.name ?? 'Your host'}</h2>
          {coHosts.length > 0 && <p className="aw-call__with">with {coHosts.map((h) => h.name).join(' and ')} in the studio</p>}
          <p className={cx('aw-call__status', s.status === 'listening' && s.mic === 'on' && 'aw-call__status--live')}>{status}</p>
        </section>

        <div className="aw-call__log" ref={log} aria-label="Captions" role="log">
          {s.error && <p className="aw-call__notice">{s.error}</p>}
          {s.scripted && s.status !== 'ended' && <p className="aw-call__hint">Your hosts have no AI brain set up, so they can take song requests and notes only.</p>}
          {s.lines.map((l) => {
            const h = l.who === 'host' ? hosts.find((x) => x.id === l.hostId) : undefined;
            return (
              <p key={l.id} className={cx('aw-call__line', l.who === 'you' ? 'aw-call__line--you' : 'aw-call__line--host')}>
                {l.who === 'host' && <span className="aw-call__speaker">{h?.name ?? 'Host'}</span>}
                {l.text}
              </p>
            );
          })}
          {s.partial && <p className="aw-call__line aw-call__line--you aw-call__line--partial">{s.partial}</p>}
        </div>

        {card && <ActionCard key={card.id} action={card} className="aw-call__action" />}
        {s.notice && <p className="aw-call__notice">{s.notice}</p>}
        {live && s.warned && left > 0 && <p className="aw-call__cap aw-call__cap--warn">About {Math.max(1, Math.ceil(left / 60_000))} min left on this call</p>}

        {live && typing && (
          <form
            className="aw-call__type"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input className="aw-call__input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type to the host..." aria-label="Type to the host" autoFocus />
            <IconButton icon={Send} label="Send" variant="primary" size="md" type="submit" disabled={!text.trim()} />
          </form>
        )}

        {live ? (
          <footer className="aw-call__controls">
            <span className="aw-call__control">
              <IconButton icon={s.mic === 'muted' ? MicOff : Mic} label={s.mic === 'muted' ? 'Unmute' : 'Mute'} size="lg" active={s.mic === 'muted'} onClick={() => liveCall.toggleMute()} disabled={s.mic === 'none' || s.mic === 'blocked'} />
              <span>{s.mic === 'muted' ? 'Unmute' : 'Mute'}</span>
            </span>
            <span className="aw-call__control">
              <button
                type="button"
                className={cx('aw-call__talk', s.status === 'listening' && s.mic === 'on' && 'aw-call__talk--on')}
                onClick={() => liveCall.talk()}
                disabled={s.status === 'ringing' || s.mic === 'none' || s.mic === 'blocked'}
                aria-label={s.status === 'speaking' || s.status === 'thinking' ? 'Interrupt and talk' : s.mic === 'muted' ? 'Unmute and talk' : 'Done talking'}
              >
                <Mic aria-hidden />
              </button>
              <span>{s.status === 'speaking' || s.status === 'thinking' ? 'Interrupt' : 'Talk'}</span>
            </span>
            <span className="aw-call__control">
              <button type="button" className="aw-call__hangup" onClick={() => liveCall.hangUp()} aria-label="Hang up">
                <PhoneOff aria-hidden />
              </button>
              <span>Hang up</span>
            </span>
            <span className="aw-call__control aw-call__control--small">
              <IconButton icon={Keyboard} label={typing ? 'Hide keyboard' : 'Type instead'} size="md" active={typing} onClick={() => setTyping((t) => !t)} />
            </span>
          </footer>
        ) : (
          <footer className="aw-call__controls aw-call__controls--ended">
            <p className="aw-call__ended">{s.error ? 'The call did not go through.' : `Call ended${elapsed ? ` after ${clockOf(elapsed)}` : ''}. The music is back on.`}</p>
            <Button variant="primary" onClick={() => liveCall.close()}>
              Close
            </Button>
          </footer>
        )}
        {live && <p className="aw-call__cap">Calls last up to {Math.round(s.maxMs / 60_000)} minutes and use your AI and voice like a break.</p>}
      </div>
    </div>
  );
}
