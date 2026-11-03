// Host-Caster shared types. This file mirrors ARCHITECTURE.md; change both together.
// Pure TS: no React, no DOM-only imports.

/** Every stored record. Times are epoch milliseconds. */
export interface BaseRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** A record without the fields the db helpers fill in. */
export type Draft<T extends BaseRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & Partial<BaseRecord>;

// ---------------------------------------------------------------------------------------------------------------------
// Library

/** 'device': a song file that stays where it is on this device (found by Find music on this device); never synced */
export type TrackSource = 'local' | 'server' | 'spotify' | 'youtube' | 'stream' | 'subsonic' | 'device';

export interface Track extends BaseRecord {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  year?: number;
  genre?: string;
  durationMs: number;
  /** blobs.id of the cover art */
  artworkId?: string;
  /** public cover URL (no credentials): synced, so another device can show the cover */
  artUrl?: string;
  source: TrackSource;
  /** local blob id, server track id, spotify URI, YouTube videoId, stream URL, subsonic id or device file ('android:<id>') */
  ref: string;
  liked?: boolean;
  playCount: number;
  lastPlayedAt?: number;
  addedAt: number;
  /** position on the album (sorting album views) */
  trackNo?: number;
  discNo?: number;
  /** imported files: where it came from (M3U matching, duplicate detection, export) */
  file?: TrackFile;
}

export interface TrackFile {
  name: string;
  /** relative path inside an imported folder ('Album/01 Song.mp3'); undefined for single files */
  path?: string;
  size: number;
  mime: string;
  /** quick content fingerprint (size + head/tail bytes), for duplicate detection */
  hash?: string;
  /** device songs: the file's date (epoch ms), to notice a changed file */
  modifiedAt?: number;
}

/** Small snapshot of a track, kept in logs and context packets so they survive track deletion. */
export type TrackSummary = Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'durationMs' | 'source'>;

export interface BlobRecord extends BaseRecord {
  blob: Blob;
  mime: string;
  size: number;
}

export type PlaylistSource = 'local' | 'spotify' | 'youtube' | 'm3u' | 'subsonic';

