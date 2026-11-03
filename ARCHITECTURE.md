# Host-Caster: architecture contract

Host-Caster is a personal AI radio station. Your music (local files, a self-hosted server library, Spotify, YouTube Music,
internet radio, or any music app on Android) plays like a station, and AI hosts you design break in between songs to
talk about the songs, your day (calendar, email, weather, news, life events, notes) and each other.

One codebase, four targets: web app (PWA, served by the server), Android and iOS (Capacitor), and the desktop app for
Windows, Mac and Linux (Electron, `desktop/`). Local first: everything
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
desktop/                 Electron app: main/ (main process, preload.cjs, helper/ = local helper), scripts/, e2e/, test/
server/                  Node 24 ESM, Fastify 5, node:sqlite, no native deps
  src/                   index.js, config.js, db.js, auth/, routes/, integrations/, mcp/, library/
  test/                  node:test
docs/                    SELF-HOSTING.md, PROVIDERS.md, PRIVACY.md, DESKTOP.md, screenshots/
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
- `memories` (schema v2): what the hosts remember, `MemoryCard { id, text (<= 200), kind: 'about'|'people'|
  'preferences'|'routines'|'plans'|'jokes', source: 'callin'|'app'|'listening'|'you', learnedAt, expiresAt?, pinned?,
  editedAt?, sensitive?, pattern?, evidence?: { count, days } }`. At most 60. Synced (a sync doc collection).
- `journal` (schema v2): the short-term memory, `JournalEntry { id, at, day, kind: 'said'|'app'|'headsup'|'gotit'|
  'liked'|'skipped'|'requested'|'listened'|'covered'|'breakSkipped', text, artist?, genre?, segments?, stationId? }`.
  14 days, this device only.
