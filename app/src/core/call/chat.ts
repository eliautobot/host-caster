// "Message the hosts": a chat thread with the station's hosts while the music plays. The lead host answers right away
// in text with the same powers as a call (lookups, memory, Your list, actions with a Yes/No card, song requests).
// The thread lasts for this listening session (kept on the device for 12 hours) and the listener's words go in the
// journal like a call-in. Off by default: "Hosts may mention our chat on air" lets the next break bring it up.
import { getSettings, getStation, kvGet, kvSet } from '../db';
import { radio } from '../radio';
import { summarize } from '../context/context';
import { createEmitter } from '../util/emitter';
import { hostsBrain, type HostsBrain } from './brain';
import type { CallLine } from './session';

export interface ChatMessage {
  id: number;
  who: 'you' | 'host';
  hostId?: string;
  text: string;
  at: number;
  /** the host is writing it (the typing dots), or it is still coming in */
  pending?: boolean;
  /** a question waiting for yes or no: the card under the message */
  actionId?: string;
  /** the AI did not answer properly */
  notice?: string;
  /** what the hosts now remember ("remember that ...") */
  remembered?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  /** host messages the listener has not seen (the panel was closed) */
  unread: number;
  open: boolean;
  busy: boolean;
  /** a lookup is running for the answer being written */
  lookingUp: boolean;
  /** the next breaks may bring up the chat */
  onAir: boolean;
  /** first host message after a send: ms from send to its first words (measured) */
  lastReplyMs?: number;
}

import { CHAT_KEY as KEY, CHAT_ON_AIR_KEY as ON_AIR_KEY } from './onair';
const KEEP_MS = 12 * 3600_000;
const MAX_KEEP = 80;
const BRAIN_TTL_MS = 10 * 60_000;
/** the reply appears in pieces this far apart (a few words at a time) */
const REVEAL_MS = 35;

class HostChat {
  private emitter = createEmitter<{ state: ChatState }>();
  private _state: ChatState = { messages: [], unread: 0, open: false, busy: false, lookingUp: false, onAir: false };
  private seq = 0;
  private brain?: { station: string; at: number; p: Promise<HostsBrain> };
  private loaded?: Promise<void>;
  private controller?: AbortController;

  get state(): ChatState {
    return this._state;
  }

  on(cb: (s: ChatState) => void): () => void {
    return this.emitter.on('state', cb);
  }

  private set(patch: Partial<ChatState>) {
    this._state = { ...this._state, ...patch };
    this.emitter.emit('state', this._state);
  }

  /** The thread kept from earlier in this session (and the on-air switch). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const row = (await kvGet<{ at: number; messages: ChatMessage[] }>(KEY).catch(() => undefined))?.value;
      const onAir = (await kvGet<boolean>(ON_AIR_KEY).catch(() => undefined))?.value === true;
      const messages = row && Date.now() - row.at < KEEP_MS ? row.messages.filter((m) => !m.pending) : [];
      this.seq = Math.max(0, ...messages.map((m) => m.id));
      this.set({ messages: [...messages, ...this._state.messages], onAir });
    })();
    return this.loaded;
  }

  private save() {
    const messages = this._state.messages.filter((m) => !m.pending).slice(-MAX_KEEP);
    void kvSet(KEY, { at: Date.now(), messages }).catch(() => undefined);
  }

  setOpen(open: boolean): void {
    this.set({ open, ...(open ? { unread: 0 } : {}) });
    if (open) void this.load();
  }

  async setOnAir(on: boolean): Promise<void> {
    this.set({ onAir: on });
    await kvSet(ON_AIR_KEY, on);
  }

  clear(): void {
    this.controller?.abort();
    this.set({ messages: [], unread: 0, busy: false, lookingUp: false });
    this.save();
  }

  private async hosts(): Promise<HostsBrain> {
    const id = radio.state.stationId ?? (await getSettings()).activeStationId;
    if (!id) throw new Error('Pick a station first, then message its hosts.');
    const b = this.brain;
    if (b && b.station === id && Date.now() - b.at < BRAIN_TTL_MS) return b.p;
    const p = (async () => {
      const station = await getStation(id);
      if (!station) throw new Error('Pick a station first, then message its hosts.');
      return hostsBrain(station, 'text', { requestSong: (said) => radio.requestSong(said), nowPlaying: () => summarize(radio.nowPlaying), music: radio.musicHooks() });
    })();
    this.brain = { station: id, at: Date.now(), p };
    p.catch(() => {
      if (this.brain?.p === p) this.brain = undefined;
    });
    return p;
  }

  private add(m: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const msg = { ...m, id: ++this.seq, at: Date.now() };
    this.set({ messages: [...this._state.messages, msg] });
    return msg;
  }

  private patch(id: number, patch: Partial<ChatMessage>) {
    this.set({ messages: this._state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  }

  /** The listener sends a message; the host answers right away (the music keeps playing). */
  async send(text: string): Promise<void> {
    const said = text.trim();
    if (!said) return;
    await this.load();
    const t0 = Date.now();
    const history: CallLine[] = this._state.messages.filter((m) => !m.pending).slice(-14).map((m) => ({ id: m.id, who: m.who, hostId: m.hostId, text: m.text, at: m.at }));
    this.add({ who: 'you', text: said });
    history.push({ id: this.seq, who: 'you', text: said, at: Date.now() });
    this.save();
    // one answer at a time: a new message while the host writes waits for it
    while (this._state.busy) await new Promise((r) => setTimeout(r, 150));
    const typing = this.add({ who: 'host', text: '', pending: true });
    const controller = (this.controller = new AbortController());
    this.set({ busy: true, lookingUp: false });
    try {
      const hosts = await this.hosts();
      this.patch(typing.id, { hostId: hosts.lead.id });
      const reply = await hosts.reply(said, history, { signal: controller.signal, onLookup: () => this.set({ lookingUp: true }) });
      if (controller.signal.aborted) return;
      this.set({ lastReplyMs: Date.now() - t0, lookingUp: false });
      const lines = reply.lines.length ? reply.lines : [{ hostId: hosts.lead.id, text: 'Sorry, I lost my train of thought there. Can you say that again?' }];
      for (const [i, l] of lines.entries()) {
        const msg = i === 0 ? typing : this.add({ who: 'host', hostId: l.hostId, text: '', pending: true });
        if (i === 0) this.patch(msg.id, { hostId: l.hostId });
        await this.reveal(msg.id, l.text, controller.signal);
        const last = i === lines.length - 1;
        this.patch(msg.id, { text: l.text, pending: false, ...(last && reply.actionId ? { actionId: reply.actionId } : {}), ...(last && reply.notice ? { notice: reply.notice } : {}), ...(last && reply.remembered ? { remembered: reply.remembered } : {}) });
        if (!this._state.open) this.set({ unread: this._state.unread + 1 });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      this.patch(typing.id, { pending: false, text: "Sorry, I can't answer right now.", notice: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.controller === controller) this.set({ busy: false, lookingUp: false });
      this.save();
    }
  }

  /** The answer comes in a few words at a time, starting at once. */
  private async reveal(id: number, text: string, signal: AbortSignal): Promise<void> {
    const words = text.split(/(\s+)/);
    for (let n = 2; n < words.length; n += 6) {
      if (signal.aborted) return;
      this.patch(id, { text: words.slice(0, n).join('') });
      await new Promise((r) => setTimeout(r, REVEAL_MS));
    }
  }
}

export type { HostChat };
export const hostChat = new HostChat();