export interface Playlist extends BaseRecord {
  name: string;
  description?: string;
  /**
   * In order. A song from another device that is not here (a file stays on its device) keeps its place as an id with
   * no track behind it: lists skip it, and the playlist says how many songs are on another device.
   */
  trackIds: string[];
  coverId?: string;
  source: PlaylistSource;
  /** imported from a service ('youtube:LL', 'spotify:<id>'): another device's import fills this playlist again */
  remoteKey?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hosts and stations

export type Level = 1 | 2 | 3 | 4 | 5;

export interface HostAvatar {
  kind: 'emoji' | 'image' | 'monogram';
  /** emoji character, blobs.id / URL of the image, or the monogram letters */
  value: string;
  /** palette key from ui/components/avatarPalettes.ts (warm/neutral only) or a hex colour */
  color: string;
}

export interface HostVoice {
  /** 'device' = built in (Web Speech on web, native TTS on Android/iOS); else voices.id */
  voiceProviderId: string;
  /** provider voice id; '' = the provider default */
  voiceId: string;
  /** 1 = normal */
  speed: number;
  /** 1 = normal */
  pitch: number;
  /** style prompt for voices that take one (gpt-4o-mini-tts) */
  instructions?: string;
}

export interface Host extends BaseRecord {
  name: string;
  avatar: HostAvatar;
  tagline: string;
  /** free text: who they are */
  personality: string;
  /** how they talk */
  style: string;
  energy: Level;
  humor: Level;
  verbosity: Level;
  /** BCP-47 */
  language: string;
  catchphrases: string[];
  topics: string[];
  avoid: string[];
  voice: HostVoice;
  /** brains.id; null = no AI brain yet: the scripted fallback reads their lines until one is connected */
  brainId: string | null;
}

/** The id hosts saved when "Built-in host" was a choice (before the scripted fallback); migrated to null. */
export const LEGACY_BUILTIN_BRAIN_ID = 'builtin';
/** The virtual brain of the scripted fallback (never stored, never a choice). */
export const FALLBACK_BRAIN_ID = 'fallback';
export const DEVICE_VOICE_ID = 'device';

export type StationSourceKind =
  | 'library'
  | 'playlist'
  | 'liked'
  | 'server'
  | 'spotify-playlist'
  | 'youtube-playlist'
  | 'stream'
  | 'anyapp';

export interface StationSource {
  kind: StationSourceKind;
  ref?: string;
}

export type TalkLength = 'short' | 'normal' | 'long';

export interface StationSegments {
  songs: boolean;
  time: boolean;
  weather: boolean;
  calendar: boolean;
  email: boolean;
  news: boolean;
  lifeEvents: boolean;
  notes: boolean;
  reminders: boolean;
  funFacts: boolean;
}

export type SegmentKey = keyof StationSegments;

export interface Station extends BaseRecord {
  name: string;
  /** display only, e.g. "88.1" */
  frequency: string;
  color: string;
  description?: string;
  sources: StationSource[];
  /** 1..4, first = lead */
  hostIds: string[];
  /** songs between breaks, 1..10 */
  talkEvery: number;
  /** ~1-2 / 3-4 / 5-8 lines total */
  talkLength: TalkLength;
  /** 0 = mostly the music .. 4 = mostly the listener's day; missing = DEFAULT_TALK_MIX (core/radio/planner.ts) */
  talkMix?: number;
  segments: StationSegments;
  talkOverIntro: boolean;
  /** 0..1 music volume under voice, default 0.18 */
  duckLevel: number;
  newsFeeds: string[];
  shuffle: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Brains and voices

/** builtin = the scripted fallback (virtual, never stored or offered); chatgpt = the user's ChatGPT plan (Sign in with ChatGPT); always runs through the Host-Caster server.
 * hostcaster = Host-Caster AI, included with a Host-Caster online plan (server only, the service picks the model) */
export type BrainKind = 'openai' | 'anthropic' | 'builtin' | 'connector' | 'chatgpt' | 'hostcaster';
/** 'device' = direct fetch (CapacitorHttp on native); 'server' = through the Host-Caster server, which holds the key */
export type Transport = 'device' | 'server';

export interface Brain extends BaseRecord {
  name: string;
  kind: BrainKind;
  /** core/ai/presets.ts id */
  preset?: string;
  baseUrl?: string;
  apiKey?: string;
  /** replaces apiKey in synced docs; the server holds the value */
  secretRef?: string;
  model: string;
  temperature?: number;
  transport: Transport;
}

export interface BrainPreset {
  id: string;
  name: string;
  kind: BrainKind;
  baseUrl: string;
  defaultModel: string;
  /** where the user gets an API key */
  keyUrl?: string;
  /** runs on this device or the LAN (no key needed) */
  local: boolean;
}

/** hostcaster = Host-Caster Voices, included with a Host-Caster online plan (server only) */
export type VoiceKind = 'device' | 'openai' | 'elevenlabs' | 'openai-compatible' | 'hostcaster';

export interface VoiceProvider extends BaseRecord {
  name: string;
  kind: VoiceKind;
  baseUrl?: string;
  apiKey?: string;
  secretRef?: string;
  transport: Transport;
  /** speech model (gpt-4o-mini-tts, eleven_flash_v2_5, kokoro ...); '' = the kind's default */
  model?: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  language?: string;
  gender?: 'female' | 'male' | 'neutral';
  /** Host-Caster Voices: a premium voice (the Premium plan, its own monthly allowance) */
  premium?: boolean;
  /** Host-Caster Voices: retired voice ids this voice stands in for */
  replaces?: string[];
  /** Host-Caster Voices, premium: the standard voice that speaks for it on plans without premium voices */
  standIn?: { id: string; name: string };
}

export type VoiceClip =
  | { kind: 'audio'; blob: Blob }
  | { kind: 'device'; text: string; voiceId: string; rate: number; pitch: number };

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens: number;
}

// Tool calling (core/agent; the server speaks the same shapes, server/src/ai/wire.js)
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object) */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentMessage =
  | ChatMessage
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/** What a host found out about one item of the listener's day (core/agent/research.ts). */
export interface Dossier {
  /** the planner's item key: 'calendar:<id>', 'email:<id>', a headline id */
  key: string;
  /** the item's version (an event's last change ...): a change means new research */
  version: string;
  kind: 'calendar' | 'email' | 'news';
  title: string;
  /** one to three plain sentences: what it is about */
  about: string;
  who?: string[];
  /** what to bring, read or decide */
  prepare?: string[];
  links?: LinkRef[];
  /** what the sources did not say */
  questions?: string[];
  /** what was read, in a few words each ("Email from Dana Reyes") */
  sources: string[];
  /** 'ai' = a host's brain researched it with lookups; 'scripted' = made from the item's own fields */
  by: 'ai' | 'scripted';
  hostName?: string;
  brainName?: string;
  at: number;
  ms?: number;
  steps?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// On-air log

export interface BreakLine {
  hostId: string;
  text: string;
}

export interface Break extends BaseRecord {
  stationId: string;
  at: number;
  lines: BreakLine[];
  topics: string[];
  songBefore?: TrackSummary;
  songAfter?: TrackSummary;
}

// ---------------------------------------------------------------------------------------------------------------------
// Profile and settings (single rows)

export interface GeoPlace {
  name: string;
  lat: number;
  lon: number;
}

export type Units = 'metric' | 'imperial';

export interface LifeEvent {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  yearly: boolean;
  notes?: string;
}

export interface ProfileNote {
  id: string;
  text: string;
  /** epoch ms; the hosts stop mentioning it after this */
  until?: number;
}

export interface Reminder {
  id: string;
  text: string;
  /** epoch ms */
  at: number;
}

export const PROFILE_ID = 'me';
export const SETTINGS_ID = 'app';

export interface Profile extends BaseRecord {
  id: typeof PROFILE_ID;
  name: string;
  callMe: string;
  about: string;
  location?: GeoPlace;
  units: Units;
  lifeEvents: LifeEvent[];
  notes: ProfileNote[];
  reminders: Reminder[];
  interests: string[];
  avoidTopics: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Memory (core/memory): what the hosts remember about the listener. Long-term = a bounded set of short cards, synced
// with the account; short-term = a per-day journal of what happened on the radio, 14 days, on this device only.

/** about = About you, people, preferences, routines = Routines and patterns, plans = Plans and dates, jokes = Running jokes */
export type MemoryKind = 'about' | 'people' | 'preferences' | 'routines' | 'plans' | 'jokes';
/** where a card came from: a call-in, the listener's AI app, how they listen, or they added it themselves */
export type MemorySource = 'callin' | 'app' | 'listening' | 'you';

export interface MemoryCard extends BaseRecord {
  /** one short fact about the listener, at most 200 characters ("Your sister Ana visits the weekend of November 7") */
  text: string;
  kind: MemoryKind;
  source: MemorySource;
  /** when it was said or first learned (the "where it came from" line) */
  learnedAt: number;
  /** epoch ms: a plan is forgotten after this */
  expiresAt?: number;
  pinned?: boolean;
  /** the listener changed its words in the app (it is theirs now: the hosts never rewrite it) */
  editedAt?: number;
  /** health, money, relationships, religion or politics: kept only because the listener asked */
  sensitive?: boolean;
  /** a pattern from how they listen: the rule that found it (updated in place) and its evidence */
  pattern?: string;
  evidence?: { count: number; days: number };
}

// ---------- Your list (core/tracker) ----------

/** todo = to do for you, waiting = waiting on someone, prepare = an event to prepare for, invite = an invitation to answer */
export type TrackedKind = 'todo' | 'waiting' | 'deadline' | 'bill' | 'delivery' | 'invite' | 'prepare';
/** where an item came from: outside content (email, event, notion, gtask) is information, never instructions */
export type TrackedSourceType = 'email' | 'event' | 'notion' | 'gtask' | 'you' | 'ai-app';
export type TrackedStatus = 'open' | 'done' | 'snoozed' | 'dismissed';

export interface TrackedSource {
  type: TrackedSourceType;
  /** the source record's id (mail id, event id "cal:id", Notion page id, Google task id) */
  id?: string;
  /** opens the source (never read on air) */
  link?: string;
  /** a short label for the list ("Email from Dana Reyes", "You said it on a call-in") */
  label: string;
  /** sender / organizer display name */
  from?: string;
  /** sender email, lowercase */
  address?: string;
}

export interface TrackedItem extends BaseRecord {
  /** one short line, at most 160 characters ("Send the three vendor quotes to Dana") */
  what: string;
  kind: TrackedKind;
  /** YYYY-MM-DD (a day) or an ISO time */
  due?: string;
  dueAllDay?: boolean;
  /** epoch ms: an app reminder ("remind me at 5") */
  remindAt?: number;
  who?: string;
  source: TrackedSource;
  status: TrackedStatus;
  snoozedUntil?: number;
  doneAt?: number;
  doneBy?: 'you' | 'call-in' | 'google' | 'app';
  /** careful = looks like phishing or asks for money/codes/logins; newSender = the listener never emailed them */
  flags?: { careful?: boolean; newSender?: boolean; why?: string };
  /** dedupe key: source + meaning */
  key: string;
  /** later evidence says it may be done ("thanks for the quotes"): the hosts ask, never close it themselves */
  suggestDone?: { why: string; at: number };
  /** the Google task it mirrors */
  gtask?: { listId: string; taskId: string };
  /** a Plans memory card it belongs to */
  memoryId?: string;
  /** how often the hosts brought it up */
  mentions?: { count: number; lastAt: number };
}

/** said = a call-in, app = a message from their AI app, the rest is how they listen */
export type JournalKind = 'said' | 'app' | 'headsup' | 'gotit' | 'liked' | 'skipped' | 'requested' | 'listened' | 'covered' | 'breakSkipped';

export interface JournalEntry {
  id: string;
  /** epoch ms */
  at: number;
  /** YYYY-MM-DD, local */
  day: string;
  kind: JournalKind;
  /** a compact line ("Long Drive by Test Band", "asked about the Q4 review") */
  text: string;
  /** songs: the artist (patterns); breaks: the segments; listened: the station */
  artist?: string;
  genre?: string;
  segments?: string[];
  stationId?: string;
}

export type ThemePref = 'dark' | 'light' | 'system';

/** Per-integration switches. Each integration owner adds its own optional key. */
export interface Connections {
  weather?: { enabled: boolean };
  calendar?: { google: boolean; icsUrls: string[] };
  email?: { gmail: boolean; imap: boolean };
  /**
   * Account news. feeds = the listener's own list (missing = the default feeds of `region`, or of the region guessed
   * from the device). Stations with no newsFeeds of their own use these (core/context/news.ts).
   */
  news?: { enabled: boolean; feeds?: string[]; region?: string };
  /** clientId = the user's own Spotify app (tokens live in kv 'spotify:tokens') */
  spotify?: { connected: boolean; clientId?: string; displayName?: string };
  youtube?: { connected: boolean };
  subsonic?: { url: string; username: string; secretRef?: string };
  anyApp?: { enabled: boolean };
  aiApps?: { enabled: boolean };
  /** Notion linked on the server (hosts read the pages chosen there and add notes when asked) */
  notion?: { connected: boolean };
  /**
   * The hosts look things up (core/agent): enabled (default on when a host has a real AI brain) and web search
   * (default on where the server offers it).
   */
  lookups?: { enabled?: boolean; web?: boolean };
  /**
   * The hosts can do things, only when the listener says yes (core/actions): calendar = add events / answer
   * invitations on Google Calendar, tasks = use Google Tasks (taskLists = the lists read into Your list; none = all).
   * Off by default; turning one on asks Google for that permission.
   */
  actions?: { calendar?: boolean; tasks?: boolean; taskLists?: string[] };
  /**
   * The hosts' tools (core/agent/kit, docs/AGENT.md): policy[toolName] = 'auto' (allowed without asking), 'ask'
   * (ask first) or 'off'; a tool missing here keeps its default.
   */
  agent?: { policy?: Record<string, 'auto' | 'ask' | 'off'> };
  /** Your list (core/tracker): enabled (default on), fromMail/fromEvents/fromNotion = what the hosts may track */
  tracker?: { enabled?: boolean; fromMail?: boolean; fromEvents?: boolean; fromNotion?: boolean };
  /**
   * Heads-ups (core/agent/headsup.ts): something important in the listener's day changed while the radio plays.
   * breakIn: urgent ones break in over the music ('now', the default), wait for the song's end ('after') or wait
   * for the next break ('off'). remindMin: a reminder this many minutes before a meeting with guests or a video
   * call (0 = off, default 10).
   */
  headsUps?: { breakIn?: 'now' | 'after' | 'off'; remindMin?: 0 | 5 | 10 | 15 };
  /**
   * Memory (core/memory): learn from what the listener says (call-ins, their AI app) and from how they listen
   * (likes, skips, hours). Both on unless turned off; "remember that ..." is honored either way.
   */
  memory?: { fromWords?: boolean; fromListening?: boolean };
}

export interface Settings extends BaseRecord {
  id: typeof SETTINGS_ID;
  theme: ThemePref;
  serverUrl?: string;
  activeStationId?: string;
  connections: Connections;
  onboarded: boolean;
}

/** kv: offline cache rows (weather, calendar, email, news snapshots). id = the cache key. */
export interface KvRecord<T = unknown> extends BaseRecord {
  value: T;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Context packet (core/context)

export type PartOfDay = 'early-morning' | 'morning' | 'afternoon' | 'evening' | 'night' | 'late-night';

export interface WeatherSnapshot {
  place: string;
  /** in the listener's units */
  temperature: number;
  feelsLike?: number;
  condition: string;
  high?: number;
  low?: number;
  precipitationChance?: number;
  units: Units;
  fetchedAt: number;
}

/** Called `Event` in ARCHITECTURE.md; renamed to avoid the DOM Event type. */
export type RsvpStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction';

export interface LinkRef {
  url: string;
  label?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end?: number;
  allDay: boolean;
  location?: string;
  source: 'google' | 'ics';
  /** the calendar's name */
  calendar?: string;
  /** the listener's access to that calendar (Google): reader / freeBusyReader = a subscription they do not own */
  calendarRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  // The details (Google and ICS, all optional): what it is about and who is in it. Links are never read aloud.
  /** clean text, no HTML or links, capped */
  description?: string;
  links?: LinkRef[];
  organizer?: string;
  /** the listener organizes it */
  organizerSelf?: boolean;
  creator?: string;
  /** people invited (the rooms not counted, extra guests counted) */
  guests?: number;
  attendees?: { name: string; status: RsvpStatus; organizer?: boolean; self?: boolean; optional?: boolean }[];
  rooms?: string[];
  /** the listener's own answer */
  myResponse?: RsvpStatus;
  /** someone else invited the listener and they have not answered yet */
  invitation?: boolean;
  /** the video call: provider name for the hosts, the link for the app only */
  video?: { provider: string; url: string };
  /** attachment titles */
  attachments?: string[];
  /** "weekly", "every weekday" ... */
  recurrence?: string;
  /** part of a series whose rule was not read */
  recurring?: boolean;
  /** open in the calendar app */
  link?: string;
  /** last change (ms): a changed event is researched again */
  updated?: number;
  uid?: string;
}

export interface EmailSummary {
  id: string;
  from: string;
  /** the sender's email address, lowercase (new-sender checks; never read on air) */
  address?: string;
  subject: string;
  snippet?: string;
  important: boolean;
  at: number;
  threadId?: string;
  source?: 'gmail' | 'imap';
  /** what the message says (clean, quotes and signature out, capped); the first few and invitations */
  body?: string;
  links?: LinkRef[];
  /** messages in its conversation */
  threadSize?: number;
  /** a calendar invitation (or an answer to one), linked to its event */
  invite?: {
    method?: 'request' | 'reply' | 'cancel';
    eventId?: string;
    uid?: string;
    title?: string;
    answer?: string;
    /** Gmail's "Invitation from an unknown sender": Google holds it off the calendar until answered in the email */
    unknownSender?: boolean;
  };
}

export interface Headline {
  id: string;
  title: string;
  source: string;
  url?: string;
  at?: number;
}

export type InboxKind = 'note' | 'segment' | 'song_request' | 'life_event';

/** Items pushed by AI apps over MCP (server inbox). */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  text: string;
  hostName?: string;
  until?: number;
  /** life_event: YYYY-MM-DD and whether it repeats */
  date?: string;
  yearly?: boolean;
  /** the AI app connection that sent it */
  source?: string;
  createdAt: number;
}

export type HeadsUpKind = 'cancelled' | 'moved' | 'new' | 'changed' | 'invite' | 'urgent' | 'reminder';

/** Something important that just changed in the listener's day, told on air once (core/agent/headsup.ts). */
export interface HeadsUp {
  /** the dedupe key: one heads-up per change, ever */
  id: string;
  kind: HeadsUpKind;
  /** the event title or the mail subject */
  title: string;
  /** the plain facts to tell ("The Q4 budget review at 2 PM was cancelled by Dana Reyes") */
  fact: string;
  /** why it counted (shown in Settings) */
  why: string;
  /** what the calendar's own notice said (Google's "Canceled event" mail with the organizer's note) */
  source?: string;
  /** what the hosts found out about it (follow-up questions are answered from it) */
  note?: string;
  /** a ready spoken line for a break-in, in the lead host's words */
  say?: string;
  /** urgent: breaks in over the music (else first in the next break) */
  major: boolean;
  /** when it was noticed */
  at: number;
  eventId?: string;
  mailId?: string;
  /** the event's start (the new one when it moved) */
  start?: number;
  state: 'pending' | 'aired' | 'snoozed';
  airedAt?: number;
  /** how it went on air */
  via?: 'breakin' | 'break';
  /** what the host said */
  said?: string;
}

export interface ContextPacket {
  now: { iso: string; local: string; partOfDay: PartOfDay; weekday: string };
  listener: { name: string; callMe: string; about: string; interests: string[]; avoid: string[] };
  songBefore?: TrackSummary;
  songAfter?: TrackSummary;
  upcomingSongs: Track[];
  weather?: WeatherSnapshot;
  calendar?: CalendarEvent[];
  email?: EmailSummary[];
  news?: Headline[];
  lifeEvents?: LifeEvent[];
  notes?: string[];
  reminders?: Reminder[];
  inbox?: InboxItem[];
  recentBreaks: Break[];
  /** what the hosts found out about the day's items (core/agent/research.ts): researched, else scripted */
  dossiers?: Dossier[];
  /** heads-ups waiting for this break: they go first */
  headsUps?: HeadsUp[];
  /** the listener hid the YouTube video (phone and desktop apps): YouTube songs wait until it shows again */
  youtubeHidden?: boolean;
  /** answers to questions from the listener's AI app, by inbox item id */
  inboxAnswers?: Record<string, { answer: string; found: boolean }>;
  /** what the hosts remember about the listener, picked for this break (core/memory/brief.ts) */
  memory?: MemoryBrief;
  /** Your list items this break may bring up (core/tracker/brief.ts) */
  tracker?: { lines: string[]; ids: string[]; spoken: string[]; asks?: string[] };
}

export interface MemoryBrief {
  /** the cards for this break, as prompt lines */
  facts: string[];
  /** a few journal lines from the last day or two, when they fit this break */
  recently: string[];
  /** segments the listener's patterns say to play down right now ("Skips the news before 9 AM") */
  quieter: string[];
  /** ids of the cards in `facts` */
  ids: string[];
  /** the soonest plan in the next 3 days (the scripted fallback mentions it in an opening break) */
  soon?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Player (core/player)

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface PlayerState {
  status: PlayerStatus;
  track?: Track;
  index: number;
  queue: Track[];
  positionMs: number;
  durationMs: number;
  /** play order is shuffled (queue keeps the play order; see core/player/queue.ts) */
  shuffle?: boolean;
  repeat?: RepeatMode;
  /** master volume 0..1 */
  volume?: number;
  muted?: boolean;
  /** a holdAfterCurrent break is running between two tracks */
  holding?: boolean;
  /** music is ducked under a voice */
  ducked?: boolean;
  /** endless track (internet radio stream): no duration, no seek */
  live?: boolean;
  /**
   * The phone apps play YouTube only while the app is on screen. 'screen': the current YouTube song waits, paused,
   * until the app is back; 'resume': the app came back after a long time and offers to resume instead; 'video': the
   * listener hid the YouTube window and nothing else may play, so the YouTube song waits until the video shows again.
   */
  waiting?: 'screen' | 'resume' | 'video';
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface PlayerEvents {
  state: PlayerState;
  trackstart: Track;
  trackend: Track;
  /** fires ~20 s before the end of the track */
  nearend: Track;
  error: Error;
  /** a song that cannot play here (embedding off, removed, region) was left out; the player moved on */
  skipped: { track: Track; reason: string };
  /** the listener pressed Next on a song (memory: skipped early or not) */
  userskip: { track: Track; positionMs: number; durationMs: number };
  /** the listener pressed Next while the hosts talked (memory: which segments they skip) */
  breakskip: undefined;
}

export type PlayerEventName = keyof PlayerEvents;

export interface AdapterEvents {
  play: void;
  pause: void;
  ended: void;
  time: { positionMs: number; durationMs: number };
  error: Error;
}

/** One per playback backend (HTML audio, YouTube, Spotify ...). */
export interface PlayerAdapter {
  readonly id: string;
  canPlay(track: Track): boolean;
  load(track: Track): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(ms: number): void;
  volume(level: number): void;
  /** optional smooth fade to `level` over `ms` (adapters outside Web Audio); the player falls back to volume() steps */
  rampVolume?(level: number, ms: number): void;
  /** optional: stop and release the current source (called when the player switches to another adapter) */
  unload?(): void;
  /** optional: checks ahead (while another song plays) that `track` can play here; rejects with a PlaybackError */
  probe?(track: Track): Promise<void>;
  on<E extends keyof AdapterEvents>(event: E, cb: (payload: AdapterEvents[E]) => void): () => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Radio (core/radio)

export interface RadioState {
  stationId?: string;
  onAir: boolean;
  speakingHostId?: string;
  caption?: string;
  /** songs until the next break */
  nextBreakIn: number;
  lastBreak?: Break;
  /** off = not on air, music = songs playing, preparing = writing/voicing a break, talking = a break is airing */
  phase?: RadioPhase;
  /** the break on air right now (all lines, for full captions) */
  script?: BreakLine[];
  /** index into `script` of the line being spoken */
  lineIndex?: number;
  /** last user-facing problem (brain or voice failed; the break was skipped) */
  notice?: string;
  /** a link that fixes the notice (ChatGPT plan limit: Manage usage) */
  noticeLink?: { label: string; url: string };
}

export type RadioPhase = 'off' | 'music' | 'preparing' | 'talking';

export interface RadioEvents {
  state: RadioState;
  break: Break;
  line: BreakLine;
}

export type RadioEventName = keyof RadioEvents;

// ---------------------------------------------------------------------------------------------------------------------
// Server API (core/api)

export type SignInProvider = 'google' | 'x' | 'local' | 'apple';

export interface ServerConfig {
  version: string;
  signIn: { google: boolean; x: boolean; local: boolean };
  /** false = the server takes no new accounts */
  signups?: boolean;
  serverLibrary: boolean;
  appScheme: string;
  /** the server's own public URL (shown in Connections and docs) */
  publicUrl?: string;
  spotifyClientId?: string;
  /** "Use your ChatGPT plan" brains are on */
  chatgptPlan?: boolean;
  /** 'online' = the hosted Host-Caster service (accounts, plans, included AI); default 'selfhosted' */
  edition?: 'selfhosted' | 'online';
  online?: OnlineInfo;
}

export interface PlanInfo {
  id: 'voice' | 'brain' | 'both' | 'premium';
  name: string;
  short: string;
  blurb: string;
  price: string;
  interval: 'month';
  /** premium = the premium voices (the Premium plan); older servers leave it out */
  includes: { brain: boolean; voices: boolean; premium?: boolean };
}

/** GET /api/config in the online edition */
export interface OnlineInfo {
  signIn: { email: boolean; apple: boolean };
  billing: boolean;
  freePlan: boolean;
  plans: PlanInfo[];
  /** Host-Caster AI and Host-Caster Voices are set up */
  included: boolean;
  budgetsUsd: { brain: number; voice: number; premium: number };
}

/** A linked sign-in. scopes = Google services granted ('calendar' | 'gmail' | 'youtube'). */
export interface ApiIdentity {
  provider: 'google' | 'x';
  /** email or @handle */
  label: string;
  scopes: string[];
  linkedAt: number;
}

export interface ApiUser {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  providers: SignInProvider[];
  identities?: ApiIdentity[];
  hasPassword?: boolean;
  createdAt?: number;
  /** online edition: the email is confirmed (needed for everything) */
  emailVerified?: boolean;
  /** online edition: may open the admin page */
  admin?: boolean;
}

export interface ApiSession {
  user: ApiUser;
  kind: 'web' | 'app';
  /** bearer token on native; undefined on web (cookie) */
  token?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface SyncDoc {
  hosts: Host[];
  stations: Station[];
  brains: Brain[];
  voices: VoiceProvider[];
  profile?: Profile;
  settings?: Partial<Settings>;
  playlists: Omit<Playlist, 'trackIds'>[];
  /** what the hosts remember (the server keeps them sealed at rest) */
  memories: MemoryCard[];
  /** Your list (the server keeps it sealed at rest) */
  tracker?: TrackedItem[];
  /** tombstones: '<collection>:<id>' -> deletedAt (ms), so deletions reach other devices */
  deleted?: Record<string, number>;
}

export interface ServerTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  year?: number;
  genre?: string;
  durationMs: number;
  hasArt: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Native (core/native)

export type Platform = 'web' | 'android' | 'ios';

export interface MediaMeta {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
}

export interface AnyAppTrack {
  packageName: string;
  appName: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
}