- `tracker` (schema v3): Your list, `TrackedItem { id, what (<= 160), kind: 'todo'|'waiting'|'deadline'|'bill'|
  'delivery'|'invite'|'prepare', due? ('YYYY-MM-DD' or ISO), dueAllDay?, remindAt?, who?, source: { type: 'email'|
  'event'|'notion'|'gtask'|'you'|'ai-app', id?, link?, label, from?, address? }, status: 'open'|'done'|'snoozed'|
  'dismissed', snoozedUntil?, doneAt?, doneBy?, flags?: { careful?, newSender?, why? }, key, suggestDone?, gtask?:
  { listId, taskId }, memoryId?, mentions?: { count, lastAt }, createdAt, updatedAt }`. Synced (a sync doc collection).

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
  talkMix?: number,           // 0 = Music .. 4 = My day; missing = 3 (core/radio/planner.ts DEFAULT_TALK_MIX)
  segments: { songs, time, weather, calendar, email, news, lifeEvents, notes, reminders, funFacts: boolean },
  talkOverIntro: boolean, duckLevel: number /* 0..1 music volume under voice, default 0.18 */,
  newsFeeds: string[] /* empty = the account's news */, shuffle: boolean }
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
radio.talkNow(prompt?: string)    // an on-air call-in (AI apps, MCP): breaks in right away ("play X" = song request)
radio.setCall(on), radio.requestSong(said), radio.anyAppActive, radio.nowPlaying   // for core/call
radio.reload()                    // picks up station edits from the next break; radio.skipBreak()
radio.on('state'|'break'|'line', cb)
```
Break flow: on `trackstart` decide if a break follows this track; ~80 s before its end (earlier when recent breaks
were slow: twice the slowest of the last five plus 20 s, at most 240 s; right away for short tracks) build the
context packet, generate the script, voice all lines (4 at a time), with brain and voice budgets that fit the
song's end. The break is ready once the script and the FIRST clip are; later clips finish while it airs (a line
whose clip is 4 s late is read by the device voice). `holdAfterCurrent` airs it: the ident rings and the first line
comes in 450 ms into it, lines with music ducked, optional talk over the next intro.
Air time (`core/radio/airtime.ts`): a break is planned for the moment it is expected on air (`airAt` = the song's
expected end from the player, else now): the packet, part of day, "in N minutes" and the planner all count from it.
The clock time has ONE time-teller: the LAST line, written with a `{TIME}` slot (the brain never sees the clock;
`placeTimeLine` keeps one slot in the last line, takes clock times out of the others and adds "It's {TIME}." when the
writer forgot). That line is voiced ahead without its time; when the break really starts (after any skip, pause or
fast-forward), `retimeAtAir` fills the slot with the real time at the moment the line will play (now + the ident +
the earlier lines' clip lengths, read from the MP3/WAV header or estimated from the words) and voices it while the
earlier lines play. Not ready at its turn (300 ms grace; a one-line break waits up to 2.5 s, none when the voice is
measured slower), or not in the clock's own minute: this device's voice (also the stand-in when the host's voice
failed) or one measured under 0.6 s says it again for that very moment; else, within 30 s it plays as voiced, further
off without the time, or is left out when only the time was in it. A break airing a minute or more off plan also gets its "in N minutes" recounted and voiced again, else an
absolute time ("at 2:30 PM", voiced ahead) stands in. Never a wrong time; a missing one is fine. The scripted
fallback uses the same slot.
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
Notion asks (`core/radio/notionAsk.ts` pure, `notionWrite.ts` effects): a call-in, or an AI-app note/segment in the
inbox, that asks to add something ("add oat milk to my list") is read by the station's brain into one checked action
(`add_todo` / `add_note` / `none`, made of the listener's own words) or by the offline reader, sent to
`/api/notion/write` (inbox items with `ref` = `inbox:<id>`), and the result rides on `plan.notion`: a FACTS line and a
plan sentence so the hosts confirm it once ("Done, it's in your Notion") or say kindly why not; the scripted fallback
has its own lines. After 9 PM a break may add the daily recap (off by default).

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
Each source caches its last snapshot in `kv` with `fetchedAt` so the radio keeps working offline (`cacheStatus(key)`
gives the last fetch and this session's last error). Weather: Open-Meteo (no key). Calendar: Google (server) and ICS
feeds. Email: Gmail (server) and IMAP (server); email is on for new stations and connecting a mailbox switches it on for
every station (`core/radio/emailOn.ts`). News: RSS feeds, a station's own `newsFeeds` or else the account's
(`settings.connections.news`: `feeds` = the listener's own list, empty = the public feeds of `region`, guessed from the
place in About me, the time zone, then the language; `core/context/news.ts`, every default URL checked live by
`context/feeds.check.test.ts`).
Topic rotation and cooldowns live in `core/radio/planner.ts`, day first: the next song is always introduced, the last
one only every N breaks by the station's talk mix (every break at Music, 1 in 3 at the default); every regular break
carries one item from the listener's day when there is one (reminders and events starting soon, today's events,
important mail, the listener's own notes and chosen note-app pages, news, then weather and time, then fun facts); the first break of a session and the first after the top
of each hour is a short rundown (next events today, due reminders, weather, a headline or two; `rundown` in the break's
topics). An event rests 90 min and a reminder 75 min (said once more when 30 min away), a mail 6 h, a headline 12 h;
the planner sees the station's last 60 breaks (`RECENT_BREAKS`). Settings > What your hosts can see
(`core/radio/hostsView.ts`) shows every source as the hosts get it, and what the next break would bring up.
Notion (`context/notion.ts`, when `settings.connections.notion.connected`): the chosen pages join `notes` as "Your
Notion page ... says: ..." lines (kv `notion:context`, 10 min).

`core/agent/` the hosts look things up (only a host with a real AI brain, and only while
`settings.connections.lookups.enabled !== false`; `web !== false` adds web search where the server offers it):
- `tools.ts`: the lookups (read only): `calendar_event`, `calendar_search`, `email_search`, `email_read`,
  `email_thread`, `notion_search`, `notion_read`, `open_link`, `news_article`, `weather`, `web_search`.
  `availableTools(ctx)` offers only what this account connected (`serverStatus()` = `GET /api/agent/status`, cached
  5 min). `runTool` runs weather and calendar feeds (ICS, from the kv cache) on the device and everything else on the
  server (`POST /api/agent/tool`); it never throws (a failure is an answer the model reads).
- `step.ts`: one model turn with tools for every brain kind: OpenAI-compatible and Anthropic on the device, the rest
  through `/api/ai/chat` with `tools` (or the desktop helper for a ChatGPT plan there). `ToolsUnsupportedError` when a
  model or server refuses tools.
- `loop.ts`: `runAgent({ brain, system, user, tools, ctx, maxSteps, maxCalls, deadline, answer })`: native tool calls,
  else a JSON way of asking (`{"tool": .., "args": ..}` / `{"done": ..}`), remembered per brain and model (kv
  `agent:mode:<brain>:<model>`, a JSON verdict re-checked after 14 days). Hard caps per task: steps, lookups, time.
- `kit/` the hosts as agents (full contract: `docs/AGENT.md`): `registry.ts` (tool SOURCES, `buildToolbox(env)` every
  turn: each tool's availability with the reason and the Settings path to fix it, the listener's per-tool policy
  `connections.agent.policy` auto / ask / off, writes never in background turns, approvals only in listener turns),
  `env.ts`, `policy.ts`, `selfknow.ts` (what the hosts can do now, what is off and how to turn it on, the never list,
  the rules, in every system prompt), `sources/` (built in: the look-ups + `google_tasks` + `music_search`; app writes
  `list_*`, `memory_*`, `play_song`, `undo_change` (kv `agent:changes`); outside writes `google_task_*`,
  `calendar_add/update/delete`, `invite_answer`, `notion_add`; titles and notes must be the listener's words and a
  change needs the thing named), `approval.ts` (`approve_action` / `cancel_action`: listener turn, FIRST model step
  before any tool result, the listener's words say yes (`saysYes`), a proposal from an earlier turn), `turn.ts`
  (`agentTurn`: one turn for the call, the chat, the on-air call-in (`radio/callinAgent.ts`) and the AI-app inbox
  (`actions/inbox.ts`); a conversation keeps the tools it used and what its last turn could do; finished changes end
  a turn on code's words, `also` keeps it going; `turnTrace` for the debug build), `discover.ts` (the stable core
  sent every turn, the directory and `find_tools`: the rest load on demand in the same turn, native or JSON; the prompt
  stays the same for the provider's cache), `effects.ts` (code's exact lines: done / failed, then the read-back),
  `catalog.ts` (Settings, Connections, What your hosts can do). `question.ts` (pure): a question is never an order
  (the no-AI reader, and the add / remember tools when every sentence only asks).
- `lookups.ts`: the Lookups log. Signed in, the server's list (it logs its own lookups; the device reports the ones it
  ran with `POST /api/agent/lookups`); signed out, this device's (kv `agent:lookups`, newest 300, 400 a day).
- `brief.ts` (pure): an item's details in a host's few words (people and answers, the video call but never its link,
  related emails), the facts lines for prompts and scripted lines, the scripted dossier made from the item's own
  fields, and `researchItems(packet)`: events in the next 36 hours, important mail and invitations, the top headlines
  with a link, each with a version (an event's last change) and a priority.
- `research.ts`: the research desk. `researchDesk.schedule(station, packet)` (after each break is prepared) queues
  every item without a dossier at its version (12 at most, a failed one waits 30 min) and researches them one at a
  time in the background with the station's lead host with a real brain (`leadWithBrain`), never while a break is
  being written (`markBreakPreparing`): at most 4 steps, 5 lookups, 60 s (120 s for a model on the LAN), 60 tasks a
  day per device. The answer is a `Dossier` `{ about, who, prepare, links, questions, sources, by: 'ai', hostName }`
  (links kept only when they appear in what was read), kept in kv `agent:dossiers` by `<key>@<version>` for 7 days
  (150 at most), shared by every station. Breaks only read dossiers (`dossiersForPacket`, never waiting); without one
  the scripted dossier stands in. Questions from AI apps (inbox notes) are answered in the background too (kv
  `agent:answers`) and a question waits up to 3 min for its answer before it airs. `researchDesk.research(item,
  station)` is also the "Look into it now" button.
- `changes.ts` (pure) + `headsup.ts`: heads-ups. While the radio plays (and only then: quiet when paused),
  `headsUpWatch` checks every 2.5 min (10 min after a 429) with `GET /api/google/watch?since=&historyId=` (Calendar
  `events.list` with `updatedMin` + `showDeleted` per visible calendar, next 12 h, the calendar list cached 30 min;
  Gmail `users.history.list` from the last `historyId`, the new inbox messages with the signs of mass mail: list
  headers, Precedence, Auto-Submitted, Gmail's promotions/updates/social/forums labels, no-reply senders); calendar
  feeds (ICS) and IMAP every other check (a whole download each). `diffCalendar` compares with what the hosts last
  knew (the `calendar:google` snapshot if under 30 min old, else a fresh list): an event in the next 12 h cancelled,
  moved (time or place), new, a guest declining, the organizer changing, a video link added, an invitation to answer.
  Mail: `judgeMail` (the lead host's brain for the ones that might be urgent: a real person, time-sensitive, asks for
  action today; 12 s) else `mailByRules` (urgent words in the subject, or in the text from someone they meet today /
  a reply in their thread / marked important). Mass mail never counts. Changes patch the kv snapshots in place, so the
  next break knows. Each new heads-up (kv `headsups`, 48 h, one per change id, ever) gets `noteFor`: the dossier plus a
  quick lookup for the reason (3 steps, 2 lookups, 12 s, 25 s on the LAN, 40 a day) and a ready line in the lead
  host's words. `deliveryFor`: urgent (a meeting within 2 h cancelled or moved, anything changed starting within 15
  min, urgent mail) breaks in over the ducked music (`BreakKind 'headsup'`, the lead host, chime, then the song goes
  on; at most 3 an hour) or, when the song ends within 90 s, the setting says After the song or the hour is full, a
  break right after this song; the rest open the next break (`packet.headsUps`, planned first; a heads-up that came
  in after the break was written is added in front of it at air). Reminders (`remindMin`, default 10) for meetings
  with guests or a video call, skipped after a recent heads-up about it or a "got it". `snoozeLast` on a call-in that
  says "got it/thanks". Follow-ups read `headsup:<id>` topics with the note. Settings: `connections.headsUps`
  `{ breakIn: 'now'|'after'|'off', remindMin: 0|5|10|15 }`; the Heads-ups card in What your hosts can see. The
  calendar's own notice (Google's "Canceled event" mail with the organizer's note, never a heads-up itself) arriving
  in the same check is linked as `source`, so the reason is known without a search.
- `followup.ts`: a call-in (or AI app) asking about something the hosts said ("what's that meeting about?") gets the
  recent breaks' items with their dossiers and may look things up live (4 steps, 4 lookups, about 20 s; a host holds
  the line after 2.5 s); without a brain, or when that fails, a scripted answer from the items' fields.
Settings > What your hosts can see (`ui/screens/settings/HostsLookups.tsx`) has the switches, what the hosts found
out for each upcoming item (`hostsView` returns `desk: { station, items }` from the same packet) and the Lookups list.

`core/memory/` what the hosts remember about the listener: a bounded, curated long-term memory (cards) plus a
short-term journal, shown in Settings > What your hosts remember (`ui/screens/settings/Memory.tsx`).
- `cards.ts` (pure): `planAdd` (a near duplicate updates its card; a full memory lets go of the least useful learned
  card: an expired plan, a weak pattern, the oldest; the listener's own, edited and pinned cards never go), `tidy`
  (expired plans, duplicates, patterns not seen for 3 weeks with little evidence, the bound). `store.ts`: the Dexie
  side, serialised; `memoryEvents` ('change', 'journal').
- `safety.ts` (pure): never passwords, codes, numbers (4+ digits but a year), emails or links; sensitive topics
  (health, money, relationships, religion, politics) only when the listener asked ("remember that ..."); `grounded`:
  a learned card's names, numbers and most words must come from the listener's own words (or the cards it merges), so
  text from an email, a page or the news can never plant a memory.
- `journal.ts`: rows written by the radio (call-ins, AI app notes, heads-ups and "got it", likes, early skips
  (first third), requests, station and hour, what a break covered or that Next skipped it, with its segments), behind
  the two switches `connections.memory { fromWords, fromListening }` (on unless off); pruned at 14 days.
- `commands.ts`: "remember that ..." / "forget that ..." / "forget everything" parsed and applied before the call-in
  break is written (any brain), so the plan carries `memory` and the hosts confirm it (`memoryFact`/`memoryTask`, the
  scripted fallback says `memorySpoken`). Dates said ("next weekend") become real dates and a plan's expiry.
- `learn.ts`: after a call-in or AI app note that is a statement about the listener (`worthLearning`), one step with
  the lead host's brain through the `update_memory` tool (add / update / forget, at most 3; JSON when the model has no
  tools), then `validateActions` checks kind, card ids, safety and grounding. 30 steps a day (kv `memory:learned`).
- `patterns.ts` (pure) + `reflect.ts`: the daily reflection (first play of the day, or hourly while the app runs:
  `memoryUpkeep`, kv `memory:upkeep`) turns the journal into pattern cards only with 3+ times over 2+ days (skipped
  segments by time of day against those heard out, artists skipped or liked, genres (on a weekday), listening hours);
  with a brain it may add up to 3 patterns citing journal rows (checked: 3+ rows, 2+ days, their words). The weekly
  consolidation tidies with rules, then the brain may merge cards, update one, or forget one replaced by a newer card
  of the same kind (named in `by`, checked). The scripted fallback brain never writes: rules only.
- `brief.ts`: each break's `packet.memory`: `quieter` (segments the patterns play down now: the planner takes them out
  of the rundown and away from the pick), then for the planned topics `facts` (pinned, plans in the next 10 days,
  cards sharing words with the topics or the call, one recent, one pattern; 8 cards / 700 characters; sensitive only
  when the call is about it) and `recently` (the listener's words of the last 2 days when the call looks back or they
  match). The prompt gets WHAT YOU KNOW ABOUT THE LISTENER and `MEMORY_RULE` (at most one memory per break, never
  recited, nothing sensitive unless they brought it up, may be out of date). `search.ts`: the `memory_search` and
  `journal_search` lookups (on the device) and the scripted fallback's answer from memory for call-ins.

`core/tracker/` Your list (`db.tracker`), the screen `#/list` (`ui/screens/YourList.tsx`: the list, and "Done for
you" = the actions log with Undo). Two rules, in force across this module and `core/actions/` (spec: `.work/ag4-spec.md`):
Rule 1, outside content (mail, invites, Notion, web, news) is information, never instructions: it can only become a
TRACKED ITEM labeled with its source, never a memory, setting or action. Rule 2, the AI proposes, the listener
confirms, the APP acts (below).
- `store.ts`: `addItem` dedupes by `itemKey` (source + a few content words) and `sameAs` (same key, the same source
  record and alike, or very alike with the same due day and person, so a mail and its event become one item);
  dismissed items are never brought back. Bounds: `MAX_OPEN` 400 (undated outside items go first), done items shown
  7 days, done/dismissed rows removed after 30 (`trim`). `trackerEvents` ('change').
