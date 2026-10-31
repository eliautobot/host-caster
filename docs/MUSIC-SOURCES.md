# Music sources for self-hosters

Host-Caster plays music from many places and mixes them in one station. This page is for people who run their own
server: what each source needs on the server side. How to use each one in the app is in
[PROVIDERS.md](PROVIDERS.md#6-music-sources).

| Source | Server needed? | What you set up |
| --- | --- | --- |
| [Your files](#your-files) | no | nothing |
| [Server library](#server-library) | yes | `MUSIC_DIR` (Docker: `MUSIC_PATH`) |
| [Subsonic and Navidrome](#subsonic-and-navidrome) | no (your music server) | a Subsonic-compatible server |
| [Internet radio](#internet-radio) | no | nothing |
| [YouTube](#youtube) | yes | your own Google OAuth client |
| [Spotify](#spotify) | no | your own Spotify developer app (optional `SPOTIFY_CLIENT_ID`) |
| [Any music app](#any-music-app-android) | no | the Android app and notification access |

## Your files

Songs added in the app (Library, Add music) are stored inside the app on that device and never uploaded, also when
you are signed in. Every device keeps its own files. Playlists sync between your devices; a file that is only on
another device keeps its place in the list and the playlist says how many songs are elsewhere.

## Server library

Point the server at a music folder and every signed-in device can stream it, with seeking and covers.

- Docker: set `MUSIC_PATH=/path/to/your/music` in `.env`. It is mounted read-only.
- Without Docker: set `MUSIC_DIR=/path/to/your/music`.

The server scans the folder at start (new and changed files only; `LIBRARY_SCAN_ON_START=false` turns that off). To
pick up new songs without a restart, call `POST /api/library/rescan` from a signed-in session. Every account on the
server shares this library. Details:
[SELF-HOSTING.md](SELF-HOSTING.md#9-music-library-on-the-server).

## Subsonic and Navidrome

Already running [Navidrome](https://www.navidrome.org), Airsonic-Advanced, Gonic or another Subsonic-compatible
server? Connect it in the app (Settings, Music services, Your music server). Songs stream straight from that server
to the device; Host-Caster keeps only the song list and covers, and a salted token instead of your password.

Starting fresh, Navidrome next to Host-Caster in the same `docker-compose.yml`:

```yaml
  navidrome:
    image: deluan/navidrome:latest
    restart: unless-stopped
    ports:
      - "4533:4533"
    volumes:
      - navidrome-data:/data
      - /path/to/your/music:/music:ro
```

(add `navidrome-data:` under `volumes:` at the end). Open port 4533, create the first user, then connect it in
Host-Caster with that address. For the web app over https, give Navidrome an https address too (the same reverse
proxy works); the phone apps connect to plain http on your network as well.

## Internet radio

Nothing to set up: the app searches the free [radio-browser.info](https://www.radio-browser.info) directory directly,
and any stream address works. Live streams have no song ends, so the hosts break in on a timer.

## YouTube

Needs your server with your own Google OAuth client and the YouTube Data API v3. Step by step:
[YOUTUBE.md](YOUTUBE.md). Music plays in YouTube's own player, which stays visible while it plays.

## Spotify

Spotify only plays for **Premium** accounts and needs a free Spotify developer app of your own (about five minutes):
[PROVIDERS.md](PROVIDERS.md#7-spotify-step-by-step). Put its Client ID in the server's `.env` as `SPOTIFY_CLIENT_ID`
so the people on your server do not have to paste it. Add each listener under User management in the Spotify
dashboard (new apps allow up to 5 people).

## Any music app (Android)

The Android app can let your hosts talk between the songs of another music app (YouTube Music, Apple Music, a podcast
player). Nothing to set up on the server: [PROVIDERS.md](PROVIDERS.md#8-any-music-app-mode-android).

## Not possible

Apple Music, Amazon Music, Tidal, Deezer, SoundCloud, Pandora and Qobuz have no open way for other apps to play their
music. On Android, Any music app mode is the way to use them with your hosts.
