# Host-Caster: architecture contract

Host-Caster is a personal AI radio station. Your music (local files, a self-hosted server library, Spotify, YouTube Music,
internet radio, or any music app on Android) plays like a station, and AI hosts you design break in between songs to
talk about the songs, your day (calendar, email, weather, news, life events, notes) and each other.

One codebase, three targets: web app (PWA, served by the server), Android and iOS (Capacitor). Local first: everything
works on the device with no account and no internet (local songs, device voice, a model on the LAN, and the scripted fallback
when no AI is connected). Signing in (Google or X, or a local password on self-hosted servers) adds sync and cloud features.

This file is the contract between modules. Change it only together with the code that depends on it.

## Repo layout

```
app/                     Vite 8 + React 19 + TypeScript client (web, Android, iOS)
  src/core/              no React here (pure TS): db, player, radio, ai, voice, context, services, api, native
  src/ui/                React: components/, screens/, player/, layout/, theme.css, tokens.css
  src/state/             zustand stores (thin; logic lives in core)
  android/ ios/          Capacitor native projects (own Java/Swift plugin code inside)
server/                  Node 24 ESM, Fastify 5, node:sqlite, no native deps
  src/                   index.js, config.js, db.js, auth/, routes/, integrations/, mcp/, library/
  test/                  node:test
docs/                    SELF-HOSTING.md, PROVIDERS.md, PRIVACY.md, screenshots/
Dockerfile, docker-compose.yml, .github/workflows/ci.yml, README.md, LICENSE
```

Code style: small files (under ~400 lines), named exports, no default exports except React screens, no `any` unless
commented. Every module owner keeps to their folders; shared files are edited with small targeted edits only.

## Look and feel

Dark by default, light theme supported (system). Neutral greys, no purple anywhere. Tokens in `app/src/ui/tokens.css`:
`--bg #0a0a0b`, `--surface #131315`, `--surface-2 #1b1b1e`, `--surface-3 #242428`, `--line #2a2a2e`,
`--text #f4f4f5`, `--text-2 #a1a1aa`, `--text-3 #71717a`, `--accent #ff5a36` (on-air signal orange, used sparingly:
ON AIR badge, live dots, active states), `--accent-2 #ffb020` (warm highlight), `--ok #22c55e`, `--danger #ef4444`.
Font: Inter Variable (bundled, works offline). Radius 12/16/24, generous spacing, soft shadows, 150-250 ms motion.
Layout like YouTube Music / Spotify: desktop = left sidebar + content + bottom player bar; phone = content + mini
player + bottom tab bar (Home, Stations, Library, Hosts, Settings via avatar). Full-screen Now Playing sheet.
Icons: lucide-react. Host avatars: photo, emoji or generated gradient monogram (warm/neutral palettes only).

## Client data model (IndexedDB via Dexie, `app/src/core/db/`)

All records have `id: string` (nanoid), `createdAt`, `updatedAt` (ms). Types live in `app/src/core/types.ts`.
The database is named `hostcaster`. On first start after the rename to Host-Caster, `core/db/legacy.ts` copies the
database of the app's old name into it once (renaming the app's own names in stations, hosts, brains, voices and the
on-air log), then deletes the old one; `index.html` moves the theme key the same way.

- `tracks`: `{ id, title, artist, album, albumArtist?, year?, genre?, durationMs, artworkId?, artUrl?, source, ref,
  liked?, playCount, lastPlayedAt?, addedAt }`. `source`: `'local' | 'server' | 'spotify' | 'youtube' | 'stream' |
  'subsonic'`. `ref`: local blob id, server track id, spotify URI, YouTube videoId, stream URL, subsonic id. `artUrl`:
  a public cover URL (synced; another device shows it until it stores its own cover).
- `blobs`: `{ id, blob, mime, size }` audio files and artwork (web and native both use IndexedDB blobs).
- `playlists`: `{ id, name, description?, trackIds: string[], coverId?, source: 'local'|'spotify'|'youtube'|'m3u'|
  'subsonic', remoteKey? }`. `trackIds` may hold ids with no track here (a file added on another device keeps its
  place); lists skip them and the playlist says "N songs on another device". `remoteKey` (`'youtube:LL'`): imported
  from a service, so another device's import fills this playlist instead of making a second one.