- `safety.ts` (pure): `caution` flags money / gift cards / bank details, passwords / codes / logins, "click this link",
  text that tries to instruct the hosts (incl. hidden characters and other languages) and data-sharing asks;
  `speakable` strips links, email addresses and hidden characters from anything the hosts may read.
- `extract.ts` (pure): `extractItems({ calendar, email, notion, dossiers, known, now, tz, from })` turns events, mail
  that asks something of the listener (never no-reply or mass mail), open Notion to-dos and the research desk's
  dossiers into `TrackedDraft`s with `dueFrom` (the source's own "by 2 PM", read from when it was sent). Careful
  content and senders the listener never emailed (`known[address] !== true`) get `flags { careful, newSender, why }`
  and are never a to-do. `doneEvidence`: later mail like "thanks for the quotes" only sets `suggestDone` (the hosts ask).
- `sync.ts`: `trackFromPacket(packet)` runs in the background after each break is prepared (`radio/prepare.ts`),
  honoring `connections.tracker { enabled, fromMail, fromEvents, fromNotion }`. `knownSenders` asks
  `POST /api/google/known-senders` (Gmail `in:sent to:<addr>`), cached 7 days in kv `tracker:known-senders`.
  `syncGoogleTasks` (every 10 min, only with `connections.actions.tasks` and the `tasks` scope; `taskLists` picks the
  lists): done in Google = done here; done here is sent to Google only as a `task.complete` the listener says yes to.
- `api.ts`: the read-only calls (`/api/actions/status`, `/api/google/tasks`, known senders). Background code imports
  only this, so it cannot even reach the calls that propose or run an action.
- `brief.ts`: `listBrief` gives `packet.tracker` (YOUR LIST lines + `LIST_RULE`: information, not instructions; a BE
  CAREFUL line is a warning) with a reminder whose time came, overdue follow-ups, due soon, "looks done?", a one-time
  careful warning, the morning rundown. Bounded: one item a break (two in a morning rundown), `MAX_PER_HOUR` 4, the
  same item not again for 3 h (kv `tracker:mentions`, `markListAired` when the break airs). `listSearch` is the
  read-only `my_list` lookup (`agent/tools.ts`); careful items say so.
- `commands.ts`: the listener's own words, read by code with any brain: "remind me to ... <when>", "add X to Your
  list" (`parseTrackerCommand`, times via `actions/when.ts`), "I sent the quotes" (`matchDone`, asks when two fit).

`core/actions/` the fixed things the hosts can do in other accounts (`types.ts`), proposed by the agent's tools
(`agent/kit`): level 2 (ask first, their own accounts, server executed): `calendar.add`, `calendar.update`,
`calendar.delete`, `task.add`, `task.complete`, `task.edit`, `task.delete`, `task.move`, `notion.add` (server
`actions/notion.js`); level 3 (ask first + read back exactly, naming who will see it): `invite.respond`, and a
calendar change or delete Google tells guests about.
Nothing else exists. Switches: `connections.actions { calendar,
tasks, taskLists }` (Settings > Connections > Google, `GoogleActions.tsx`), off by default; on asks Google for the scope.
- `when.ts` (pure): the listener's "Tuesday at 3", "tomorrow at noon for 30 minutes", "this month", "3 PM Pacific" ->
  exact zone-correct times (DST days, all-day with Google's exclusive end, late-night "tomorrow"); refuses the past
  and absurd lengths. No model: the read-back says the resolved time, so what is confirmed is what is written.
- `understand.ts`: `answerFromWords` (the RSVP answer the listener said) and `inviteChoices`; `title.ts`:
  `cleanTitle` (no day or time words, grounded in the listener's words: an injected title is refused).
- `engine.ts`: `propose` (never executes), `pendingAction`, `confirmAndRun` (confirm -> token -> execute; a drop is
  retried with the same token or read back, never sent twice), `cancelAction`, `undoAction`, `actionHistory`,
  `classifyAnswer` (code, never a model: only plain yes words are yes; anything else is not).
- `callin.ts`: `takeActionTurn`, the scripted fallback's reader (no AI brain): (1) an answer to the newest waiting
  question (a call-in only), (2) Your list commands (may offer Google Tasks too). With an AI brain the agent decides. The
  `ActionTurn` carries a FACTS line and the exact last line of the break, written by code (`askLine` / `doneLine` /
  `failedLine`, the server's own summary), spoken by the lead host; the model only reacts around it.
- `inbox.ts`: `nextInboxTurn`: an AI-app note goes through the agent (turn `ai-app`: Your list and Notion right away,
  Google changes proposed and waiting for the listener's yes or a tap; an AI app never confirms); without AI the
  plain reader.

Flow: the listener's words -> `agentTurn` -> an outside-write tool (grounded) -> `POST /api/actions/propose` (server
validates again, checks Google, writes the summary) -> the break's last line reads it back -> the listener's "yes"
(`classifyAnswer`) or a tap on the card -> `confirm` -> one-time token -> `execute` -> Google -> the log -> "Done
for you" with Undo. Where the rules live: Rule 1 in `tracker/safety.ts`, `tracker/extract.ts` (items only),
`understand.ts` (grounding), `memory/safety.ts` (memory), `LIST_RULE`; Rule 2 in `engine.ts` (`classifyAnswer`, only
`confirmAndRun` gets a token), `tracker/api.ts` (background has no write path) and `server/src/actions/` (strict
schemas, token, caps). Tests: `actions.test.ts`, `when.test.ts`, `injection.test.ts` (30 hostile inputs over 9 doors),
`tracker.test.ts`.

`core/call/` live calls with the station and the hosts' chat (the app's Call / Message buttons; `ui/call/`).
- `session.ts`: `CallSession`, the voice call's state machine with everything injected (brain, ears, mouth, music,
  ring, clock), so `session.test.ts` runs it with fakes: ringing (the music fades and pauses, a short ring; the lead
  host's pickup line is voiced during the ring) -> speaking -> listening (partial captions; the recognizer finds the end
  of speech) -> thinking (a lookup not done in 2.5 s: a hold line) -> speaking -> listening ... Barge-in: the Talk
  button, or words over the host when the ears can listen meanwhile (`overlap`: desktop browsers; `isEcho` drops the
  host's own words picked up by the mic); what was said over the host is the next turn. Silence: "still there?" after
  12 s, a kind wrap-up 30 s after that (5x longer when muted or typing). Ends: Hang up, "bye / that's all / thanks,
  that's it" (`phrases.isGoodbye`: short replies only, never a question), silence, or the cap (heads-up at 18 min, end
  at 20). The end is one sign-off line (7 s at most), then the music resumes where it was. Typed words (no mic, or
  "Type instead") are turns too.
- `brain.ts`: `hostsBrain(station, 'voice' | 'text', hooks)`: per turn "got it" snoozes the last heads-up and the
  words go in the journal (`noteSaid`); then one `agentTurn` (agent/kit) with the call so far, the context packet
  (built once at the start, refreshed every 5 min: calendar with people, important mail, weather, headlines,
  dossiers, the last break), memory cards for the words, Your list, the actions offered in this conversation and the
  hosts' tools (4 steps, 5 tools, 20 s voice / 25 s chat); the effects end the reply with code's exact lines (a done
  line, the read-back that waits for a yes). Without an AI brain: the plain reader (memory commands, song requests,
  Notion, `takeActionTurn`). The co-host may add one line every few turns. `learnFromWords` runs after.
  No AI brain: an honest pickup ("my AI brain is off, I can take song requests and notes") and scripted answers.
- `mouth.ts`: each reply is cut into sentences; the first is voiced and played as soon as it is ready while the next
  two are voiced behind it (the host's own voice engine, 9 s per sentence, else this device's voice). `ears.ts`: the
  phone's recognizer (`@capgo/capacitor-speech-recognition`, partial results, no popup, per-session events), Web Speech
  in browsers, else typing (there is no server or own-key speech-to-text). `music.ts`: own player = a 280 ms fade and
  pause, then play with a fade-in; any-app mode (Android) = the other app paused through its media controls and
  `audioFocus.hold()` (full transient focus, `NowPlaying.holdForCall`), released and played again only if it was
  playing. `ring.ts`: the ring and pickup click rendered to a WAV on the device. `live.ts`: `liveCall` (one call at a
  time; `radio.setCall(true)` keeps every break, call-in answer and heads-up off the air and stops one on air), the
  hosts' side of the call goes in `breaks` (topic `call`). `chat.ts`: `hostChat`, the text thread (kv `chat:thread`,
  12 h), the reply shown a few words at a time, an action's Yes/No card on the message, unread count; `onair.ts`:
  "Hosts may mention our chat on air" (kv `chat:onair`, off by default) adds the newest message to the next regular
  break's notes once. Debug builds: `window.__hostcaster.call.fakeEars()` / `hear(text)` for e2e (`e2e/call.e2e.mjs`).

`core/api/` (owner: server agent) typed client for the server: `api.baseUrl`, `api.session`, `auth.signIn('google'|
'x'|'local')`, `auth.signOut()`, `sync.pull()/push()`, `aiProxy`, `ttsProxy`, `integrations.calendar()`, `.email()`,
`.fetchText(url)` (ICS/RSS through the server), `inbox.poll()`, `youtube.*`, `serverLibrary.*`.
Signed out = local-only mode; every caller must handle `api.available === false`.

`core/native/` (owner: native agent) thin wrappers that no-op on web: `isNative`, `platform`, `nativeTts`,
`audioFocus.duck()/release()` (`hold()/releaseHold()` for a call), `mediaNotification.update(meta, playing)` + events, `anyApp` (Android: other music
apps' now playing via notification access; events `trackchange`, `playstate`), `openAuthUrl(url)`,
`onDeepLink(cb)`, `speechToText()`, `pickAudioFiles()`.

## Server (Node 24, Fastify 5, node:sqlite)

Config from env (and `.env`): `PORT` (8660), `PUBLIC_URL`, `DATA_DIR` (./data), `SECRET_KEY` (32 bytes base64,
generated into DATA_DIR on first start if missing), `GOOGLE_CLIENT_ID/SECRET`, `X_CLIENT_ID/SECRET`,
`ALLOW_LOCAL_ACCOUNTS` (true when no OAuth is configured), `MUSIC_DIR` (optional server library),
`ALLOW_PRIVATE_FETCH` (false), `APP_SCHEME` (`hostcaster`), `NOTION_CLIENT_ID/SECRET` (the owner's public Notion
connection; empty = the Notion card says it is not set up), `NOTION_VERSION` (`2026-03-11`), the hosts' lookups:
`SEARXNG_URL`, `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `WEB_SEARCH_PROVIDER` (`searxng|brave|tavily|off`; none
set = no web search offered), `AGENT_LOOKUPS_PER_DAY` (400), `AGENT_WEB_SEARCHES_PER_DAY` (40), the hosts' actions:
`ACTIONS_PER_DAY` (50 executions) and `ACTION_PROPOSALS_PER_DAY` (200) per account in 24 hours.

Tables: `users`, `identities` (provider, subject, encrypted tokens), `sessions` (sha256 token, kind web|app,
expires), `sync_docs` (user_id, json, rev), `sync_doc_revisions` (user_id, rev, at, size, sealed: the last
`SYNC_DOC_REVISIONS` (20) stored docs, sealed per account and rev), `sync_items` (user_id, kind, id, json or NULL = deleted, updated_at, seq)
and `sync_item_meta` (user_id, seq, pruned_seq), `secrets` (encrypted provider keys), `inbox` (notes/segments from AI apps),
`connector_tokens`, `server_tracks`, `chatgpt_accounts` (per user: issued ChatGPT client id, verified subject, sealed
tokens; the install's agent host id lives in `DATA_DIR/chatgpt-host.json`), `notion_links` (per user: workspace, sealed
tokens, settings `{ read, write, writesOn, recapOn }`) and `notion_activity` (every block the hosts added or tried
to, with its block id for Undo and an optional `ref` so one ask never writes twice; migration 8), `agent_lookups`
(the hosts' lookups per account: at, tool, what, host, purpose, ok, ms, cost, where_ran server|device; kept 30 days,
counted for the daily caps over a rolling 24 hours; migration 9), `actions` (migration 10: every proposal and what
became of it; type, level, origin, status, timestamps, `payload_hash`, `ref`, `token_hash` (sha256 only), attempts,
error; `enc` sealed with aad `action:<user>:<id>` = payload, summary, others, said, context, result, undo; pruned
after 90 days, cascades with the user).
Secrets at rest: AES-256-GCM with SECRET_KEY; API keys never returned to clients in clear unless the owner asks.

Routes (JSON, errors `{ error: { code, message } }`):
- `GET /api/health`, `GET /api/config` (which sign-ins are on, server library on, version).
- Auth: `GET /auth/google/start?app=1&scopes=calendar,gmail,youtube` (also `calendarEvents` =
  `calendar.events` and `tasks`, asked only when the listener turns an actions switch on; `&link=1` adds a scope to
  the signed-in account), `GET /auth/google/callback`,
  `GET /auth/x/start`, `GET /auth/x/callback` (OAuth 2.0 PKCE, `users.read tweet.read`), `POST /api/auth/local/signup`,
  `POST /api/auth/local/login`, `POST /api/auth/exchange {code, verifier}` (native: one-time code from the
  `hostcaster://auth?code=` deep link plus the verifier whose hash the app sent as `cc` on `/auth/<p>/start?app=1`,
  returns a bearer token), `POST /api/auth/link/finish {code, verifier}` (native link with a ticket: the
  `hostcaster://auth?linkcode=` code, finished with the account's bearer session), `POST /api/auth/logout`, `GET /api/me`,
  `DELETE /api/me` (delete account and data). Web = httpOnly cookie, native = `Authorization: Bearer`.
  CSRF: cookie sessions require header `X-HostCaster: 1` on writes.
- Sync: `GET /api/sync` -> `{ rev, doc }`, `PUT /api/sync {rev, doc, join?}` (409 `conflict` on stale rev; 409
  `join_overwrites` when a device's first push, `join: true`, would change most of the account). Doc holds hosts, stations,
  brains/voices (keys replaced by `secretRef`), profile, settings, playlists metadata (no trackIds). Songs, playlist
  lists and unplayable marks: `GET /api/sync/items?since=<seq>&limit=` -> `{ items, cursor, more, reset? }` and
  `POST /api/sync/items {items}` -> `{ before, cursor, stale, refused? }` (see "Sync" below).
- Secrets: `PUT /api/secrets/:ref {value}`, `DELETE /api/secrets/:ref`, `GET /api/secrets` and
  `GET /api/secrets/:ref` (hint only; values never go back to a client).
- AI and voice proxy: `POST /api/ai/chat`, `POST /api/ai/models`, `POST /api/tts` (audio bytes), `POST /api/tts/voices`.
  `/api/ai/chat` takes `tools` (at most 16, `{ name, description, parameters }`) and tool turns in `messages`
  (`{ role: 'assistant', content, toolCalls }`, `{ role: 'tool', toolCallId, name, content }`) and answers
  `{ text, toolCalls? }`, one shape for OpenAI-compatible, Anthropic, ChatGPT plan and Host-Caster AI
  (`server/src/ai/wire.js`).
- The hosts' lookups (`server/src/agent/`): `GET /api/agent/status` -> `{ tools: { calendar, gmail, imap, notion, web,
  webProvider?, links }, caps: { lookupsPerDay, webSearchesPerDay }, used: { lookups, webSearches } }`,
  `POST /api/agent/tool {name, args, host?, purpose?}` -> `{ result, what }` (runs one read-only lookup and logs it;
  429 `lookups_limit` / `web_search_limit` past the caps; linked pages go through the same egress guard as
  `/api/fetch-text`), `POST /api/agent/lookups {items}` (lookups the app ran on the device: weather, calendar feeds),
  `GET /api/agent/lookups?limit=` (newest first, 30 days), `DELETE /api/agent/lookups`. Web search
  (`agent/search.js`): the operator's SearXNG (JSON format), Brave Search or Tavily, top 5 results.
- ChatGPT plan: `GET /api/chatgpt/status`, `POST /api/chatgpt/start` (authorize URL; redirect
  `http://127.0.0.1:<port>/auth/callback`, caught by the server's own listener or pasted back with
  `POST /api/chatgpt/finish {url}`), `GET /api/chatgpt/models`, `POST /api/chatgpt/disconnect` (revokes),
  `POST /api/chatgpt/welcome`. Errors are `chatgpt_*` codes (`chatgpt_limit` 429 = usage limit, Manage usage).
