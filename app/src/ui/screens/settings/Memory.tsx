// Settings > What your hosts remember: the memory cards (grouped by kind, where each came from; edit, delete, pin,
// add your own), "Recently" (the 14-day journal, any row can go), the two learning switches and "Forget everything".
// Plain words: these are cards, not files.
import { useEffect, useState } from 'react';
import {
  BookHeart,
  Ear,
  Heart,
  History,
  Megaphone,
  MessageCircle,
  Music2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Radio,
  SkipForward,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  KIND_LABEL,
  KINDS,
  MAX_CARDS,
  addCard,
  allCards,
  deleteCards,
  deleteJournal,
  editCard,
  forgetEverything,
  listJournal,
  memoryEvents,
  memorySwitches,
  sourceWords,
} from '@/core/memory';
import { learningBrain } from '@/core/memory/learn';
import type { JournalEntry, JournalKind, MemoryCard, MemoryKind } from '@/core/types';
import { useSettings } from '@/state/settings';
import { Badge, Button, IconButton, Select, TextArea, Toggle, toast } from '../../components';
import { ConfirmSheet, SectionCard, errorText, timeAgo, useLoad } from './account/parts';
import './memory.css';

const KIND_OPTIONS = KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }));

const JOURNAL_ICON: Record<JournalKind, LucideIcon> = {
  said: MessageCircle,
  app: Sparkles,
  headsup: Megaphone,
  gotit: Megaphone,
  liked: Heart,
  skipped: SkipForward,
  requested: Music2,
  listened: Radio,
  covered: Radio,
  breakSkipped: SkipForward,
};

const JOURNAL_WORDS: Record<JournalKind, string> = {
  said: 'You said',
  app: 'Your AI app said',
  headsup: 'Heads-up',
  gotit: 'You said got it',
  liked: 'You liked',
  skipped: 'You skipped',
  requested: 'You asked for',
  listened: '',
  covered: '',
  breakSkipped: '',
};

const dayTitle = (day: string, now = new Date()) => {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - date.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};