- `hosts`: see Host below. `stations`: see Station below.
- `brains`: AI provider connections `{ id, name, kind, preset?, baseUrl?, apiKey?, model, temperature?, transport }`.
- `voices`: voice provider connections `{ id, name, kind, baseUrl?, apiKey?, transport }`.
- `breaks`: on-air log `{ id, stationId, at, lines: [{ hostId, text }], topics: string[], songBefore?, songAfter? }`.
- `profile` (single row id `'me'`): `{ name, callMe, about, location?: { name, lat, lon }, units: 'metric'|'imperial',
  lifeEvents: [{ id, title, date: 'YYYY-MM-DD', yearly: boolean, notes? }], notes: [{ id, text, until? }],
  reminders: [{ id, text, at }], interests: string[], avoidTopics: string[] }`.
- `settings` (single row id `'app'`): `{ theme, serverUrl?, activeStationId?, connections: {...}, onboarded }`.
- `kv`: misc cache (weather, calendar, email, news snapshots with `fetchedAt`), used offline.

### Host
```
{ id, name, avatar: { kind: 'emoji'|'image'|'monogram', value, color }, tagline,
  personality: string,        // free text: who they are
  style: string,              // how they talk
  energy: 1..5, humor: 1..5, verbosity: 1..5,
  language: 'en',             // BCP-47
  catchphrases: string[], topics: string[], avoid: string[],
  voice: { voiceProviderId: string /* 'device' built in */, voiceId: string, speed: number, pitch: number,
           instructions?: string },
  brainId: string | null      // null = no AI brain yet: the scripted fallback reads their lines
}
```
### Station
```
{ id, name, frequency: string /* "88.1" display only */, color, description?,
  sources: [{ kind: 'library'|'playlist'|'liked'|'server'|'spotify-playlist'|'youtube-playlist'|'stream'|'anyapp',
              ref?: string }],
  hostIds: string[],          // 1..4, first = lead
  talkEvery: number,          // songs between breaks, 1..10
  talkLength: 'short'|'normal'|'long',   // ~1-2 / 3-4 / 5-8 lines total
  segments: { songs, time, weather, calendar, email, news, lifeEvents, notes, reminders, funFacts: boolean },
  talkOverIntro: boolean, duckLevel: number /* 0..1 music volume under voice, default 0.18 */,
  newsFeeds: string[], shuffle: boolean }
```

## Core modules and their public APIs

`core/player/` (owner: player agent). One singleton `player`:
```
player.load(queue: Track[], startIndex?), play(), pause(), toggle(), next(), prev(), seek(ms), setVolume(0..1)
player.state: { status: 'idle'|'loading'|'playing'|'paused', track?, index, queue, positionMs, durationMs }
player.on('state'|'trackstart'|'trackend'|'nearend'|'error'|'skipped', cb)   // 'nearend' fires ~20 s before the end
  // 'skipped' { track, reason }: a song that cannot play here was left out and the next one plays
player.duck(level: number, rampMs = 400), player.unduck(rampMs = 600)
player.playVoice(src: Blob | string /* url */): Promise<void>  // plays over music, resolves when finished
player.holdAfterCurrent(fn: (signal: AbortSignal) => Promise<void>, opts?: { maxMs?: number })
  // run fn (a break) between this track and the next; cut after 25 s without voice activity or maxMs (180 s)
player.introNext(duckLevel)   // starts the next song under the last line; returns without waiting for it to play
player.playSting(src), player.stopVoice(), player.markActivity(), player.registerAdapter(adapter)
player.aheadReady(maxMs)      // the next songs were checked ahead (adapters with probe()), unplayable ones dropped
```
A song that does not start is classified (`core/player/errors.ts` `PlaybackError` kind): `unplayable` (YouTube
embedding off, removed, private) is remembered for 14 days (kv `player:unplayable`, stations leave it out), noted with
'skipped' and the next song plays, whoever started it; `needs-gesture` (browser autoplay rules) pauses and asks for a
tap; `failed` (network ...) plays on when the start was automatic (at most 4 in a row), else pauses with the reason.
Music and voice go through one Web Audio graph (music gain + voice gain) so ducking is smooth. Sources resolve to a
playable URL via `core/services/resolve.ts` (local blob URL, server stream URL, YouTube/Spotify use their own player
adapters implementing the same `PlayerAdapter` interface: `load(track), play(), pause(), seek, volume, on(...)`,
optional `probe(track)` to check a song ahead). YouTube (`core/services/youtube/`): every new video starts with
`loadVideoById` and never right after a cue (a cue lands late and wins: the video would stay cued), a start
watchdog resends once and gives up in 9 s (20 s while buffering), and a hidden second player cues the next two
videos during the current one so an unplayable one leaves the queue before a host names it.
Media Session API is set for every track (lock screen / notification controls).

