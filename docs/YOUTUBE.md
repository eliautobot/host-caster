# YouTube on your own server

Host-Caster can play your YouTube playlists, your Liked videos and songs you search for, with your hosts talking in
between. On a server you run yourself this needs your own Google sign-in setup: a free Google Cloud project and an
OAuth client that belongs to you. Nobody else's keys are built in, and your server talks to Google directly.

This page walks through it from start to finish. The short version of the same steps, together with calendar and
Gmail, is in [SELF-HOSTING.md](SELF-HOSTING.md#5-google-sign-in).

## Contents

1. [What you need](#1-what-you-need)
2. [Create the Google Cloud project](#2-create-the-google-cloud-project)
3. [Consent screen and test users](#3-consent-screen-and-test-users)
4. [The OAuth client](#4-the-oauth-client)
5. [Put it in your server settings](#5-put-it-in-your-server-settings)
6. [Connect YouTube in the app](#6-connect-youtube-in-the-app)
7. [Phone apps](#7-phone-apps)
8. [How YouTube plays](#8-how-youtube-plays)
9. [Quota](#9-quota)
10. [Troubleshooting](#10-troubleshooting)

## 1. What you need

- A Host-Caster server reachable at a fixed address with HTTPS, set as `PUBLIC_URL` (for example
  `https://radio.example.com`). Google only sends people back to addresses it knows, and it wants HTTPS for anything
  other than `localhost`. A Tailscale address such as `https://<machine>.<tailnet>.ts.net` works
  ([SELF-HOSTING.md](SELF-HOSTING.md#4-https-in-front)).
- A Google account to own the project. It does not have to be the account you listen with.

## 2. Create the Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project, for example "My radio".
2. **APIs and services, Library**: search for **YouTube Data API v3** and press **Enable**. Turn on **Google
   Calendar API** and **Gmail API** too if you want your hosts to read your calendar and unread mail.

## 3. Consent screen and test users

1. **Google Auth Platform** (the OAuth consent screen): app name (what people see when they sign in), a support email,
   audience **External**.
2. **Data access**: add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and
   `.../auth/youtube.readonly`. Add `.../auth/calendar.readonly` and `.../auth/gmail.readonly` only if you use them.
3. **Audience**: leave the app in **Testing** and add every Google account that will connect YouTube as a **test
   user** (up to 100).

Testing is the right choice for yourself, your family or friends. Google shows an "unverified app" screen once;
people press **Continue**. Publishing the app for anyone with a Google account needs Google's verification for the
YouTube scope (and a paid security assessment for Gmail), which is meant for public services.

Good to know: while an app is in Testing, Google may end its sign-ins after about a week. When that happens,
Host-Caster asks you to allow YouTube access again (Settings, Music services, YouTube Music, **Connect YouTube**).

## 4. The OAuth client

**Google Auth Platform, Clients, Create client**:

- Application type: **Web application**.
- Authorized JavaScript origins: your `PUBLIC_URL`, for example `https://radio.example.com`.
- Authorized redirect URIs: `PUBLIC_URL` + `/auth/google/callback`, for example
  `https://radio.example.com/auth/google/callback`.

Create it and copy the **Client ID** and the **Client secret**.

The same web client serves the browser, the installed web app and the phone apps: the phone apps sign in through your
server, so you do not need an Android or iOS client.

## 5. Put it in your server settings

In `.env` next to `docker-compose.yml` (or the environment of your service):

```sh
PUBLIC_URL=https://radio.example.com
GOOGLE_CLIENT_ID=<the client id>
GOOGLE_CLIENT_SECRET=<the client secret>
```

Restart (`docker compose up -d`). `GET /api/config` on your server now says `"google": true`, and the sign-in
screen offers **Continue with Google**.

Turning Google on also turns off email and password sign-up by default. Keep them both with
`ALLOW_LOCAL_ACCOUNTS=true` ([SELF-HOSTING.md](SELF-HOSTING.md#7-email-and-password-accounts)).

The client secret stays on your server. Google's sign-in tokens are stored encrypted in your server's database
(AES-256-GCM with the server's own key) and are never sent to an app.

## 6. Connect YouTube in the app

1. Sign in to your server (Settings, Account). Google sign-in only asks for your name and email at this point.
2. **Settings, Music services, YouTube Music, Connect YouTube**. Google asks for read-only access to your YouTube
   account; Host-Caster can never post, like or change anything.
3. Import your playlists or your Liked videos, search for a song, or build a station from a playlist.

YouTube Music's own "Liked music" list is not open to other apps, so Host-Caster uses your YouTube Liked videos.
Big lists import in steps with progress (up to 5,000 videos). Private, deleted and unavailable videos are left out and
the app says how many.

Remove access any time: Settings, Account, Unlink, or your Google Account (Security, Third-party connections).

## 7. Phone apps

In the Android or iOS app, set your server first: **Settings, Account, Your Host-Caster server**, enter your
`PUBLIC_URL`, then sign in. Google opens in the system browser and your server sends you back to the app with a
one-time code. The phone must reach your server (a public domain, or Tailscale on the phone).

## 8. How YouTube plays

Songs play in YouTube's own embedded player, as YouTube's terms require. That means:

- The video is shown on Now Playing. In the phone apps it moves into a small window you can drag to a corner while you
  browse, and YouTube pauses when the app goes to the background. Your files, your server's songs, Navidrome and radio
  keep playing in the background as usual.
- Some videos do not allow playback outside YouTube. Host-Caster checks the next songs ahead, skips those, remembers
  them for two weeks and says so.
- YouTube may show ads in its player. With YouTube Premium on the same Google account in that browser, it usually
  does not.
- Your hosts talk over a lowered YouTube volume, like on real radio.

## 9. Quota

A Google project gets 10,000 YouTube Data API units a day for free. Importing costs about 2 units per 50 videos, so
even a 5,000-video Liked list costs about 200. Searching costs 100 units per search. A family server stays far below
the limit. If you ever reach it, imports and searches pause until midnight Pacific Time; songs already imported keep
playing.

## 10. Troubleshooting

- **"redirect_uri_mismatch"**: the redirect URI in the Google client must be exactly `PUBLIC_URL` +
  `/auth/google/callback`, with the same `https`, host name and port, and no slash at the end of `PUBLIC_URL`.
- **"Access blocked: this app has not completed verification"**: the account is not on the test user list (step 3).
- **"YouTube Data API has not been used in project ..."**: enable the YouTube Data API v3 (step 2); it can take a
  few minutes to start working.
- **No Continue with Google**: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are not both set, or the server was not
  restarted. Check `GET /api/config`.
- **The phone app does not come back after sign-in**: the app must be the Host-Caster app with the `hostcaster://`
  link scheme. If you build the app with another scheme, set `APP_SCHEME` on the server to match.
