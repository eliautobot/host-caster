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

export type TrackSource = 'local' | 'server' | 'spotify' | 'youtube' | 'stream' | 'subsonic';

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
  /** local blob id, server track id, spotify URI, YouTube videoId, stream URL or subsonic id */
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
export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end?: number;
  allDay: boolean;
  location?: string;
  source: 'google' | 'ics';
}

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet?: string;
  important: boolean;
  at: number;
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
   * until the app is back; 'resume': the app came back after a long time and offers to resume instead.
   */
  waiting?: 'screen' | 'resume';
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