`core/radio/` (owner: radio agent). `radio` drives a station on top of `player`:
```
radio.start(stationId), radio.stop(), radio.state: { stationId?, onAir: boolean, speakingHostId?, caption?,
  nextBreakIn: number /* songs */, lastBreak? }
radio.talkNow(prompt?: string)    // "Talk to the host": user call-in, breaks in right away ("play X" = song request)
radio.reload()                    // picks up station edits from the next break; radio.skipBreak()
radio.on('state'|'break'|'line', cb)
```
Break flow: on `trackstart` decide if a break follows this track; ~80 s before its end (earlier when recent breaks
were slow: twice the slowest of the last five plus 20 s, at most 240 s; right away for short tracks) build the
context packet, generate the script, voice all lines (4 at a time), with brain and voice budgets that fit the
song's end. The break is ready once the script and the FIRST clip are; later clips finish while it airs (a line
whose clip is 4 s late is read by the device voice). `holdAfterCurrent` airs it: the ident rings and the first line
comes in 450 ms into it, lines with music ducked, optional talk over the next intro.
If generation fails or is late, skip the break, never leave silence. Multi-host: if all hosts share one brain, one
call returns the whole script as JSON lines; otherwise turn by turn, each host's own brain sees the transcript so far.
The scripted fallback (`core/radio/builtin.ts`, varied template lines from the same context packet, no network) is never
a choice: it speaks for hosts with no AI brain (`brainId` null, a deleted brain) and stands in when the AI fails, is
late, offline or at a plan/usage limit (Home says why). It is the virtual brain `FALLBACK_BRAIN` (kind `builtin`,
never stored). Hosts saved with the old "Built-in host" (`'builtin'` or a stored brain of that kind) move to null once:
on the device (`core/db/noBrain.ts`, kv flag), in pulled sync docs, and on the server (db migration 5 and every PUT,
`server/src/routes/syncDoc.js`). Home shows a dismissible "reading scripted lines" banner while no host on the
station has an AI.
Song requests (a call-in "play X", or `request_song` from an AI app via the inbox) are matched against the queue and
the library (`core/radio/requests.ts`), played next with `player.playNext`, and named once per break (a call-in: in the
answer; a request that is the next song: only in the intro line); a request that is not in the library is answered
honestly. Aired breaks live in `breaks` (On-air history screen `#/on-air`).

`core/ai/` brains. `generate(brain, { system, messages, json?: boolean, maxTokens }) => Promise<string>`.
Kinds: `openai` (any OpenAI-compatible chat completions: OpenAI, xAI Grok, OpenRouter, Groq, Mistral, DeepSeek,
Together, Fireworks, Meta Llama API, Google Gemini via its OpenAI endpoint, Ollama, LM Studio, llama.cpp, vLLM, Jan,
LocalAI, any custom URL), `anthropic` (Messages API), `builtin` (the scripted fallback, virtual), `connector` (an AI app connected over MCP that
pushes notes and segments; see Server), `chatgpt` (the user's ChatGPT plan via Sign in with ChatGPT; always the
`'server'` transport: the server keeps each user's ChatGPT sign-in and calls the Responses API). Presets in `core/ai/presets.ts` (name, kind, baseUrl, default model, key
URL, local: boolean). `listModels(brain)`, `testBrain(brain)`.
Transport: `'device'` (direct fetch; on native `CapacitorHttp` so no CORS, LAN and localhost work offline) or
`'server'` (POST `/api/ai/chat`, server holds the key). New entries start on `'device'`; the brain and voice sheets
offer `'server'` when signed in.