const until = (c: MemoryCard) => (c.expiresAt ? `until ${new Date(c.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '');

function CardRow({ c, onChanged }: { c: MemoryCard; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.text);
  const [kind, setKind] = useState<MemoryKind>(c.kind);
  const save = async () => {
    await editCard(c.id, { text, kind });
    setEditing(false);
    onChanged();
  };
  if (editing) {
    return (
      <div className="aw-acct-row aw-mem-card aw-mem-card--editing">
        <div className="aw-mem-edit">
          <TextArea aria-label="What your hosts remember" value={text} onChange={setText} maxLength={200} autoResize rows={2} />
          <div className="aw-mem-edit__row">
            <Select aria-label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
            <span className="aw-mem-edit__count">{text.length}/200</span>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={text.trim().length < 3} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="aw-acct-row aw-mem-card" data-card={c.id}>
      <span className="aw-acct-row__text">
        <span className="aw-mem-card__text">
          {c.pinned && <Pin className="aw-mem-card__pin" aria-label="Pinned" />}
          {c.text}
        </span>
        <span className="aw-acct-row__sub">{[sourceWords(c), until(c), c.sensitive ? 'kept because you asked' : ''].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="aw-acct-row__end aw-mem-card__actions">
        <IconButton
          size="sm"
          icon={c.pinned ? PinOff : Pin}
          label={c.pinned ? 'Unpin' : 'Pin: your hosts always keep it in mind'}
          active={c.pinned}
          onClick={() => void editCard(c.id, { pinned: !c.pinned }).then(onChanged)}
        />
        <IconButton size="sm" icon={Pencil} label="Edit" onClick={() => setEditing(true)} />
        <IconButton size="sm" icon={Trash2} label="Delete" onClick={() => void deleteCards([c.id]).then(onChanged)} />
      </span>
    </div>
  );
}

function AddOwn({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<MemoryKind>('about');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const r = await addCard({ text, kind, source: 'you' });
      if (!r.put) {
        toast(r.refused === 'secret' ? 'Passwords, codes, numbers and addresses are never kept.' : r.refused === 'full' ? `Your hosts remember up to ${MAX_CARDS} cards. Delete a few first.` : 'That one could not be added.');
        return;
      }
      setText('');
      onDone();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="aw-mem-add">
      <TextArea label="Something your hosts should remember" value={text} onChange={setText} maxLength={200} autoResize rows={2} placeholder="I'm training for a half marathon in March" />
      <div className="aw-mem-edit__row">
        <Select aria-label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
        <span className="aw-mem-edit__count">{text.length}/200</span>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={busy} disabled={text.trim().length < 3} onClick={() => void add()}>
          Add
        </Button>
      </div>
    </div>
  );
}

function JournalRow({ r, onChanged }: { r: JournalEntry; onChanged: () => void }) {
  const Icon = JOURNAL_ICON[r.kind] ?? Radio;
  const lead = JOURNAL_WORDS[r.kind];
  return (
    <div className="aw-acct-row aw-mem-j" data-row={r.id}>
      <span className="aw-acct-row__icon" aria-hidden>
        <Icon />
      </span>
      <span className="aw-acct-row__text">
        <span className="aw-mem-j__text">
          {lead ? `${lead}: ` : ''}
          {r.kind === 'said' || r.kind === 'app' ? `"${r.text}"` : r.text}
        </span>
        <span className="aw-acct-row__sub">{new Date(r.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
      </span>
      <IconButton size="sm" icon={X} label="Delete this line" onClick={() => void deleteJournal(r.id).then(onChanged)} />
    </div>
  );
}

export default function Memory() {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const sw = memorySwitches({ connections });
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const refresh = () => setTick((n) => n + 1);
  useEffect(() => {
    const offs = [memoryEvents.on('change', refresh), memoryEvents.on('journal', refresh)];
    return () => offs.forEach((off) => off());
  }, []);
  const cards = useLoad(() => allCards(), [tick]);
  const journal = useLoad(() => listJournal(), [tick]);
  const brain = useLoad(() => learningBrain().catch(() => undefined), []);
  const list = cards.data ?? [];
  const save = (patch: { fromWords?: boolean; fromListening?: boolean }) => void update({ connections: { ...connections, memory: { ...connections.memory, ...patch } } });

  const groups = KINDS.map((k) => ({ kind: k, cards: list.filter((c) => c.kind === k).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt) })).filter((g) => g.cards.length);
  const rows = journal.data ?? [];
  const shown = showAll ? rows : rows.slice(0, 30);
  const days = [...new Set(shown.map((r) => r.day))];

  return (
    <div className="aw-acct-stack aw-mem">
      <p className="aw-acct-desc">
        Your hosts remember a few things about you, so they can pick up where you left off. You can see, change and delete all of it here. What you write in About me always comes first, and your hosts never change it.
      </p>

      <SectionCard
        id="memory-learn"
        icon={Ear}
        tone="signal"
        title="How your hosts learn"
        status={brain.data ? 'From what you say and how you listen' : 'From "remember that..." and how you listen'}
        badge={{ label: sw.fromWords || sw.fromListening ? 'On' : 'Off', tone: sw.fromWords || sw.fromListening ? 'ok' : 'neutral', dot: sw.fromWords || sw.fromListening }}
      >
        <div className="aw-mem-switches">
          <Toggle
            checked={sw.fromWords}
            onChange={(v) => save({ fromWords: v })}
            label="Learn from what I say"
            description='Call-ins and messages from your AI app. Saying "remember that..." or "forget that..." always works.'
          />
          <Toggle
            checked={sw.fromListening}
            onChange={(v) => save({ fromListening: v })}
            label="Learn from how I listen"
            description="Songs you like, skip or ask for, and when you listen. A pattern needs at least 3 times over 2 days."
          />
        </div>
        {brain.data === undefined && !brain.loading && (
          <p className="aw-acct-desc aw-mem-note">Your hosts use the built-in script right now, so they learn only from "remember that..." and from how you listen. Pick an AI brain for a host to let them learn more.</p>
        )}
        <p className="aw-acct-desc aw-mem-note">Your hosts only learn from your own words and what you do in the app, never from your email, calendar, notes or the news. They never keep passwords, codes or numbers.</p>
      </SectionCard>

      <SectionCard
        id="memory-cards"
        icon={BookHeart}
        tone="warm"
        title="Memory cards"
        status={list.length ? `${list.length} of ${MAX_CARDS} cards, shared by all your hosts` : 'Nothing yet'}
        badge={list.length ? { label: `${list.length}`, tone: 'neutral' } : undefined}
      >
        {adding ? (
          <AddOwn
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        ) : (
          <div className="aw-mem-addbar">
            <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
              Add your own
            </Button>
          </div>
        )}
        {groups.length ? (
          groups.map((g) => (
            <section key={g.kind} className="aw-mem-group" aria-label={KIND_LABEL[g.kind]}>
              <h4 className="aw-mem-group__title">{KIND_LABEL[g.kind]}</h4>
              <div className="aw-acct-rows">
                {g.cards.map((c) => (
                  <CardRow key={`${c.id}:${c.updatedAt}`} c={c} onChanged={refresh} />
                ))}
              </div>
            </section>
          ))
        ) : (
          <p className="aw-lookups__empty">{cards.data ? 'Call in and tell your hosts something, or say "remember that..." and it shows up here.' : 'Loading...'}</p>
        )}
      </SectionCard>

      <SectionCard id="memory-recently" icon={History} title="Recently" status="The last 14 days on your radio, on this device. Older lines go away by themselves.">
        {rows.length ? (
          <>
            {days.map((d) => (
              <section key={d} className="aw-mem-group" aria-label={dayTitle(d)}>
                <h4 className="aw-mem-group__title">{dayTitle(d)}</h4>
                <div className="aw-acct-rows">
                  {shown
                    .filter((r) => r.day === d)
                    .map((r) => (
                      <JournalRow key={r.id} r={r} onChanged={refresh} />
                    ))}
                </div>
              </section>
            ))}
            {rows.length > shown.length && (
              <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
                Show all {rows.length}
              </Button>
            )}
          </>
        ) : (
          <p className="aw-lookups__empty">{journal.data ? 'Nothing yet. What you say on call-ins, songs you like or skip and when you listen show up here.' : 'Loading...'}</p>
        )}
      </SectionCard>

      <div className="aw-mem-forget">
        <Button variant="danger" icon={Trash2} onClick={() => setConfirm(true)} disabled={!list.length && !rows.length}>
          Forget everything
        </Button>
        {list.length > 0 && <Badge tone="neutral">Updated {timeAgo(Math.max(...list.map((c) => c.updatedAt)))}</Badge>}
      </div>
      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Forget everything?"
        description="Your hosts forget every card and the last 14 days, on all your signed-in devices. About me stays as it is."
        confirmLabel="Forget everything"
        danger
        onConfirm={async () => {
          await forgetEverything();
          setConfirm(false);
          refresh();
          toast('Your hosts forgot everything.');
        }}
      />
    </div>
  );
}
