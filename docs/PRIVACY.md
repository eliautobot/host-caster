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
10. [Hosts looking things up](#10-hosts-looking-things-up)
11. [What your hosts remember](#11-what-your-hosts-remember)
12. [Your list and things your hosts can do](#12-your-list-and-things-your-hosts-can-do)
13. [Server logs](#13-server-logs)
14. [Deleting your data](#14-deleting-your-data)

## 1. On your device

The app keeps its data in the browser's private storage (IndexedDB) for the Host-Caster address, or inside the app on
Android and iOS. Other websites and apps cannot read it.

| What | Notes |
| --- | --- |
| Your songs and covers | Files you import are copied into the app. They are never uploaded. |
| Music found on the device | Only if you turn it on (Library, Add music, Find music on this device or Add a music folder). The app keeps a list of the song files (name, folder, size, date, tags) and a small cover per album; the songs stay where they are and play from there. Never uploaded, never synced. |
| Library, playlists, likes, play counts | |
| Hosts and stations | Names, personalities, voices, schedules. |
| Brains and voices | Addresses, models and, for **This device** connections, the API key. |
| On-air history | The lines your hosts said, with the songs around them. Stays on the device (not synced). |
| About me | Your name, what to call you, a few lines about you, your place, life events, notes, reminders, interests and topics to avoid. |
| Settings | Theme, connections, the address of your Host-Caster server. |
| Cache | Last weather, calendar, email summaries, news headlines and AI app notes, so the radio keeps working offline. |
| What your hosts found out | Short notes your hosts wrote about what is coming up in your day (section 10), kept 7 days. Not synced. |
| Lookups list | What your hosts read on this device and when, the newest 300. |
| Your list | What your hosts keep track of for you: things to do, deadlines, bills, deliveries, invitations to answer (section 12). Synced when you are signed in. |
| Heads-ups | The recent heads-ups (what changed, when it was told, why it counted), kept 2 days. |
| Music service logins | Spotify sign-in tokens; for Subsonic a salted token (never your plain password, except for old servers that only accept passwords). |
| Your Host-Caster sign-in | A session token for your server. |

Host-Caster does not add its own encryption on the device. Anyone who can open your unlocked phone or your browser
profile could read these, keys included. Use a screen lock, and a separate browser profile on shared computers.

**Microphone and location** are used only when you press the button: the microphone during a call you start (Call
the station) and until you hang up, location for "use my location" on the About me page (rounded to about 100 m).

**Calls and the hosts' chat.** A call's speech is turned into text by your phone's own recognizer (Android, iOS) or
your browser's speech recognition (Chrome, Edge, Safari send the audio to their maker's speech service, as they do for
any website); Host-Caster has no speech-to-text server of its own and never keeps or uploads audio. What is kept: your
words of each call and chat message go in the journal on this device (Recently, 14 days, the same as a call-in), the
hosts' side of a call goes in the On-air history like a break, and the chat thread stays on this device for 12 hours.
Each turn sends your words and the conversation so far to the hosts' AI brain (section 4) and their answer to the
voice engine (section 5), like a break. Calls last up to 20 minutes. "Hosts may mention our chat on air" is off unless
you turn it on.

**Music and audio (Android)** is asked for only when you choose Find music on this device. The app then reads the
phone's own list of music files (Android's media library: title, artist, album, length, folder, size and the cover
inside the file), only the ones marked as music; ringtones, alarms, notification sounds, podcasts, recordings, voice
notes and files under 30 seconds are left out. With Keep my music up to date it reads that list again when the app
opens or comes back. Nothing about these files leaves the phone. On a computer, the desktop app and Chrome or Edge read
only the music folders you pick. To stop, use Remove from library in the same place, then take the permission back in
the phone's settings (or remove the folder).

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
| `agent_lookups` | The Lookups list (section 10): what your hosts read, in a few words ("Email search: launch checklist"), which host, why, when, whether it worked. Never what they found. Kept 30 days. |
| `actions` | Only once your hosts suggested something for your Google account (section 12): what kind of action, its status (suggested, done, failed, undone) and when. The details (the event or task, your words, the result) are encrypted; the one-time confirmation is kept only as a hash. Kept 90 days. |
| `auth_flows` | Short-lived sign-in steps (a few minutes). |
| `server_tracks` | The server music library: file paths and tags. Shared by everyone on that server. |

Next to the database: `DATA_DIR/secret.key` (the encryption key, unless set with `SECRET_KEY`) and `DATA_DIR/art`
(covers from the server music library).

**Not stored on the server:** your songs from the device, your on-air history, calendar events, emails and the
contents of your Notion pages. When the hosts need your calendar, mail or Notion, the server fetches them from
Google, your mailbox or Notion at that moment and passes them to your device; the device caches them. Notion page
summaries also stay in the server's memory for up to 10 minutes (never on disk). An item on Your list can hold a
short line taken from an email or an event (section 12); it syncs encrypted.

**Keys:** when you sign in, the app uploads your brain and voice keys to the server (encrypted) so your other
devices can use them. Keys for **Host-Caster server** connections then leave the device; **This device** connections
keep a copy on the device too. Keys are never sent back to an app: apps only see a short hint like `sk-…a1b2`.

## 3. Encryption at rest

- **Encrypted** with AES-256-GCM: API keys, the IMAP login, Google and X tokens, Notion tokens, ChatGPT sign-in
  tokens, AI app connection tokens, what your hosts remember about you and Your list (the memory cards and the list
  items in your synced document), and the details of each action in the actions log. Each value is bound to its account and name, so it cannot be copied to another account. The key
  is `SECRET_KEY` (32 random bytes) or `DATA_DIR/secret.key`.
- **Hashed** (cannot be turned back): session tokens, AI app tokens and action confirmations (SHA-256), passwords
  (scrypt), sign-in steps.
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
  the subject, and for the first few unread messages a few lines of what they say), news headlines, life events,
  notes, reminders, notes from AI apps, and short summaries of the Notion pages you picked (open to-dos, headings, a
  little text);
- for an event or an email the break is about: a few lines of the details (what it is about, who is invited and who
  said yes, that it is a video call but never the link) and what your hosts found out about it (section 10);
- when you ask the hosts to add something to Notion (on a call or from an AI app), your words, so the station's
  brain can tell what to add (one to-do or one note, nothing else);
- the one or two items from Your list a break brings up (what, when, where it came from; never links, email
  addresses or codes), and, when you ask the hosts to do something (section 12), your words with the titles of your
  open invitations and Google tasks, so the brain can tell which one you mean;
- the last few breaks, so the hosts do not repeat themselves;
- your words when you call in;
- when hosts look things up (section 10), what each lookup found goes to that host's brain too.

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
| Web search | Hosts look things up and **Search the web** is on (section 10) | Only the search words. Which service depends on the server: its owner picks SearXNG, Brave Search or Tavily, or none. |
| A web page linked from your day | Hosts look things up and read a page linked from an event, an email or a headline | A normal request from your Host-Caster server, without your cookies or sign-ins. |

The app's font and icons are bundled, so no font or icon services are contacted.

On Android, **Any music app** mode reads the song title, artist and cover from the other app's notification. It
does not read other notifications and keeps nothing.

## 7. Google and X permissions

Google sign-in asks only for what you switch on, one service at a time. Everything is read only except the last
two, which you turn on yourself (section 12):

| Permission | Asked when | Why |
| --- | --- | --- |
| `openid`, `email`, `profile` | Sign in | Know who you are; your name and photo in the app. |
| `calendar.readonly` | You turn on Google Calendar | The hosts mention what is coming up today and tomorrow. |
| `gmail.readonly` | You turn on Gmail | The hosts mention unread and important mail (who wrote and what it is about, and what a message says when it matters or when you ask on a call-in), and Your list checks whether you ever wrote to a sender (section 12). Host-Caster never sends, deletes or changes mail. |
| `youtube.readonly` | You connect YouTube | Import your playlists and Liked videos, and search. |
| `calendar.events` | You turn on **Hosts can add to my calendar** | Add an event or answer an invitation, only after you say yes. |
| `tasks` | You turn on **Hosts can use my Google Tasks** | Show your open tasks in Your list; add, tick off or change a task only after you say yes. |

Host-Caster asks Google for offline access, so the server can read the calendar when the hosts need it without you
signing in again. The tokens are encrypted on the server (section 3).

X sign-in asks for `users.read` and `tweet.read`, only to know who signed in (X requires both for that). Host-Caster
never posts or reads your timeline.

Remove access any time: in Host-Caster (**Settings, Account, Unlink**, which also revokes the tokens), in your
[Google Account](https://myaccount.google.com/connections) or in X (Settings and privacy, Security and account
access, Apps and sessions, Connected apps).

## 8. AI apps (MCP)

An AI app you connect (ChatGPT, Claude and others) can read what is playing and your hosts' names, taglines and a
short part of their personality. It can add notes, segments, song requests and dates for your hosts. A note that
asks the hosts to do something counts as your own words: it may add to Your list, but anything in your Google account
still waits for your own yes (section 12). It cannot read your About me, calendar, mail, keys or history. Whatever you tell that assistant is covered by its own privacy
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

## 10. Hosts looking things up

When a host on the station has an AI brain, the hosts can look things up: before a break they read more about what
is coming up in your day, and when you call in with a question ("what's that meeting about?") they can check.

- **What they read:** only what you connected, and only to talk about your day and answer your questions. The full
  details of a calendar event, related emails in your mailbox (search, one message, one conversation), the Notion
  pages you picked, a web page or article linked from an event, an email or a headline, the weather for a place and,
  when it is on, a web search. Lookups only read: they never send, change or delete anything, and they cannot see
  anything you did not connect.
- **Where it runs:** Google Calendar, Gmail, your IMAP mailbox, Notion, linked pages and web search run on your
  Host-Caster server, which fetches them at that moment and does not keep what it read. The weather and calendar
  links (ICS) are read on your device. What a lookup finds goes to that host's brain, like the rest of a break.
- **What your hosts found out** is kept on your device for 7 days (Settings, What your hosts can see), so the hosts
  can mention it and answer questions later. It is not synced.
- **The Lookups list** (Settings, What your hosts can see, Lookups) shows every lookup: what was read in a few words,
  which host, when, and whether it worked. Signed in, it is the same on every device and the server keeps it for 30
  days (section 2); **Clear** empties it.
- **Web search** sends only the search words, never your name, your calendar or your mail. When hosts look into your
  events and mail on their own they never search the web; they search only for news headlines and for questions you ask.
- **Limits:** at most 400 lookups and 40 web searches a day per account (the server owner can change both), and a
  few lookups per task.
- **Heads-ups:** while the radio is playing (never while it is paused or off), your device asks your Host-Caster
  server every 2 to 3 minutes what changed in your Google Calendar and Gmail since the last check, and reads your
  calendar links (ICS) and IMAP mailbox every 5 minutes or so. These are the same sources the hosts already read for
  breaks, asked more often while you listen; nothing new leaves your device or the server, and the server does not
  keep what it read. When something important changed (a meeting cancelled or moved, something new starting soon, an
  urgent email from a real person; newsletters and promotions never count), the station's lead host may judge it and
  look up why, like the lookups above, and tells you once. The list of recent heads-ups (what, when, why it counted)
  is kept on your device for 2 days (Settings, What your hosts can see, Heads-ups) and is not synced. Set **Break in
  for urgent things** to Off and **Meeting reminders** to Off to keep everything for the regular breaks.
- **Turn it off:** Settings, What your hosts can see, switch off **Hosts can look things up** (or just **Search the
  web**). The hosts then talk only from what they already have. Hosts with no AI brain never look anything up.

## 11. What your hosts remember

Your hosts keep a small memory about you, so they can pick up where you left off ("yesterday you asked about...",
"your sister is visiting this weekend"). You see all of it in **Settings, What your hosts remember**, and you can
edit, pin or delete any of it, add your own, or forget everything.

- **Memory cards** (long-term): at most 60 short cards of up to 200 characters, shared by all your hosts: about you,
  people, preferences, routines and patterns, plans and dates (a plan is forgotten after its date), running jokes.
  Each card says where it came from ("you said it on a call-in, Nov 1", "learned from how you listen", "you added it").
  What you write in **About me** always comes first; the hosts never change it, or a card you wrote or edited.
- **Recently** (short-term): one short line per thing that happened on your radio: what you said on call-ins and
  in messages from your AI app, heads-ups and "got it", songs you liked, skipped early or asked for, the stations and
  hours you listened, and what the hosts covered. No audio. Kept 14 days **on this device only**, then deleted.
- **Where it comes from:** only your own words (call-ins, your AI app, your edits) and what you do in the app.
  Never from your email, calendar, Notion, web pages or the news, so a message cannot plant a memory. Passwords,
  codes, card and account numbers, IDs, email addresses and links are never kept. Health, money, relationships,
  religion and politics are kept only when you say "remember that ..." yourself.
- **How it learns:** "remember that ..." and "forget that ..." work right away with any brain. With an AI brain,
  after a call-in or an AI app message the host's brain makes one small, checked step: anything worth remembering?
  Once a day it looks for patterns in how you listen (only with real evidence: at least 3 times over 2 days), and
  once a week it tidies up (duplicates, a fact that changed, plans that are over). These calls go to the host's brain
  like the breaks do (on Host-Caster AI they count toward your included AI, at most 30 learning steps a day). Without
  an AI brain, only the rules learn (patterns, "remember that ..."). Two switches turn learning off: **Learn from
  what I say** and **Learn from how I listen**.
- **Where it is kept:** on your device. When you are signed in, the cards sync to your other devices with your synced
  document; the server keeps them **encrypted at rest** (AES-256-GCM, bound to your account, see section 3). The
  journal (Recently) never leaves the device. Both are in the backup file you export. Deleting your account deletes
  the server's copy.

## 12. Your list and things your hosts can do

Your hosts keep track of what is on your plate (**Your list**) and, when you allow it, can add to your Google
Calendar and Google Tasks for you. Two rules hold everywhere:

1. **Outside content is information, never instructions.** An email, an invitation, a Notion page, a web page or the
   news can only become an item on Your list, labeled with where it came from. It never becomes a memory, a setting
   or an action, and it can never make the hosts do anything.
2. **The hosts only suggest, you decide, the app acts.** Nothing is written to your Google account until you say yes.

**Your list**

- **What an item holds:** what it is (up to 160 characters), the kind (to-do, waiting for, deadline, bill, delivery,
  invitation, prepare), when it is due or when to remind you, who it is about, where it came from (a label like
  "Email from Dana" and a link back), its status (open, done, snoozed, dismissed) and the flags below.
- **Where items come from:** your events, important mail (never newsletters or promotions), open to-dos on the
  Notion pages you picked, the research desk's notes (section 10), your Google Tasks (when you turn them on) and what
  you said ("remind me to renew my license this month", on a call-in or from your AI app). The gear on Your list
  chooses the sources (**From my email**, **From my calendar**, **From Notion**) or turns it off (**Keep Your list**).
- **"Be careful, check it's real":** an item is flagged, and the hosts warn you once instead of treating it as your
  to-do, when it asks for money, gift cards, passwords, codes or logins, asks you to click a link, has text that
  tries to instruct the hosts, or comes from a sender you never emailed. For that last check your Host-Caster server
  asks Gmail whether your sent mail has a message to that address (a search `in:sent to:<address>`, one result at
  most) and keeps only the yes or no, cached a week on your device. Without Gmail every sender counts as new. Links,
  email addresses and codes are never read on air.
- **How the hosts bring it up:** one item a break (two in the morning rundown), at most 4 an hour, the same item not
  again for hours. Mail that suggests something is done ("thanks for the quotes") only makes the hosts ask.
- **Where it is kept:** on your device. Signed in, it syncs with your synced document; the server keeps it
  **encrypted at rest** like the memory cards (section 3). It is in the backup file you export. Deleting your account
  deletes the server's copy.

**Things your hosts can do**

- **Only from a fixed list:** add an event to your calendar, answer an invitation, add, tick off or change a Google
  task. Adding to Your list, an app reminder or a Notion note (section 9) is your own space and happens right away
  when you ask.
- **Only after your yes:** when you ask on a call-in or from your AI app, the hosts read back exactly what will
  happen, with the date and time worked out ("Add Dentist to your calendar on Tuesday, November 3, from 3 PM to 4
  PM?"), and a card shows it in the app. Only your own "yes" on a call-in or a tap on **Yes** confirms it. "No",
  "cancel" or silence does nothing, and the suggestion expires after 10 minutes. Your AI app never confirms for you.
- **Your yes is a one-time token** bound to that exact action: it expires in 2 minutes, works once, only for your
  account, and not at all if anything in the action changed. A double "yes" or a second device still makes one event.
- **Log and Undo:** what the hosts did, or tried, is in **Your list, Done for you**, with **Undo** for a week. When
  Google does not answer, the hosts say so plainly; nothing is ever added twice.

What is written to your Google account, and when (always right after your yes):

| What | What Google gets | Undo |
| --- | --- | --- |
| An event | A new event on your primary calendar: the title, the time and the place or notes you said. No guests, and Google sends no emails about it. | Deletes the event. |
| An answer to an invitation | Only your own answer (yes, no or maybe, with a note if you said one). The organizer sees it; nothing else in the event changes. | Puts your previous answer back. |
| A Google task | Adds a task (title, due day, notes), ticks one off, or changes its title, due day or notes. | Deletes the task added, reopens the one ticked off, or puts back what it said. |

**Never**, even when you ask: payments or purchases, deleting or forwarding mail, sharing your data, inviting
people, changing other people's events, email drafts, or anything only an email or a page asked for.

- **Permissions:** `calendar.events` and `tasks` (section 7) are asked for only when you turn on **Hosts can add to
  my calendar** or **Hosts can use my Google Tasks** (Settings, Connections, Google). Turning a switch off stops the
  hosts at once. To remove the permission completely, unlink Google (Settings, Account, Unlink) or remove Host-Caster
  on your [Google Account](https://myaccount.google.com/connections) permissions page.
- **The actions log** on the server (`actions`, section 2): what, when and the status; the details of each action
  are encrypted at rest. Kept 90 days, deleted with your account.
- **Limits:** at most 50 actions and 200 suggestions a day per account (the server owner can change both).

## 13. Server logs

At the default level (`LOG_LEVEL=info`) the server logs each request: time, method, path, IP address and status.
The secret part of an AI app connection URL and the one-time sign-in codes are written as `***`. Logs still hold
IP addresses, so keep them private and short, or set `LOG_LEVEL=warn`. Host-Caster does not write keys, passwords or your synced data to the logs.

## 14. Deleting your data

| To delete | Where |
| --- | --- |
| Everything on one device | **Settings, Data & storage, Delete data on this device** (also signs you out there; your account keeps its synced copy). Uninstalling the app or clearing the site's data in the browser does the same. |
| Your account and everything the server keeps for it | **Settings, Account, Delete account**. Removes everything the server keeps for your account (every table above except the shared music library) and revokes Google, X and Notion access. The device you do it on keeps its local copy until you delete that too. |
| One sign-in method | **Settings, Account, Unlink** (revokes its tokens). |
| Other signed-in devices | **Settings, Account, Sign out other devices**. |
| An AI app's access | **Settings, Connections, AI apps**, delete the connection. |
| Notion's access | **Settings, Connections, Notion, Disconnect** (revokes the token, deletes the list of what was added). |
| The Lookups list | **Settings, What your hosts can see, Lookups, Clear** (on every device signed in to your account). |
| What your hosts remember | **Settings, What your hosts remember**: delete a card or a line of Recently, or **Forget everything** (the cards on every device signed in to your account, and this device's Recently). Saying "forget that" on a call-in deletes the last thing they learned. |
| An item on Your list | **Your list**: tick it off or dismiss it (done items fade out after a week). The gear on Your list turns off **Keep Your list** or a source. |
| Something your hosts did in Google | **Your list, Done for you, Undo** (for a week). The event or task itself can also be deleted in Google as usual. |
| Your hosts' Google write access | Turn off **Hosts can add to my calendar** or **Hosts can use my Google Tasks** (Settings, Connections, Google); to remove the permission too, **Settings, Account, Unlink** Google or your [Google Account](https://myaccount.google.com/connections) page. |
| The actions log | Deleted with your account; otherwise kept 90 days. |
| A brain or voice key | Delete that brain or voice in Settings. |
| Spotify's access | Disconnect in Host-Caster, and remove the app at [spotify.com/account/apps](https://www.spotify.com/account/apps/). |
| Any music app access | Android settings, notification access, turn Host-Caster off. |
| A whole server | Stop it and delete `DATA_DIR` (Docker: `docker compose down -v`). |

Backup files you export (**Settings, Data & storage, Backup**) hold your hosts, stations, library, history,
what your hosts remember, Your list and settings, your music service sign-ins, and, if you choose, your songs and API keys. Keep them somewhere private.
