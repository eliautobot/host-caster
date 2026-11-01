# Privacy: where your data goes

Host-Caster is local first. With no account, everything stays on your phone or in your browser, and the only things
that leave it are the calls you set up yourself (an AI model, a voice, the weather, a radio stream). There is no
analytics, no tracking and no Host-Caster company server: the only server is the one you (or a friend) run.

This page lists what is stored where, what each outside service sees, and how to delete it.

## Contents

1. [On your device](#1-on-your-device)
2. [On your Host-Caster server](#2-on-your-host-caster-server)
3. [Encryption at rest](#3-encryption-at-rest)
4. [What AI brains see](#4-what-ai-brains-see)
5. [What voice engines see](#5-what-voice-engines-see)
6. [Other services the app talks to](#6-other-services-the-app-talks-to)
7. [Google and X permissions](#7-google-and-x-permissions)
8. [AI apps (MCP)](#8-ai-apps-mcp)
9. [Notion](#9-notion)
10. [Server logs](#10-server-logs)
11. [Deleting your data](#11-deleting-your-data)

## 1. On your device

The app keeps its data in the browser's private storage (IndexedDB) for the Host-Caster address, or inside the app on
Android and iOS. Other websites and apps cannot read it.

| What | Notes |
| --- | --- |
| Your songs and covers | Files you import are copied into the app. They are never uploaded. |
| Library, playlists, likes, play counts | |
| Hosts and stations | Names, personalities, voices, schedules. |
| Brains and voices | Addresses, models and, for **This device** connections, the API key. |
| On-air history | The lines your hosts said, with the songs around them. Stays on the device (not synced). |
| About me | Your name, what to call you, a few lines about you, your place, life events, notes, reminders, interests and topics to avoid. |
| Settings | Theme, connections, the address of your Host-Caster server. |
| Cache | Last weather, calendar, email summaries, news headlines and AI app notes, so the radio keeps working offline. |
| Music service logins | Spotify sign-in tokens; for Subsonic a salted token (never your plain password, except for old servers that only accept passwords). |
| Your Host-Caster sign-in | A session token for your server. |

Host-Caster does not add its own encryption on the device. Anyone who can open your unlocked phone or your browser
profile could read these, keys included. Use a screen lock, and a separate browser profile on shared computers.

**Microphone and location** are used only when you press the button: the microphone for a call-in to your hosts,
location for "use my location" on the About me page (rounded to about 100 m).

## 2. On your Host-Caster server

Signing in is optional. When you do, the server keeps the following in one SQLite file (`DATA_DIR/hostcaster.db`):

| Table | What it holds |
| --- | --- |
| `users` | Your name, email, photo address, and a password hash if you use a password. |
| `identities` | Each Google or X link: provider, account id, granted permissions, profile (name, email, photo) and the sign-in tokens (encrypted). |
| `sessions` | One row per signed-in device: a hash of the session token, web or app, the browser or app name, created, last seen and expiry times. |
| `sync_docs` | Your synced data as one document: hosts, stations, brains and voices (without keys), playlists (names only, no songs), About me and settings (including private calendar links you added). |
| `secrets` | API keys for brains and voices, and your IMAP mailbox login (encrypted). |
| `inbox` | Notes, segments, song requests and dates sent by AI apps, until the radio uses them (used items are cleaned up after about a week). |
| `connector_tokens` | Your AI app connections: name, a hash of the token, the token itself (encrypted, so you can copy the URL again), last used time. |
| `user_state` | Only while you have an AI app connection: the song on air right now, so AI apps can ask "what is playing" (only the latest, overwritten each song; removing your last connection deletes it). |
| `notion_links` | Only while Notion is connected: the workspace name and icon, the Notion sign-in token (encrypted), and your choices (which pages the hosts read, where they write, the two switches). |
| `notion_activity` | Only while Notion is connected: what the hosts added to your Notion or tried to (the text, the page name, when, and the id of that one block so Undo can remove it), the newest 200. |
| `auth_flows` | Short-lived sign-in steps (a few minutes). |
| `server_tracks` | The server music library: file paths and tags. Shared by everyone on that server. |

Next to the database: `DATA_DIR/secret.key` (the encryption key, unless set with `SECRET_KEY`) and `DATA_DIR/art`
(covers from the server music library).

**Not stored on the server:** your songs from the device, your on-air history, calendar events, emails and the
contents of your Notion pages. When the hosts need your calendar, mail or Notion, the server fetches them from
Google, your mailbox or Notion at that moment and passes them to your device; the device caches them. Notion page
summaries also stay in the server's memory for up to 10 minutes (never on disk).

**Keys:** when you sign in, the app uploads your brain and voice keys to the server (encrypted) so your other
devices can use them. Keys for **Host-Caster server** connections then leave the device; **This device** connections
keep a copy on the device too. Keys are never sent back to an app: apps only see a short hint like `sk-…a1b2`.

## 3. Encryption at rest

- **Encrypted** with AES-256-GCM: API keys, the IMAP login, Google and X tokens, Notion tokens, ChatGPT sign-in
  tokens, AI app connection tokens. Each value is bound to its account and name, so it cannot be copied to another account. The key
  is `SECRET_KEY` (32 random bytes) or `DATA_DIR/secret.key`.
- **Hashed** (cannot be turned back): session tokens and AI app tokens (SHA-256), passwords (scrypt), sign-in steps.
- **Plain** in the database: everything else, including the synced document with your hosts and About me.

Encryption protects a copied database file or backup that is missing the key. It does not hide anything from the
person who runs the server: they have the key. Only use a server run by someone you trust, and on your own server
turn on disk encryption and keep backups private.

## 4. What AI brains see

When a host writes a break, the brain you picked for that host gets one request with:

- the host's personality, style and rules, and the other hosts' names;
- what to call you, and what you wrote about yourself and your interests (and the topics to avoid);
- the facts for this break, but only for the segments switched on for the station: time of day, the songs before
  and after, the weather and your place name, calendar items (title, time, place), emails (the sender's name and
  the subject, never the text), news headlines, life events, notes, reminders, notes from AI apps, and short
  summaries of the Notion pages you picked (open to-dos, headings, a little text);
- when you ask the hosts to add something to Notion (on a call or from an AI app), your words, so the station's
  brain can tell what to add (one to-do or one note, nothing else);
- the last few breaks, so the hosts do not repeat themselves;
- your words when you call in.

Designing a host from a description and a host's test line also send a short request. Nothing else is sent: no song
files, no keys of other providers, no history beyond the last breaks.

The **scripted fallback** (short lines the hosts read until an AI is connected, or when it is out of reach) sends
nothing anywhere. A model on your own computer keeps it all in your home.

**ChatGPT plan** brains: the same request goes to OpenAI on your ChatGPT account, with "do not store" set on every
request. Your ChatGPT sign-in stays on your Host-Caster server (encrypted), never in the browser or on the phone, and
gives Host-Caster no access to your ChatGPT chats. The server also sends OpenAI a random id for itself (not your name or
email). Disconnect, or remove Host-Caster in ChatGPT's settings, to end it.

Cloud providers have their own rules about storing requests and using them for training. Check the privacy page
of the provider you choose (most API plans do not train on your data by default).

## 5. What voice engines see

Each line a host says (cleaned of emojis and markdown), the voice id, the speed and a short speaking-style
description of the host. **This device** voices speak on your device. In some browsers the system voices are
online voices from the browser's maker (for example Google voices in Chrome).

## 6. Other services the app talks to

| Service | When | What it sees |
| --- | --- | --- |
| [Open-Meteo](https://open-meteo.com) | Weather is on | Your place's coordinates. Place search sends what you type. |
| [BigDataCloud](https://www.bigdatacloud.com) | You press "use my location" | Rounded coordinates, to find the town name. |
| News and calendar feeds | Feeds you add, and the public news feeds for your region (news is on by default; Settings, Connections, News switches it off or picks other feeds) | A normal request for the feed, nothing about you. In the web app, signed in, your server fetches it for you. |
| [radio-browser.info](https://www.radio-browser.info) | You browse internet radio | Your searches. Streams are played from each station's own server. |
| Subsonic or Navidrome | You connect it | Your username and a salted token, and which songs you play. |
| Spotify | You connect it | Your Spotify account, what you import and play (directly from your device, with your own developer app). |
| YouTube | You connect it | Your server reads your playlists with Google's permission; songs play in YouTube's own player, so YouTube sees what you play. |
| Speech recognition | You call in by voice | Your words go to the browser's or phone's speech service (Chrome uses Google's servers; Android and iOS may work on the device). |

The app's font and icons are bundled, so no font or icon services are contacted.

On Android, **Any music app** mode reads the song title, artist and cover from the other app's notification. It
does not read other notifications and keeps nothing.

## 7. Google and X permissions

Google sign-in asks only for what you switch on, one service at a time, always read only:

| Permission | Asked when | Why |
| --- | --- | --- |
| `openid`, `email`, `profile` | Sign in | Know who you are; your name and photo in the app. |
| `calendar.readonly` | You turn on Google Calendar | The hosts mention what is coming up today and tomorrow. |
| `gmail.readonly` | You turn on Gmail | The hosts mention unread and important mail (sender and subject only). Host-Caster never sends, deletes or changes mail. |
| `youtube.readonly` | You connect YouTube | Import your playlists and Liked videos, and search. |

Host-Caster asks Google for offline access, so the server can read the calendar when the hosts need it without you
signing in again. The tokens are encrypted on the server (section 3).

X sign-in asks for `users.read` and `tweet.read`, only to know who signed in (X requires both for that). Host-Caster
never posts or reads your timeline.

Remove access any time: in Host-Caster (**Settings, Account, Unlink**, which also revokes the tokens), in your
[Google Account](https://myaccount.google.com/connections) or in X (Settings and privacy, Security and account
access, Apps and sessions, Connected apps).

## 8. AI apps (MCP)

An AI app you connect (ChatGPT, Claude and others) can read what is playing and your hosts' names, taglines and a
short part of their personality. It can add notes, segments, song requests and dates for your hosts. It cannot
read your About me, calendar, mail, keys or history. Whatever you tell that assistant is covered by its own privacy
rules. Delete the connection in **Settings, Connections, AI apps** to cut it off at once.

## 9. Notion

Only when you connect it in **Settings, Connections, Notion**. Notion asks you which pages Host-Caster may see; it
cannot see anything else in your workspace.

- **Reads** only the pages and databases you pick under "Hosts can read" (up to 5): open to-dos, headings, list items,
  a little text, and the newest open entries of a database. Finished to-dos and entries are left out.
- **Writes** only when you ask: on a call ("add oat milk to my list") or from your AI app. One to-do or one note per
  ask, with the time, on the page you picked under "Hosts write to" (by default a "Host-Caster" page made inside it).
  The hosts say on air that it is done, or why it did not work.
- **Never** changes, moves or deletes what you wrote. Undo in the activity list moves only the block the hosts added to
  Notion's trash. "Hosts may add notes when I ask" turns writing off; the daily recap is off until you turn it on.
- **Stored:** the Notion token (encrypted), your choices and the list of what was added (section 2). Page contents
  are not stored.
- **Disconnect** revokes the token at Notion and deletes the link and the list. What the hosts already added stays in
  your Notion (it is yours). You can also remove Host-Caster in Notion under Settings, Connections.

## 10. Server logs

At the default level (`LOG_LEVEL=info`) the server logs each request: time, method, path, IP address and status.
The secret part of an AI app connection URL and the one-time sign-in codes are written as `***`. Logs still hold
IP addresses, so keep them private and short, or set `LOG_LEVEL=warn`. Host-Caster does not write keys, passwords or your synced data to the logs.

## 11. Deleting your data

| To delete | Where |
| --- | --- |
| Everything on one device | **Settings, Data & storage, Delete data on this device** (also signs you out there; your account keeps its synced copy). Uninstalling the app or clearing the site's data in the browser does the same. |
| Your account and everything the server keeps for it | **Settings, Account, Delete account**. Removes everything the server keeps for your account (every table above except the shared music library) and revokes Google, X and Notion access. The device you do it on keeps its local copy until you delete that too. |
| One sign-in method | **Settings, Account, Unlink** (revokes its tokens). |
| Other signed-in devices | **Settings, Account, Sign out other devices**. |
| An AI app's access | **Settings, Connections, AI apps**, delete the connection. |
| Notion's access | **Settings, Connections, Notion, Disconnect** (revokes the token, deletes the list of what was added). |
| A brain or voice key | Delete that brain or voice in Settings. |
| Spotify's access | Disconnect in Host-Caster, and remove the app at [spotify.com/account/apps](https://www.spotify.com/account/apps/). |
| Any music app access | Android settings, notification access, turn Host-Caster off. |
| A whole server | Stop it and delete `DATA_DIR` (Docker: `docker compose down -v`). |

Backup files you export (**Settings, Data & storage, Backup**) hold your hosts, stations, library, history and
settings, your music service sign-ins, and, if you choose, your songs and API keys. Keep them somewhere private.