`core/voice/` voices. `speak(host, text) => Promise<VoiceClip>` where `VoiceClip = { kind: 'audio', blob } |
{ kind: 'device', text, voiceId, rate, pitch }` (device speech is spoken live by `voice.playClip`).
Kinds: `device` (built in: Web Speech on web, native TTS plugin on Android/iOS), `openai` (`/v1/audio/speech`,
gpt-4o-mini-tts with `instructions` from the host's style), `elevenlabs`, `openai-compatible` (Kokoro, Chatterbox,
Qwen3-TTS, Orpheus, openedai-speech ...). `listVoices(voiceProvider)`, `previewVoice(host)`.

`core/context/` builds the packet the hosts talk from:
```
buildContext(station, { songBefore, songAfter }) => Promise<ContextPacket>
ContextPacket = { now: { iso, local, partOfDay, weekday }, listener: { name, callMe, about, interests, avoid },
  songBefore?, songAfter?, upcomingSongs: Track[], weather?, calendar?: Event[], email?: EmailSummary[],
  news?: Headline[], lifeEvents?: LifeEvent[], notes?: string[], reminders?: Reminder[], inbox?: InboxItem[],
  recentBreaks: Break[] }
```
Each source caches its last snapshot in `kv` with `fetchedAt` so the radio keeps working offline. Weather: Open-Meteo
(no key). Calendar: Google (server) and ICS feeds. Email: Gmail (server) and IMAP (server). News: RSS feeds.
Topic rotation and cooldowns live in `core/radio/planner.ts` (do not repeat a calendar item within 45 min, etc.).

`core/api/` (owner: server agent) typed client for the server: `api.baseUrl`, `api.session`, `auth.signIn('google'|
'x'|'local')`, `auth.signOut()`, `sync.pull()/push()`, `aiProxy`, `ttsProxy`, `integrations.calendar()`, `.email()`,
`.fetchText(url)` (ICS/RSS through the server), `inbox.poll()`, `youtube.*`, `serverLibrary.*`.
Signed out = local-only mode; every caller must handle `api.available === false`.

