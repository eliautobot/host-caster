# Brains, voices and music sources

Host-Caster's hosts are AI hosts. Self-hosted, Host-Caster does not come with an AI of its own: you pick where your
hosts think (a **brain**), how they sound (a **voice**) and where the music comes from (the online edition also offers
Host-Caster AI and Host-Caster Voices with a plan). Until a brain is connected, the **scripted fallback** reads short
lines with your device's own voice, offline, so the music never goes quiet.

You set these up in the app:

- **Settings, Brains**: AI models your hosts think with.
- **Settings, Voices**: speech engines.
- **Settings, Music services**: Spotify, YouTube, your Subsonic or Navidrome server, internet radio, other apps.
- **Settings, Connections**: calendar, email, weather, news and AI apps.

Then open a host (**Hosts**, pick one) and choose its brain and voice. Each host can use a different one.

## Contents

1. [Brains](#1-brains), including [Subscriptions (ChatGPT, Claude, Gemini, Grok)](#subscriptions)
2. [Running a model on your own computer](#2-running-a-model-on-your-own-computer)
3. [This device or Host-Caster server](#3-this-device-or-host-caster-server)
4. [Voices](#4-voices)
5. [AI apps (ChatGPT, Claude and others talk to your hosts)](#5-ai-apps)
6. [Music sources](#6-music-sources)
7. [Spotify, step by step](#7-spotify-step-by-step)
8. [Any music app mode (Android)](#8-any-music-app-mode-android)

## 1. Brains

Pick a preset, paste a key if it needs one, press **Load models** to see what the provider offers, then **Test**.
The default model is only a first pick; any model the provider lists works. Small, fast models make the best radio
hosts: a break is a few short lines, and it has to be ready before the song ends.

### The scripted fallback (not a choice)

The scripted fallback is not a brain you pick. It speaks on its own when there is no AI to write a break: a host with
no brain yet, a brain that fails, is offline or too slow, or a plan or usage limit (ChatGPT plan, Host-Caster AI).
It writes short lines from the same facts an AI host gets (song, time, weather, your day), with no network and no
key, so the music never goes quiet. Home shows "Your hosts are reading scripted lines" with a **Connect** button
while no host on the station has an AI, and says why when a break used the fallback because the AI failed or hit a
limit. Hosts that had the old "Built-in host" brain moved to no brain on update (nothing else changes for them).

### Subscriptions

Already paying for an AI chat app? Here is what works in Host-Caster, in plain words.

| Subscription | In Host-Caster | What to do |
| --- | --- | --- |
| **ChatGPT** (paid plans such as Plus and Pro) | Yes, sign in with ChatGPT. No API key. | Settings, Brains, **Continue with ChatGPT** (below). |
| **Claude** (Pro, Max) | No. Anthropic does not let outside apps use these plans. | Add an Anthropic API key (Cloud presets, below). |
| **Google Gemini** (AI Pro, Ultra) | No. Google does not let outside apps use these plans. | Add a Gemini API key. It has a free tier: [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |
| **SuperGrok** | No. It works only in apps xAI has partnered with. | Add a Grok API key ([console.x.ai](https://console.x.ai)), or let Grok talk to your hosts as an [AI app](#5-ai-apps). |

**Use your ChatGPT plan.** OpenAI lets open-source and self-hosted apps like Host-Caster use a person's ChatGPT plan
for AI requests ("Sign in with ChatGPT"). Your hosts then write their breaks on your plan instead of an API key.

1. Sign in to your Host-Caster server (Settings, Account). The server keeps the ChatGPT sign-in, encrypted, so it works
   on every device you sign in to. It never sits in the browser or on the phone.
2. Settings, **Brains**, **Continue with ChatGPT**. A ChatGPT tab opens: sign in and allow Host-Caster to use your plan.
3. In the Android app, and in a browser on the computer that runs Host-Caster, this finishes by itself. In a browser on
   any other device the tab ends on a page that cannot be reached (its address starts with `http://127.0.0.1`).
   That is expected: copy the whole address, paste it into Host-Caster and press **Connect**. OpenAI only sends that
   answer to `127.0.0.1`, which is always the device the browser runs on.
4. Pick a model (the list comes from your ChatGPT account), press **Test**, then **Save**, and give your hosts this
   brain (Hosts, pick one, Brain).

Good to know:

- Breaks count toward your ChatGPT plan's usage limits, which are shared with your other apps (on Plus there is a
  five-hour limit). See and manage usage at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
- When a limit is reached, or the sign-in expires or is removed in ChatGPT settings, the scripted fallback fills in and
  Home says why, with a **Manage usage** link when that is the fix. Nothing goes silent.
- Everyone on a shared Host-Caster server connects their own ChatGPT account. One person's account is never used for
  another person's breaks.
- **Disconnect** ends the sign-in at OpenAI. You can also remove Host-Caster in ChatGPT's settings at any time.
- Your own server needs nothing extra. A paid or publicly hosted service for other people needs OpenAI's approval
  first: [openai.com/form/sign-in-with-chatgpt-interest](https://openai.com/form/sign-in-with-chatgpt-interest/).
  The server setting `CHATGPT_PLAN=false` turns the option off ([SELF-HOSTING.md](SELF-HOSTING.md#3-settings)).

### Cloud (needs an API key)

| Preset | Address (base URL) | Default model | Get a key |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic Claude | `https://api.anthropic.com` | `claude-haiku-4-5` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| xAI Grok | `https://api.x.ai/v1` | `grok-3-mini` | [console.x.ai](https://console.x.ai) |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Meta Llama API | `https://api.llama.com/compat/v1` | `Llama-3.3-70B-Instruct` | [llama.developer.meta.com](https://llama.developer.meta.com) |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | [console.groq.com/keys](https://console.groq.com/keys) |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | [api.together.ai/settings/api-keys](https://api.together.ai/settings/api-keys) |
| Fireworks | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | [fireworks.ai/account/api-keys](https://fireworks.ai/account/api-keys) |

Claude uses Anthropic's Messages API. Every other preset uses the OpenAI chat completions API, so the same code
talks to all of them. Cloud providers get JSON mode when the hosts write a script together.

### Local (no key)

| Preset | Default address | Notes |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | Default model `llama3.2`. Thinking models (Qwen3, DeepSeek R1, Gemma 4 and friends) are asked to skip the thinking, so they answer in time. |
| LM Studio | `http://localhost:1234/v1` | Pick the loaded model with Load models. |
| llama.cpp server | `http://localhost:8080/v1` | `llama-server` speaks the OpenAI API. |
| vLLM | `http://localhost:8000/v1` | |
| Jan | `http://localhost:1337/v1` | Start Jan's local API server first. |
| Custom (OpenAI-compatible) | you type it | Anything with `/v1/chat/completions`: LocalAI, text-generation-webui, KoboldCpp, LiteLLM, a company gateway. Add a key only if your server wants one. |

On another machine, use its address instead of `localhost`, for example `http://192.168.1.20:11434/v1`.

Reasoning text that some local models print (`<think>...</think>`) is removed before the host speaks.

## 2. Running a model on your own computer

A home computer with a recent graphics card (or an Apple Silicon Mac) runs a good radio host. Models around 4 to 12
billion parameters are plenty. Three things decide whether the app can reach it:

1. **It listens on the network.** Most local servers listen only on the same machine at first.
   - Ollama: set `OLLAMA_HOST=0.0.0.0` before starting it.
   - LM Studio: Developer tab, start the server, turn on **Serve on Local Network**.
   - llama.cpp: `llama-server -m model.gguf --host 0.0.0.0 --port 8080`.
   - vLLM: `vllm serve <model> --host 0.0.0.0 --port 8000`.
   - Jan: Settings, Local API Server, set the host to `0.0.0.0`.
2. **It allows the web app (CORS).** Only for the web app with **This device** (section 3). The phone apps and the
   **Host-Caster server** route do not need it.
   - Ollama: `OLLAMA_ORIGINS=https://radio.example.com` (your Host-Caster address), or `*` at home.
   - LM Studio: turn on **Enable CORS** next to the server switch.
   - Jan: turn on CORS in the Local API Server settings.
   - llama.cpp and vLLM allow every origin by default.
3. **https and http do not mix in browsers.** A web app opened over https cannot call a plain `http://` address
   on your network. Use the phone app, or set the brain to **Host-Caster server** and let your server make the call
   (allow the address on the server with `FETCH_ALLOW`, see [SELF-HOSTING.md](SELF-HOSTING.md#12-security-notes)).

The first answer after a model loads can take 30 seconds or more. Host-Caster starts writing a break well before the
song ends; if it is still not ready, the break is skipped and the music simply goes on.

## 3. This device or Host-Caster server

Every brain and voice has a **Connect from** switch:

| | This device (default) | Host-Caster server |
| --- | --- | --- |
| Who calls the provider | the phone or browser, directly | your Host-Caster server (`POST /api/ai/chat`, `/api/tts`) |
| Where the key is used | on this device | only on the server; the device does not keep it |
| Works signed out | yes | no, sign in first (Settings, Account) |
| Good for | models on your home network, phone apps, offline use | cloud keys you want on every device without pasting them again |
| Limits | web app: CORS and https rules (section 2) | the server must reach the provider; private addresses need `FETCH_ALLOW` |

On Android and iOS, **This device** uses the phone's own network stack: no CORS, plain http on your home network
works, and a model on your LAN works with no internet at all.

When you are signed in, keys are also saved on your server (encrypted) so they come along to your other devices.
See [PRIVACY.md](PRIVACY.md).

## 4. Voices

Add a voice engine in **Settings, Voices** (press **Load voices** to see what it offers), then pick an engine and a
voice for each host on the host's page. **Preview voice** plays a short line in that host's voice and style.

| Preset | Kind | Default address | Model | Key | Notes |
| --- | --- | --- | --- | --- | --- |
| This device | built in | none | none | none | Web Speech in the browser, the system voice engine on Android and iOS. Works offline. Speed and pitch per host. |
| OpenAI | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini-tts` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | 13 voices (Coral first). Gets a speaking style made from the host's energy, humor and style, or your own text. |
| ElevenLabs | ElevenLabs | `https://api.elevenlabs.io` | `eleven_flash_v2_5` | [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) | Lists the voices in your account, cloned ones too. The host's energy and humor tune stability and style. |
| Kokoro | OpenAI-compatible | `http://localhost:8880/v1` | `kokoro` | none | Free, fast, local ([Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)). Default voice `af_heart`; the voice list comes from the server. |
| Chatterbox | OpenAI-compatible | `http://localhost:8004/v1` | `chatterbox` | none | Expressive local voices. |
| Qwen3-TTS | OpenAI-compatible | `http://localhost:8001/v1` | `qwen3-tts` | none | |
| Orpheus | OpenAI-compatible | `http://localhost:5005/v1` | `orpheus` | none | Default voice `tara`. |
| Custom | OpenAI-compatible | you type it | `tts-1` | optional | Any server with `/v1/audio/speech`: openedai-speech, LocalAI, AllTalk and others. |

OpenAI-compatible servers are asked for their voices at `/v1/audio/voices`; when a server has no list, Host-Caster
offers OpenAI's voice names (most servers accept them). Speed works on every engine. Emojis, markdown and stage
directions are removed before a line is spoken.

The same **Connect from** switch (section 3) applies to voices. The same network rules apply to local voice
servers (section 2).

## 5. AI apps

Your hosts can hear from the AI assistant you already use. ChatGPT, Claude and other apps that support remote MCP
servers connect to your Host-Caster server and pass things to the hosts.

Set it up in **Settings, Connections, AI apps**: make a connection, copy its URL (`https://your-server/mcp/aw_...`)
and paste it into the assistant. Steps for ChatGPT and Claude are in
[SELF-HOSTING.md](SELF-HOSTING.md#10-ai-apps). You need to be signed in, and the assistant must reach your server
from the internet (a public https address).

Tools the assistant gets:

| Tool | What it does |
| --- | --- |
| `now_playing` | What is on air: station, song, artist, which host is talking. |
| `list_hosts` | Your hosts with a short description. |
| `send_note_to_hosts` (`text`, optional `until`) | A note the hosts work into the next breaks (a plan, a mood, good news). Expires after 24 hours or at `until`. |
| `queue_segment` (`text`, optional `hostName`) | A topic, story or shout-out for the next break, for a host you name or any. |
| `request_song` (`query`) | Asks the station to play a song from your music. |
| `add_life_event` (`title`, `date`, optional `yearly`) | A birthday, anniversary or trip the hosts remember. |

Try: "Tell my Host-Caster hosts I just got the job" or "Ask Host-Caster to play something by Fleetwood Mac".

The URL is the password. Anyone with it can send notes to your hosts. Delete the connection to cut it off.

## 6. Music sources

| Source | Where | What you need | Plays offline |
| --- | --- | --- | --- |
| Your files | Library, Add music | nothing | yes |
| Server library | Library (when signed in) | a server with `MUSIC_DIR` | no |
| Subsonic or Navidrome | Music services | your own server | on your network |
| Internet radio | Music services | nothing | no |
| YouTube | Music services | a Host-Caster server with Google sign-in | no |
| Spotify | Music services | Spotify Premium and a free Spotify developer app | no |
| Any music app | Android app | notification access | (the other app decides) |

### Your files

**Library, Add music**: **Add songs**, **Add a folder**, or drag files onto the window. MP3, M4A, AAC, FLAC, OGG, OPUS,
WAV, WEBM, AIFF and CAF work. Tags and covers are read on your device; duplicates are spotted by tags and file
fingerprint. Playlists: make your own, or import M3U, M3U8 and PLS files (songs are matched to your library);
export any playlist as M3U. Songs are stored inside the app on that device (Settings, Data & storage shows how
much space they use) and are never uploaded.

### Server library

Point your server's `MUSIC_DIR` at a music folder ([SELF-HOSTING.md](SELF-HOSTING.md#9-music-library-on-the-server)).
Signed-in devices see those songs in the Library (filter by source) and stream them with seeking. Every account on
that server shares this one library.

### Subsonic and Navidrome

Any server that speaks the Subsonic API: [Navidrome](https://www.navidrome.org), Airsonic-Advanced, Gonic,
Ampache and others.

1. **Settings, Music services, Your music server**.
2. Server address, for example `https://music.example.com` or `192.168.1.20:4533`.
3. Username and password, or an OpenSubsonic **API key** (Navidrome 0.56 and newer: Settings, Personal, API keys).
4. **Connect**, then browse playlists, albums, artists and starred songs, search, import, or make a station.

Host-Caster keeps a salted token, never your plain password (servers that only take passwords get the password in
the old Subsonic encoded form). Songs stream straight from your server; Host-Caster keeps only the song list and covers.
For the web app, your server must allow cross-origin requests (Navidrome does) and an https page needs an https
server. The phone apps have neither limit.

### Internet radio

**Settings, Music services, Internet radio**: search tens of thousands of stations from
[radio-browser.info](https://www.radio-browser.info) (a free community directory) by name, genre or country, save
the ones you like, or turn one into a Host-Caster station with your hosts. You can also paste any stream address
(including `.pls` and `.m3u` links) with **Library, Add music, Add internet radio**. Live streams have no song ends, so the hosts break in
on a timer instead.

### YouTube

Needs a Host-Caster server with Google sign-in and the YouTube Data API v3 switched on
([SELF-HOSTING.md](SELF-HOSTING.md#5-google-sign-in)).

1. **Settings, Music services, YouTube Music, Connect YouTube** (asks Google for read-only YouTube access).
2. Import your playlists or your Liked videos, or search for a song.

Music plays in YouTube's own player, and the video shows on Now Playing. The hosts talk over a lowered volume.
Some videos do not allow playback outside YouTube, and YouTube may show ads in its player. YouTube Music's own
"Liked music" list is not open to other apps, so Host-Caster uses your YouTube Liked videos.

### Apple Music, Amazon Music, Tidal, Deezer, SoundCloud, Pandora, Qobuz

These services have no open way for other apps to play their music, so Host-Caster cannot import them. On Android,
[Any music app mode](#8-any-music-app-mode-android) lets your hosts talk between their songs anyway.

## 7. Spotify, step by step

Spotify only lets apps play music for **Premium** accounts, and every Host-Caster install uses its own free Spotify
developer app. It takes about five minutes.

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and sign in with your Spotify
   account (the owner needs Premium).
2. **Create app**. Any name (for example "My Host-Caster") and description.
3. **Redirect URIs**: add the address Host-Caster shows on its Spotify card. It is your Host-Caster address plus
   `/spotify/callback`, for example `https://radio.example.com/spotify/callback`. For the phone apps also add
   `hostcaster://spotify`. Spotify accepts only https addresses, `http://127.0.0.1` (not `localhost`) and app links.
4. **Which API/SDKs are you planning to use**: tick **Web API** and **Web Playback SDK**. Accept the terms and
   save.
5. **User management**: add the name and Spotify email of everyone who will listen (yourself too). New apps
   allow up to 5 people.
6. Open the app's **Settings** and copy the **Client ID** (there is no secret: Host-Caster uses PKCE).
7. In Host-Caster: **Settings, Music services, Spotify**, paste the Client ID, press **Connect**, and allow access.

Then import your playlists and Liked Songs, or search. In a desktop browser Host-Caster plays Spotify itself. On phones
it remote-controls your Spotify app (Spotify Connect) and the hosts talk between songs. You can pick the device in
the Spotify card (**Play Spotify on**).

Running a server for your family? Put the Client ID in the server's `.env` as `SPOTIFY_CLIENT_ID` and nobody has to
paste it. You still add each listener under User management.

Host-Caster asks Spotify for: your profile, your playlists and Liked Songs (read only), playback in the browser, and
reading and controlling what plays on your devices.

## 8. Any music app mode (Android)

Keep listening in the app you like (YouTube Music, Spotify, Apple Music, Amazon Music, a podcast player) and let
your hosts break in between its songs.

1. Install the Android app.
2. **Settings, This device, Any music app**: turn on **notification access** for Host-Caster. If the switch is grey
   (an app installed outside the Play Store on Android 13 or newer): **App info**, the menu in the corner,
   **Allow restricted settings**, then try again.
3. Start a song in your music app. Host-Caster shows it under **Any music app**.
4. **Open the station** (or **Settings, Music services, Other music apps, Set up an Any music app station**) and
   go on air.

Host-Caster reads only the song, artist and cover of what is playing. When a host talks, the other app lowers its
volume or pauses and then carries on. The notification, lock screen and headset buttons control the other app.

iOS does not let apps see what other apps are playing, so this mode is Android only.