- Integrations: `GET /api/google/calendar?hours=36`, `GET /api/google/gmail?max=10` (unread, important first),
  `GET /api/google/youtube/playlists`, `GET /api/google/youtube/playlist/:id` (`?paged=1&limit=500&pageToken=`: whole
  YouTube pages + `next`, `total`, `left { private, deleted, unavailable }`, `blocked`; the app reads up to 5,000
  videos in steps, about 2 quota units per 50), `GET /api/google/youtube/search?q=`,
  `POST /api/imap/test`, `GET /api/imap/summary`, `POST /api/fetch-text {url}` (ICS/RSS; blocks private ranges unless
  ALLOW_PRIVATE_FETCH). Mail summaries carry `address` (the lowercase sender). `GET /api/google/tasks` -> `{ lists,
  tasks }` (open + completed in the last 3 days, 10 lists, 300 tasks each; 403 `scope_missing` without `tasks`),
  `POST /api/google/known-senders {emails (<= 40)}` -> `{ known: { email: bool } }` (Gmail `in:sent to:<addr>`,
  maxResults 1, cached 7 days per user in memory; no Gmail = `{}`).
- Notion (`server/src/integrations/notion/`): `POST /api/notion/start {app?, cc?, return?}` -> `{ url }` (one-time,
  opens `/auth/notion/start`, which binds the browser and goes to Notion's consent), `GET /auth/notion/callback` (web:
  stores the link, back to `/#/settings/connections?notion=connected`; phone: `hostcaster://notion?code=`, finished with
  `POST /api/notion/finish {code, verifier}`), `GET /api/notion/status`, `DELETE /api/notion` (revokes),
  `GET /api/notion/pages?q=` (what the user shared), `PUT /api/notion/settings {read?, write? {id, mode new|direct},
  writesOn?, recapOn?}` (mode new = a "Host-Caster" page made inside the chosen one), `GET /api/notion/context`
  (`{ notes: [{ id, title, text, edited? }], problems }`, open to-dos/headings/rows, capped, cached 10 min in memory),
  `POST /api/notion/write {kind: todo|note, text, source: call|app, ref?, tz?}` (appends one block; never edits or
  deletes the user's blocks; 30 an hour), `POST /api/notion/recap {day, text}` (once a day, only when turned on),
  `GET /api/notion/activity`, `POST /api/notion/activity/:id/undo` (trashes only that block).
- The hosts' actions (`server/src/actions/`, Rule 2 on the server; app side `core/actions/`):
  `registry.js` is the fixed list (`TYPES`: `calendar.add`, `task.add`, `task.complete`, `task.edit` level 2,
  `invite.respond` level 3), strict schemas (`normalize`: unknown keys refused, so no `attendees`; past starts with a
  2 min grace, end <= start, timed > 24 h, all-day > 14 days refused), `payloadHash` = sha256 of canonical
  `{type, payload}`, `describe` (the plain summary the listener hears; `others` names the organizer). Any other type
  is 400 `action_not_allowed`. `store.js` is the log (table `actions`): every state change is a compare-and-set in
  a db transaction (proposed -> confirmed -> executing -> done | failed; proposed -> cancelled | expired; done ->
  undone), so a double yes, two devices or 20 concurrent confirms see one winner; an execution unfinished after 5 min
  reads as failed `unknown_outcome`. `google.js` runs and undoes them: `prepare` at propose time (write scope granted,
  the task exists with that title, the invitation exists, is not cancelled or over, the listener is a guest and not
  the organizer); `runAction` with up to 3 tries on Google 429/5xx/timeouts (0.4 s, 1.2 s, Retry-After capped at
  3 s), then an honest plain failure; no duplicates: an event id derived from the action id (`eventIdOf`, a retry
  gets 409 and adopts it), a task insert retried after an unknown outcome first lists tasks updated since the first
  try (minus 60 s) and adopts one with the same title and due; events are inserted on `primary` with `sendUpdates=none` and no attendees;
  `invite.respond` re-reads the event and patches only the self attendee's `responseStatus` (+ comment); the previous
  values are kept (sealed) for `undoAction` (delete the event or task, restore the answer, reopen or patch back).
  `routes.js`:
  `POST /api/actions/propose {type, payload, origin, said?, ref?, tz?}` -> 201 `{ action }` (same `ref` = the same
  proposal, 200; 400 `invalid_action` with `field` | `action_not_allowed`; 403 `scope_missing`; 429
  `proposals_limit`; proposal TTL 10 min), `POST /api/actions/:id/confirm {payloadHash, via}` -> `{ token, action }`
  (or `{ action }` when already confirmed or run; 409 `payload_changed`, 410 `action_expired`, another user's id =
  404), `POST /api/actions/:id/execute {token, payload}` -> `{ action }` (token bound to user + id + payload hash,
  2 min, single use, spent in the transaction that moves the status to executing; 401 `token_invalid` |
  `token_expired` | `token_used` with the current action; 429 `actions_limit`; Google gets the stored payload),
  `GET /api/actions/:id`, `GET /api/actions?limit=&status=` (newest first), `POST /api/actions/:id/cancel`
  (idempotent), `POST /api/actions/:id/undo` (idempotent, done + undoable, 7 days), `GET /api/actions/status` ->
  `{ calendarWrite, tasks, caps: { perDay, proposalsPerDay }, used }`.
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
  playlist names, memory cards (`memories`; the server seals them at rest with the secrets key, bound to the account,
  as `memoriesSealed`, and opens them for the owner's GET; a doc from an older app without `memories` keeps them),
  and Your list (`tracker`, sealed the same way as `trackerSealed`, at most 1,500 items). Three-way merge per record (`core/api/merge.ts`): newer `updatedAt` wins, deletions travel as
  tombstones (`deleted`, 90 days). An untouched starter record (`seed-*`, never saved since seeding or still the
  starter content; a save that changes nothing keeps `updatedAt`) never wins over an edited one.
- **Joining** (a device's first sync with an account, no base): the account's records, profile and settings win over
  the device's copies (only an untouched starter of the account gives way to an edit made on the device), the
  account's deletions hold however new the device's copy is, and the device's untouched starters stay out. An account
  with no doc, or nothing but starters, takes everything the device has. Last line of defence: a join that would
  change most of the account's hosts, stations, profile, settings and deletions (`joinOverwrites`, at least 3 parts) is
  never pushed (the device keeps the account's records and adds only new ones; the server refuses one too, 409
  `join_overwrites`, `server/src/routes/syncGuard.js`).
- **Accounts on one device** (`core/db/account.ts`): kv `account:owner` names the account the device's data belongs to
  (set by the first finished round). A round for another account first removes that data (`clearAccountData`, the
  device says "Started fresh for this account"), so it never merges into the account signing in. Data that never
  belonged to an account (local-first, a restored backup, an older app's sign-out) meets an account with data: when it
  holds the person's own work (`planJoin`: records that are not untouched starters, a profile where the account has
  none, songs that can sync) the round stops in status `choice` and the app asks once, "Add the stations and hosts on
  this device to your account?" with what would be added (`ui/account/JoinQuestion.tsx`; "Not now" waits, Settings,
  Account, Answer now): **Add them** joins (as above), **Keep only my account** removes the device's account data and
  takes the account's. Nothing of the device (keys, songs) reaches the account before the answer. **Sign out**
  (`auth.signOut`, `ui/account/signOut.ts`) pushes what waits (`sync.flush`; unreachable: the app asks first), ends the
  server session, makes the desktop helper forget the ChatGPT sign-in (`POST /api/account/signed-out`), removes the
  account's data and restarts on a clean first run. Kept as device data: tracks `local` and `device` with their
  files and covers, kv `player:prefs`, `devicemusic:*`, `update:*`, `ui:*`, migration markers, the theme and the server
  address. A session that ended by itself keeps the data and the base (the same account signing in again goes on
  syncing); deleting the account keeps the data, belonging to no account. Backups never carry `account:` or `sync:`.
- **Past versions**: the server keeps the last 20 stored docs (`sync_doc_revisions`); `restoreDocRevision` writes an
  old one back as a new rev with every record stamped now and tombstones for what came after it, so devices that took
  the bad copy take the restored one instead of pushing theirs back.
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

## Desktop app (Windows, Mac, Linux; `desktop/`, user and build guide: docs/DESKTOP.md)

Electron. The window loads the same web app, bundled, from `app://host-caster` (privileged secure standard scheme:
stable origin for IndexedDB; CSP: scripts only from the app, its inline theme script hash, YouTube and Spotify).
It is a client of the online server (default `https://app.host-caster.com`, `HOSTCASTER_SERVER` at build or run time;
Settings, Account, Server picks another): bearer session, sign-in in the system browser back through `hostcaster://`
(single-instance lock: Windows/Linux pass the link as an argument to the running app, macOS `open-url`; a packaged
AppImage registers itself with a hidden desktop entry), email codes in the app, Stripe through the browser and
`hostcaster://billing`. Sandboxed preload (`desktop/main/preload.cjs`) exposes only `window.hostcasterDesktop`;
`app/src/core/native/desktop.ts` (`desktop`, `isDesktop`) is the page's side. Desktop specifics in the app: `sellsPlans`
stays true (not a store app), `defaultServerUrl()` = the bridge's server, links/openAuthUrl use the system browser,
sync also pulls on window focus (the page stays "visible": `backgroundThrottling: false` so the radio runs while
minimized), the YouTube on-screen rule applies (`youTubeNeedsScreen`: minimized or hidden window = off screen), YouTube
embeds get `Referer: https://com.hostcaster.app/` (YouTube RMF API client identity), Settings, Desktop app
(`ui/screens/settings/Desktop.tsx`, `state/desktop.ts`), the update card.

**Local helper** (`desktop/main/helper/`, in the main process): HTTP on `127.0.0.1:<random>`; every request needs
`x-hc-helper: <secret made at launch>` (handed to the page by the preload), the app origin or none, and the exact
`127.0.0.1:<port>` Host. Routes mirror the server: `/api/chatgpt/{status,start,finish,cancel,welcome,models,disconnect}`
and `POST /api/ai/chat|models` for `chatgpt` brains run the server's own `server/src/chatgpt/service.js`
(`createChatGPT(app, { store, flows })`) with a one-person store on the PC (`helper/store.js`, `chatgpt.json`, token set
sealed by Electron `safeStorage`: Keychain, DPAPI, Secret Service; Linux without a keyring falls back to Electron's
plain-text key and says so) and in-memory flows; the ChatGPT callback listener is on this PC's 127.0.0.1, the agent
host id in `chatgpt-host.json`. `GET|POST /proxy?url=` carries 'device' brain and voice calls (`desktopFetch` from
`core/ai/http.ts`: no CORS, plain http on the LAN); helper failures are marked `x-hc-proxy-error`. On desktop
`core/api/chatgpt.ts` and `core/ai/generate.ts` send ChatGPT plan calls to the helper (`core/api/helper.ts`), never to
the online server. "Use your ChatGPT plan" is off until Settings, Desktop app turns it on (OpenAI's terms for paid apps,
docs/DESKTOP.md).

Updates: the main process reads `<site>/download/desktop/latest.json` (`desktop/main/updates.js`; the site writes it
from `website/downloads.json`, forks can use `desktop/scripts/manifest.mjs`) at start and every 6 h; the page shows the
same "A new version is ready" card as the Android download (`ui/update/UpdateNotice.tsx`), and Download opens the
Download page. Notion connects like on the phones (system browser, `hostcaster://notion`, the app's PKCE verifier).
Packaging: electron-builder (`desktop/electron-builder.config.cjs`): AppImage + .deb, NSIS installer + portable zip
(Windows runner or Wine), universal ad-hoc-signed .dmg (Mac). CI: the public repository's `.github/workflows/desktop.yml`
(here `scripts/public/overlay/`), reusable: builds on each system plus a launch smoke test of the packaged app
(`desktop/e2e/smoke.mjs`), called by `release.yml` on `v*` tags to attach the files to the release. Tests:
`desktop/test/*.test.js` (node), the Playwright `_electron` e2e `desktop/e2e/desktop.e2e.mjs` (run with
`desktop/e2e/run-xvfb.sh`) against `desktop/e2e/lab.mjs` (both private: they need the online lab).

## Testing

- `app`: vitest for core logic (planner, prompt builder, scripted fallback, M3U parser, context), Playwright for UI flows
  against the built app + a test server (`node e2e/<name>.e2e.mjs <baseUrl> [mediaDir]`; test songs from
  `e2e/fixtures/make-media.sh`), screenshots in `docs/screenshots/`.
- `server`: `node --test` with a temp DATA_DIR, fake OAuth providers via env overrides of the provider URLs.
- Real phone: an Android phone over adb (debug APK, WebView inspected over CDP).
