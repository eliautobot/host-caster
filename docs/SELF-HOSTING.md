# Running your own Host-Caster server

Host-Caster works on a phone or in a browser with no server at all: songs, hosts and stations stay on that device. A
server adds:

- **Accounts and sync**: hosts, stations, brains, voices, your profile and settings on every device you sign in on.
- **Your keys in one safe place**: AI and voice keys are stored encrypted on the server and used from there.
- **Calendar and email for the hosts**: Google Calendar, Gmail, YouTube playlists, any IMAP mailbox.
- **Hosts that look things up**: event details, related mail, Notion pages, linked pages and, if you set one up, web
  search (section 3).
- **Feeds without CORS trouble**: ICS calendars and RSS news fetched by the server.
- **A server music library**: a folder of music on the server, streamed to every device.
- **AI apps**: ChatGPT, Claude, Grok and other assistants can send notes and segments to your hosts (MCP).

One small Node.js process does all of it and serves the web app too. Data lives in one SQLite file.

Setting up AI models, voices and music services: [PROVIDERS.md](PROVIDERS.md). What the server stores and who
sees what: [PRIVACY.md](PRIVACY.md).

YouTube with your own Google sign-in: [YOUTUBE.md](YOUTUBE.md). Your ChatGPT plan as the hosts' brain:
[CHATGPT-PLAN.md](CHATGPT-PLAN.md). Every music source: [MUSIC-SOURCES.md](MUSIC-SOURCES.md).

## Contents