`core/native/` (owner: native agent) thin wrappers that no-op on web: `isNative`, `platform`, `nativeTts`,
`audioFocus.duck()/release()`, `mediaNotification.update(meta, playing)` + events, `anyApp` (Android: other music
apps' now playing via notification access; events `trackchange`, `playstate`), `openAuthUrl(url)`,
`onDeepLink(cb)`, `speechToText()`, `pickAudioFiles()`.

## Server (Node 24, Fastify 5, node:sqlite)

Config from env (and `.env`): `PORT` (8660), `PUBLIC_URL`, `DATA_DIR` (./data), `SECRET_KEY` (32 bytes base64,
generated into DATA_DIR on first start if missing), `GOOGLE_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`,
`ALLOW_LOCAL_ACCOUNTS` (true when no OAuth is configured), `MUSIC_DIR` (optional server library),
`ALLOW_PRIVATE_FETCH` (false), `APP_SCHEME` (`hostcaster`).

Tables: `users`, `identities` (provider, subject, encrypted tokens), `sessions` (sha256 token, kind web|app,
expires), `sync_docs` (user_id, json, rev), `sync_items` (user_id, kind, id, json or NULL = deleted, updated_at, seq)
and `sync_item_meta` (user_id, seq, pruned_seq), `secrets` (encrypted provider keys), `inbox` (notes/segments from AI apps),
`connector_tokens`, `server_tracks`, `chatgpt_accounts` (per user: issued ChatGPT client id, verified subject, sealed
tokens; the install's agent host id lives in `DATA_DIR/chatgpt-host.json`).
Secrets at rest: AES-256-GCM with SECRET_KEY; API keys never returned to clients in clear unless the owner asks.

Routes (JSON, errors `{ error: { code, message } }`):
- `GET /api/health`, `GET /api/config` (which sign-ins are on, server library on, version).
- Auth: `GET /auth/google/start?app=1&scopes=calendar,gmail,youtube`, `GET /auth/google/callback`,
  `GET /auth/x/start`, `GET /auth/x/callback` (OAuth 2.0 PKCE, `users.read tweet.read`), `POST /api/auth/local/signup`,
  `POST /api/auth/local/login`, `POST /api/auth/exchange {code, verifier}` (native: one-time code from the
  `hostcaster://auth?code=` deep link plus the verifier whose hash the app sent as `cc` on `/auth/<p>/start?app=1`,
  returns a bearer token), `POST /api/auth/link/finish {code, verifier}` (native link with a ticket: the
  `hostcaster://auth?linkcode=` code, finished with the account's bearer session), `POST /api/auth/logout`, `GET /api/me`,
  `DELETE /api/me` (delete account and data). Web = httpOnly cookie, native = `Authorization: Bearer`.
  CSRF: cookie sessions require header `X-HostCaster: 1` on writes.
- Sync: `GET /api/sync` -> `{ rev, doc }`, `PUT /api/sync {rev, doc}` (409 on stale rev). Doc holds hosts, stations,
  brains/voices (keys replaced by `secretRef`), profile, settings, playlists metadata (no trackIds). Songs, playlist
  lists and unplayable marks: `GET /api/sync/items?since=<seq>&limit=` -> `{ items, cursor, more, reset? }` and
  `POST /api/sync/items {items}` -> `{ before, cursor, stale, refused? }` (see "Sync" below).
- Secrets: `PUT /api/secrets/:ref {value}`, `DELETE /api/secrets/:ref`, `GET /api/secrets` and
  `GET /api/secrets/:ref` (hint only; values never go back to a client).
- AI and voice proxy: `POST /api/ai/chat`, `POST /api/ai/models`, `POST /api/tts` (audio bytes), `POST /api/tts/voices`.
- ChatGPT plan: `GET /api/chatgpt/status`, `POST /api/chatgpt/start` (authorize URL; redirect
  `http://127.0.0.1:<port>/auth/callback`, caught by the server's own listener or pasted back with
  `POST /api/chatgpt/finish {url}`), `GET /api/chatgpt/models`, `POST /api/chatgpt/disconnect` (revokes),
  `POST /api/chatgpt/welcome`. Errors are `chatgpt_*` codes (`chatgpt_limit` 429 = usage limit, Manage usage).
- Integrations: `GET /api/google/calendar?hours=36`, `GET /api/google/gmail?max=10` (unread, important first),
  `GET /api/google/youtube/playlists`, `GET /api/google/youtube/playlist/:id` (`?paged=1&limit=500&pageToken=`: whole
  YouTube pages + `next`, `total`, `left { private, deleted, unavailable }`, `blocked`; the app reads up to 5,000
  videos in steps, about 2 quota units per 50), `GET /api/google/youtube/search?q=`,
  `POST /api/imap/test`, `GET /api/imap/summary`, `POST /api/fetch-text {url}` (ICS/RSS; blocks private ranges unless
  ALLOW_PRIVATE_FETCH).
- Server library: `GET /api/library/tracks`, `GET /api/library/stream/:id` (Range), `GET /api/library/art/:id`,
  `POST /api/library/rescan`.
- AI apps connector (MCP, Streamable HTTP): `POST /mcp/:token`. Tools: `now_playing`, `list_hosts`,
  `send_note_to_hosts {text, until?}`, `queue_segment {text, hostName?}`, `request_song {query}`,
  `add_life_event {title, date, yearly}`. Items land in `inbox`; the client polls `GET /api/inbox` and the radio
  uses them in the next break. Tokens made in Settings -> Connections -> AI apps (`POST /api/connectors`).
- Reported AI breaks (store AI content rules): `POST /api/reports {kind: 'break', stationName?, at, lines: [{hostName,
  text}], note?}` (signed in; at most 20 lines, 8 KB, 20 a day per account) -> table `reports` (migration 7, goes with
  the account). Client `core/api/reports.ts`; "Report this break" (`ui/radio/ReportBreakSheet.tsx`) on each break in
  On-air history and on the Now Playing On Air strip.
- Static: serves `app/dist` with SPA fallback; `/sw.js` and manifest for the PWA.

### Editions

This repository is the self-hosted edition: `GET /api/config` reports `edition: 'selfhosted'`. The hosted service at
host-caster.com runs an online edition (accounts with verified emails, plans, included AI and voices) whose server code
is not part of this repository; the app keeps its client side (`core/api/online.ts`, `state/plan.ts`, `ui/online/*`,
the `/plans` and `/settings/plan` screens) so the same app can sign in to either kind of server. Brains and voices of
kind `hostcaster` only work on the hosted service.


## Sync

Signed in, every device keeps a copy of the account and syncs in rounds (`core/api/sync.ts`: on start, 2 s after a
local change, on focus, every 5 minutes). A round is the doc, then the items.

- **The doc** (`sync_docs`, one JSON per account with a rev): hosts, stations, brains, voices, profile, settings,
  playlist names. Three-way merge per record (`core/api/merge.ts`): newer `updatedAt` wins, deletions travel as
  tombstones (`deleted`, 90 days). A device joining an account that already has a doc leaves its untouched starter
  records (`seed-*`) out, so a new browser never brings the demo station back.
- **The items** (`sync_items`, one row per record, `core/api/syncItems.ts`): `track` (a song that is a reference:
  YouTube, Spotify, a stream, a Subsonic or server library song; files never sync), `members` (a playlist's songs in
  order) and `unplayable` (a song that cannot play, so other devices skip it too). Songs are keyed `<source>:<ref>`,
  not by local track id (two devices that imported the same video hold different ids); a song new to a device takes
  the id it has on the device that added it when that id is free (a stream station's source is a track id); a list
  holds song keys, and a file as `#<its id on its device>`. The record has the tags, `liked` and a public cover URL; play counts, files and
  cover blobs stay on the device. Pulls are incremental by the account's change counter `seq` (pages of 1,000);
  pushes carry only records whose content changed since they were last synced (a hash per record in kv
  `sync:items:*`), 500 per request. Songs and marks: the newer `updatedAt` wins, the server answers a losing push
  with its own version (`stale`). Lists: compare-and-set on `base` (the server version the device edited); refused,
  the device merges three ways (the other device's order, minus what it removed, plus what it added) and pushes again.
  Tombstones live 180 days; a device whose cursor is older (or unknown to the server) gets `reset` and starts over
  without deleting anything. Limits: 16 KB a song, 1 MB a list, `SYNC_MAX_ITEMS` (50,000) per account (`refused`
  records stay on their device; Settings > Account says so). A list that arrives before its playlist waits in kv.
- **Older apps** only know `GET/PUT /api/sync`; their doc never carries songs, so their pushes cannot delete or
  overwrite synced songs. A newer app on an older server (404 on `/api/sync/items`) keeps doc-only sync.

## Auth flow for native apps

App opens `${server}/auth/google/start?app=1` in the system browser (Capacitor Browser). After the callback the
server redirects to `hostcaster://auth?code=<one-time, 2 min>`; the app catches the deep link, calls
`/api/auth/exchange`, stores the bearer token (Preferences). Same for X. Web uses the cookie directly.
Every OAuth start sets a short `hc_signin` cookie whose hash the flow keeps; the callback must bring it back (login
CSRF). Native starts also carry `cc` = base64url sha256 of a verifier the app keeps in kv (`auth:pkce`, 10 min); the
app only exchanges a deep-link code when it has that verifier, and the server only accepts the matching one.

## Android and iOS specifics

- Background play: Android foreground media service + MediaSession notification (play/pause/next) from our own
  Capacitor plugin `HostCasterAudio`; iOS audio background mode.
- Any music app mode (Android): plugin reads the active media session of other apps (needs notification access),
  emits track changes; breaks are spoken with transient audio focus (`GAIN_TRANSIENT_MAY_DUCK`) so the other app
  ducks or pauses and resumes after. iOS: speak with `.duckOthers`.
- Deep link scheme `hostcaster`. App id `com.hostcaster.app`.

## Testing

- `app`: vitest for core logic (planner, prompt builder, scripted fallback, M3U parser, context), Playwright for UI flows
  against the built app + a test server (`node e2e/<name>.e2e.mjs <baseUrl> [mediaDir]`; test songs from
  `e2e/fixtures/make-media.sh`), screenshots in `docs/screenshots/`.
- `server`: `node --test` with a temp DATA_DIR, fake OAuth providers via env overrides of the provider URLs.
- Real phone: an Android phone over adb (debug APK, WebView inspected over CDP).