1. [Quick start with Docker](#1-quick-start-with-docker)
2. [Without Docker](#2-without-docker)
3. [Settings](#3-settings)
4. [HTTPS in front](#4-https-in-front)
5. [Google sign-in (calendar, Gmail, Tasks, YouTube)](#5-google-sign-in)
6. [X sign-in](#6-x-sign-in)
7. [Email and password accounts](#7-email-and-password-accounts)
8. [Phone apps and your server](#8-phone-apps-and-your-server)
9. [Music library on the server](#9-music-library-on-the-server)
10. [AI apps (ChatGPT, Claude, Grok, Meta AI) and Notion](#10-ai-apps)
11. [Backups, updates and moving](#11-backups-updates-and-moving)
12. [Security notes](#12-security-notes)
13. [Troubleshooting](#13-troubleshooting)

## 1. Quick start with Docker

You need Docker with the Compose plugin.

```sh
git clone <this repo> hostcaster && cd hostcaster
cp .env.example .env          # set PUBLIC_URL; add Google / X later
docker compose up -d --build
docker compose logs -f        # "Server listening at http://0.0.0.0:8660"
```

Open `http://localhost:8660` on the same machine. With no Google or X set up, email and password accounts are on, so
you can sign in right away.

The container listens on `127.0.0.1:8660` only, so a reverse proxy on the same machine can add HTTPS (section 4).
To reach it from other machines without a proxy (testing on a home network), set `HOSTCASTER_BIND=0.0.0.0` in `.env`.

Volumes:

| Volume          | In the container | What                                                             |
| --------------- | ---------------- | ---------------------------------------------------------------- |
| `hostcaster-data`  | `/data`          | `hostcaster.db` (accounts, sync, encrypted keys) and `secret.key`  |
| `MUSIC_PATH`    | `/music` (read only) | your music folder, when `MUSIC_PATH` is set in `.env`        |

## 2. Without Docker

You need Node.js 24 or newer.

```sh
cd app && npm ci && npm run build && cd ..     # builds the web app into app/dist
cd server && npm ci --omit=dev
cp ../.env.example ../.env                     # the server reads .env in server/ or in the repo root
npm start                                      # http://localhost:8660
```

Keep it running with your init system. A systemd unit, for example:

```ini
# /etc/systemd/system/hostcaster.service
[Unit]
Description=Host-Caster
After=network-online.target

[Service]
WorkingDirectory=/opt/hostcaster/server
EnvironmentFile=/opt/hostcaster/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
User=hostcaster

[Install]
WantedBy=multi-user.target
```

## 3. Settings

All settings are environment variables (or lines in `.env`). Only `PUBLIC_URL` matters for most people.

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:8660` | The address people use, for example `https://radio.example.com`. Sign-in callbacks, cookies and AI app URLs are built from it. |
| `PORT`, `HOST` | `8660`, `0.0.0.0` | Where the server listens. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and secret key. |
| `SECRET_KEY` | generated | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts saved keys, OAuth tokens and mailbox passwords. When empty, one is generated into `DATA_DIR/secret.key` on first start. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Google sign-in plus calendar, Gmail and YouTube (section 5). |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | empty | X sign-in (section 6). |
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | empty | People connect their Notion: the hosts read pages they pick and add notes when asked (section 10, Notion). |
| `ALLOW_LOCAL_ACCOUNTS` | on only without Google and X | Email and password accounts. |
| `ALLOW_SIGNUPS` | `true` | `false` stops new accounts; existing ones still sign in. |
| `SESSION_DAYS` | `60` | How long a sign-in lasts without use. Every visit extends it. |
| `SYNC_MAX_ITEMS` | `50000` | Synced songs, playlist lists and unplayable marks per account (song files never sync, only references: YouTube, Spotify, streams, Subsonic, server library). |
| `MUSIC_DIR` | empty | Folder with music for the server library (Docker: set `MUSIC_PATH` instead). |
| `LIBRARY_SCAN_ON_START` | `true` | Look for new and changed songs when the server starts. |
| `ALLOW_PRIVATE_FETCH` | `false` | Let addresses people type in (feeds, their own AI or voice servers) reach private networks. |
| `FETCH_ALLOW` | empty | Allow only some private targets: CIDRs, IPs, host names or `host:port`, comma separated. |
| `COOKIE_SECURE` | on when `PUBLIC_URL` is https | Secure session cookie. |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Which proxies may tell the server the visitor's address (`X-Forwarded-For`): by default one on the same machine or private network, like the Caddy or nginx examples below. A number = that many hops; `true` trusts anyone (only behind a proxy that replaces the header). |
| `CHATGPT_PLAN` | `true` | "Use your ChatGPT plan" brains: each person signs in with their own ChatGPT account, nothing to register. `false` turns it off. A paid or public hosted service needs OpenAI's approval first ([PROVIDERS.md](PROVIDERS.md#subscriptions)). |
| `CHATGPT_CALLBACK_PORT` | `1455` | The port in ChatGPT's sign-in answer address `http://127.0.0.1:<port>/auth/callback` (OpenAI requires `127.0.0.1`). The server listens there while a sign-in is open, so a browser on this same computer finishes by itself; everywhere else people paste the address. Busy port: a free one is used. |
| `CHATGPT_CALLBACK_BIND` | `127.0.0.1` | Where that listener binds. Docker on your own computer: `0.0.0.0`, and publish `127.0.0.1:1455:1455`. |
| `SEARXNG_URL` | empty | Your [SearXNG](https://docs.searxng.org) address, for the hosts' web search. Its JSON format must be on (below). |
| `BRAVE_SEARCH_API_KEY` | empty | A [Brave Search API](https://brave.com/search/api/) key, for the hosts' web search. |
| `TAVILY_API_KEY` | empty | A [Tavily](https://tavily.com) key, for the hosts' web search. |
| `WEB_SEARCH_PROVIDER` | the first one set | `searxng`, `brave`, `tavily` or `off`. Picks one when several are set; `off` turns web search off. None set = the hosts are not offered web search. |
| `AGENT_LOOKUPS_PER_DAY` | `400` | Lookups the hosts may make per account in 24 hours (calendar, mail, Notion, linked pages, web search). |
| `AGENT_WEB_SEARCHES_PER_DAY` | `40` | Web searches per account in 24 hours (part of the lookups above). `0` turns web search off. |
| `ACTIONS_PER_DAY` | `50` | Things the hosts may do in a person's Google account (after their yes) per 24 hours. Past it: `429 actions_limit`. |
| `ACTION_PROPOSALS_PER_DAY` | `200` | Suggestions the hosts may make per account in 24 hours. Past it: `429 proposals_limit`. |
| `SPOTIFY_CLIENT_ID` | empty | A Spotify app id offered to the apps (PKCE, no secret), so people skip that step. See [PROVIDERS.md](PROVIDERS.md#7-spotify-step-by-step). |
| `APP_SCHEME` | `hostcaster` | Deep link scheme of the phone apps. |
| `APP_DIST` | `../app/dist` | Where the built web app is. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. `info` logs every request path and IP (section 12). |
| `HOSTCASTER_BIND`, `HOSTCASTER_PORT` | `127.0.0.1`, `8660` | Docker Compose only: the address and port published on the host. |

Check what the server thinks it has: `curl http://localhost:8660/api/config`.

### Hosts looking things up

Hosts with an AI brain can look things up: the details of an event, related mail, the Notion pages people picked, a
page linked from their day and, when you set it up, the web. Everything except web search works with no settings,
from what each person connected. People see every lookup, and can turn it off, in Settings, What your hosts can see.

Web search needs one of the three providers above. Only the search words are sent to it. With SearXNG, turn on its
JSON output in its `settings.yml`, or every search answers an error:

```yaml
search:
  formats:
    - html
    - json
```

`SEARXNG_URL` is an address you set, so it may be on this machine or your network (it is not held to
`ALLOW_PRIVATE_FETCH`). In Docker, `127.0.0.1` is the Host-Caster container itself: use the machine's LAN address,
or run SearXNG as another service in the same Compose file and use its service name (`http://searxng:8080`). Signed-in people then see a **Search the web** switch under **Hosts can look things up**. Linked
pages are fetched like feeds: private addresses only with `ALLOW_PRIVATE_FETCH` or `FETCH_ALLOW`.

## 4. HTTPS in front

Sign-in providers, the phone apps, browsers' microphone access and AI apps all want **https**. Put a reverse proxy
in front and set `PUBLIC_URL` to its address.

**Caddy** (gets a certificate by itself):

```
radio.example.com {
	reverse_proxy 127.0.0.1:8660
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name radio.example.com;
    ssl_certificate     /etc/letsencrypt/live/radio.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/radio.example.com/privkey.pem;
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8660;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # music streams and Range requests
    }
}
```

**Only for you and your devices**: a private network such as Tailscale works well. `tailscale serve --bg 8660`
gives you `https://<machine>.<tailnet>.ts.net`; use that as `PUBLIC_URL`. Google accepts it as
a redirect address. AI apps (section 10) cannot reach a private network; for them use Tailscale Funnel or a public
domain.

## 5. Google sign-in

Google sign-in also gives the hosts your calendar and unread mail, and the music pages your YouTube playlists. Each
of these is asked for separately, only when someone switches it on (Settings, Connections), and read-only. The two
write permissions (add events and answer invitations, use Google Tasks) are asked for only when someone turns on
**Hosts can add to my calendar** or **Hosts can use my Google Tasks** (Settings, Connections, Google), and the hosts
use them only after that person says yes ([PRIVACY.md](PRIVACY.md#12-your-list-and-things-your-hosts-can-do)).

1. Open [console.cloud.google.com](https://console.cloud.google.com), create a project (for example "Host-Caster").
2. **APIs and services, Library**: enable **Google Calendar API**, **Gmail API**, **Google Tasks API** and
   **YouTube Data API v3** (only the ones you want).
3. **Google Auth Platform** (OAuth consent screen): app name, support email, audience **External**.
4. **Data access**: add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and the ones
   you use: `.../auth/calendar.readonly`, `.../auth/gmail.readonly`, `.../auth/youtube.readonly`, and for the
   hosts' actions `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/tasks`.
5. **Audience**: while the app is in **Testing**, add every Google account that will sign in as a **test user**
   (up to 100). Testing is fine for a family server; Google shows an "unverified app" notice that people click
   through. Publishing to everyone needs Google's verification, and the Gmail scope needs a security assessment.
   Adding the two action scopes later does not touch anyone already signed in: they keep read-only access until
   they turn a switch on, and Google then asks them for just that permission (test users only, while in Testing).
6. **Clients, Create client**: type **Web application**.
   - Authorized JavaScript origin: your `PUBLIC_URL` (for example `https://radio.example.com`).
   - Authorized redirect URI: `PUBLIC_URL` + `/auth/google/callback`.
7. Copy the client id and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, restart.

Host-Caster asks for offline access, so the server can read the calendar when the hosts need it without anyone signing
in again. People can remove access any time in their Google Account (Security, Third-party connections) or in
Host-Caster (Settings, Account, Unlink).

**YouTube quota.** A Google project gets 10,000 YouTube Data API units a day. Importing a playlist costs about 2 units
per 50 videos (it reads up to 5,000 videos, 500 at a time, with progress), so even a 5,000-video liked list costs
about 200. Private, deleted and unavailable videos are left out and the app says how many.

## 6. X sign-in

1. Open [console.x.com](https://console.x.com) (the X developer console), create an app in a project.
2. **User authentication settings**: permissions **Read**, type of app **Web App, Automated App or Bot**
   (a confidential client).
   - Callback URI: `PUBLIC_URL` + `/auth/x/callback`.
   - Website URL: any page about your server.
3. Copy the **OAuth 2.0** client id and secret (not the API key and secret) into `.env` as `X_CLIENT_ID` and
   `X_CLIENT_SECRET`, restart.

Host-Caster uses OAuth 2.0 with PKCE and asks only for `users.read tweet.read`, to know who signed in.

## 7. Email and password accounts

On by default when neither Google nor X is set up; turn them on next to OAuth with `ALLOW_LOCAL_ACCOUNTS=true`.
Passwords are hashed with scrypt. Email addresses are not verified, so Host-Caster never merges a password account
into a Google or X account by email: people link them themselves in Settings, Account.

Close sign-ups once your family has accounts: `ALLOW_SIGNUPS=false`.

## 8. Phone apps and your server

The Android and iOS apps work alone. To use your server:

- In the app: **Settings, Account, Your Host-Caster server**, enter `PUBLIC_URL` (for example
  `https://radio.example.com`), then **Sign in**. The sign-in screen also has **Change server**.
- Google and X sign-in open in the system browser; your server sends the browser back to the app with
  `hostcaster://auth?code=...` (one-time, two minutes), and the app trades it for its own sign-in.
- The phone must reach `PUBLIC_URL`: a public domain, or a private network (Tailscale) the phone is on.
- The web app at `PUBLIC_URL` can be installed too ("Add to Home Screen"); it is the same app.

Every device keeps its own songs. What syncs: hosts, stations, brains and voices (keys stay on the server), profile,
settings and playlist names.

## 9. Music library on the server

Point `MUSIC_DIR` (or `MUSIC_PATH` with Docker) at a folder of MP3, M4A, AAC, FLAC, OGG, OPUS, WAV or WEBM files.
The server reads the tags and cover art, and streams with seeking (HTTP Range) to every signed-in device. New and
changed files are picked up when the server starts (or with `POST /api/library/rescan` from a signed-in session).
Folder images named `cover.jpg` or `folder.jpg` are used when a file has no art. Everyone who has an account on
the server sees this one library.

## 10. AI apps

Settings, Connections, **AI apps**: make a connection and copy its URL (`PUBLIC_URL/mcp/<secret>`). Paste it into
an assistant that supports remote MCP servers (Streamable HTTP, no authentication):

- **ChatGPT**: Settings, Apps and Connectors, Advanced settings, Developer mode; then Create, paste the URL.
- **Claude**: Settings, Connectors, Add custom connector; paste the URL.
- **Grok** and **Meta AI**: where they offer custom connectors or MCP servers; developers can use the URL from their
  APIs as a remote MCP tool.

The assistant can see what is playing, list the hosts, send a note, queue a segment, request a song and add a
birthday or date. Items land in the account's inbox and the hosts use them in the next break. The URL is the key:
delete the connection to cut it off. These apps connect from the internet, so this needs a public https address.

### Notion

With a Notion connection on your server, everyone with an account taps **Connect Notion** in Settings, Connections
and picks pages on Notion's own screen. Their hosts then mention open to-dos and notes from the pages they choose, and
add a to-do or a note when they ask on a call ("add oat milk to my list") or from their AI app. One connection serves
everyone; nobody else needs a key.

1. In Notion open **Settings, Connections, Develop or manage connections** (or
   [app.notion.com/developers/connections](https://app.notion.com/developers/connections)) and create a new
   connection. Type: **Public** (OAuth). Name it, for example Host-Caster; a logo is optional.
2. Capabilities: **Read content**, **Update content** and **Insert content**. Comments: none. User information:
   **No user information**.
3. OAuth redirect URI: `PUBLIC_URL` + `/auth/notion/callback`, for example
   `https://radio.example.com/auth/notion/callback`. Notion takes plain http only for `localhost`.
4. Notion asks a public connection for a website, privacy policy and terms of use: link pages about your server.
5. Copy the **OAuth client ID** and **OAuth client secret** into `.env` as `NOTION_CLIENT_ID` and
   `NOTION_CLIENT_SECRET`, restart.

Without them the Notion card says the server owner has not set Notion up. What the server keeps: each person's Notion
token (encrypted with `SECRET_KEY`), their choices, and the list of what the hosts added (for Undo). Page summaries
stay in memory for 10 minutes. Hosts write at most 30 notes an hour per person, never change or delete people's own
blocks, and Undo moves only the block they added to Notion's trash. Disconnect revokes the token. `NOTION_VERSION`
(default `2026-03-11`) pins Notion's API version.

## 11. Backups, updates and moving

- **Back up** the data volume (Docker: `docker run --rm -v hostcaster_hostcaster-data:/d -v $PWD:/b busybox tar czf
  /b/hostcaster-data.tgz -C /d .`) or `DATA_DIR`. It holds `hostcaster.db` and `secret.key`; keep them together. Without
  the secret key, saved API keys, Google tokens and mailbox passwords cannot be read (people sign in again and
  re-enter keys; hosts and stations are fine).
- Each person can also export a backup file in the app (Settings, Data & storage), with or without songs.
- **Update**: `git pull && docker compose up -d --build` (or rebuild `app/dist`, then restart the server).
- **Move** to a new machine: copy the data volume, set the same `PUBLIC_URL`, start.

## 12. Security notes

- Saved keys, OAuth tokens and mailbox passwords are encrypted with AES-256-GCM using `SECRET_KEY`. Keys are never
  sent back to the apps unless their owner asks to see them.
- Browser sessions are httpOnly cookies (SameSite Lax) and every change needs the `X-HostCaster: 1` header; phone apps
  use bearer tokens. Only a hash of each session token is stored.
- Addresses people type in (feeds, their own AI and voice servers, IMAP hosts) are resolved and checked before the
  server connects, and the connection is pinned to the checked address. Private, loopback and link-local ranges are
  refused unless you allow them (`ALLOW_PRIVATE_FETCH`, `FETCH_ALLOW`); cloud metadata addresses are always refused.
  On a home server where everyone is trusted, `FETCH_ALLOW=192.168.0.0/16` lets people use the AI box on your LAN.
- Deleting an account (Settings, Account) removes everything the server keeps for it and revokes Google and X access.
- At `LOG_LEVEL=info` the log has every request path and IP address. The secret in AI app URLs and one-time
  sign-in codes are logged as `***`; keep logs private anyway (or use `LOG_LEVEL=warn`).

## 13. Troubleshooting

| Problem | Fix |
| --- | --- |
| Google says `redirect_uri_mismatch` | The redirect URI in the Google client must be exactly `PUBLIC_URL/auth/google/callback` (scheme, host, port). |
| Google says "Access blocked: app has not completed verification" | Add the account as a test user (section 5, step 5). |
| Google Tasks never show up in Your list, or "Hosts can add to my calendar" keeps asking to reconnect | Enable the **Google Tasks API** / **Google Calendar API** (section 5, step 2) and add the two action scopes on the Data access page (step 4). |
| X shows "Something went wrong" | Callback URI must match `PUBLIC_URL/auth/x/callback`; use the OAuth 2.0 client id, not the API key. |
| Signed in, but every page says signed out | `PUBLIC_URL` is https while you open it over http (or the other way); open the `PUBLIC_URL` address. |
| A feed or local AI says "blocked address" | It is on a private network; allow it with `FETCH_ALLOW` (section 12). |
| The phone app cannot find the server | Open `PUBLIC_URL/api/health` in the phone's browser; it must answer `{"ok":true,...}`. |
| Server library is empty | Check `MUSIC_DIR` (or `MUSIC_PATH`) and the logs; files need a known audio extension. |

Logs: `docker compose logs -f` or your service manager. Health: `GET /api/health`.
