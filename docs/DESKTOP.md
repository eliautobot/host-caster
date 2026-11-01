# Host-Caster for Windows, Mac and Linux

The desktop app is the same Host-Caster as [app.host-caster.com](https://app.host-caster.com): you sign in to the same
account, your hosts, stations, songs and plan sync with the web and your phone, and the plans with Host-Caster AI and
voices work the same. On top of that it does two things a web page cannot:

- **Use your ChatGPT plan** as your hosts' brain (Sign in with ChatGPT). Off unless you turn it on, see below.
- **AI and voices on your computer or home network**: Ollama, LM Studio, Kokoro and any other OpenAI-compatible model
  or voice at a plain `http://` address. A web page served over https may not call them; the desktop app can.

Everything else (stations, hosts, the radio, songs from this computer, YouTube, internet radio) is the web app.

## Download and open it

Get it from the Download page, [host-caster.com/download](https://host-caster.com/download/#desktop), or from the
Releases page of Host-Caster's GitHub repository (every file, with its SHA-256 in `SHA256SUMS.txt`).

The builds are not signed yet, so Windows and macOS ask once before they open it. That is expected for a new app from
a small developer; the steps below are the safe way through.

### Windows (10 and 11)

1. Download `Host-Caster-Setup-<version>-x64.exe`.
2. Open it. If you see **"Windows protected your PC"**, click **More info**, then **Run anyway**.
3. Pick where to install (or keep the suggestion) and finish. Host-Caster is in the Start menu and on the desktop.

If your browser says the file "is not commonly downloaded", open the browser's download list, choose the three dots
next to the file and pick **Keep** (Edge: **Keep anyway**).

No install: `Host-Caster-<version>-win-x64.zip` is the same app to unzip anywhere; open `Host-Caster.exe` inside (the
same "Windows protected your PC" steps apply).

### macOS (12 Monterey and later, Apple silicon and Intel)

1. Download `Host-Caster-<version>-mac-universal.dmg`, open it and drag **Host-Caster** into **Applications**.
2. Open Host-Caster from Applications. macOS says it "cannot be opened because Apple cannot check it for malicious
   software" (newer versions: "could not verify"), because it is not notarized by Apple yet. Click **Done** (or **OK**).
3. Open **System Settings**, **Privacy & Security**. Scroll down to the message about Host-Caster and click
   **Open Anyway**, then confirm with your password and click **Open**.
   - On macOS 14 and earlier you can instead Control-click (or right-click) Host-Caster in Applications, choose
     **Open**, then **Open** again.
4. From then on it opens normally.

If macOS says the app "is damaged and can't be opened", the download was quarantined in a way Settings cannot clear.
Open **Terminal** and run `xattr -dr com.apple.quarantine /Applications/Host-Caster.app`, then open it again.

### Linux (64-bit)

- **AppImage** (any distribution): download `Host-Caster-<version>-linux-x86_64.AppImage`, make it executable
  (Files: Properties, Permissions, "Allow executing file as program", or `chmod +x Host-Caster-*.AppImage`) and open it.
  Ubuntu 22.04 and later need FUSE 2 for AppImages: `sudo apt install libfuse2t64` (22.04: `libfuse2`). Without it,
  start it with `--appimage-extract-and-run`. The first start adds a hidden menu entry so `hostcaster://` sign-in
  links come back to it.
- **Debian, Ubuntu, Mint** (.deb): double-click it and choose Install in the software center, or
  `sudo apt install ./Host-Caster-<version>-linux-amd64.deb`. Host-Caster is in the app menu; updates are a new .deb
  installed the same way.

## Signing in

Choose **Continue with Google**, **Continue with X** or **Continue with Apple**: your normal browser opens, you sign in
there, and the browser hands you back to Host-Caster (it may ask "Open Host-Caster?": allow it). Or choose
**Continue with email** and type the code from the email right in the app. Plans bought on the website work here, and
the plan page here opens Stripe in your browser and comes back the same way.

Pointing the app at your own Host-Caster server: Settings, Account, Server.

**Notion** (Settings, Connections) works the same way: Connect Notion opens Notion in your browser, you pick the pages
there, and the browser hands you back to Host-Caster with a `hostcaster://notion` link. The Talk mix (each station) and
What your hosts can see (Settings) are the same as on the web.

## Playing

- Music keeps playing when the window is minimized or hidden. Closing the window quits the app (on a Mac it keeps
  playing until you choose Quit, like Music).
- **YouTube songs play only while Host-Caster is on screen**, with the YouTube player visible (YouTube's rules for
  apps). When the window is minimized or hidden the YouTube song pauses and songs that may play in the background go
  first; when the window is back, YouTube plays on.
- Media keys and the system's media controls (Windows media overlay, macOS Now Playing, Linux MPRIS) control
  Host-Caster.

## Use your ChatGPT plan (off by default)

**Settings, Desktop app, "ChatGPT plan brains on this computer".** Then Settings, Brains, Add a brain, **Use your
ChatGPT plan**, **Continue with ChatGPT**: your browser opens ChatGPT, you allow Host-Caster to use your plan, and the
browser comes back to Host-Caster on this computer. Pick a model, Test, Save, and give your hosts that brain.

- The ChatGPT sign-in is kept **only on this computer**, locked with the system keychain (Keychain on macOS, Windows
  data protection, the Secret Service keyring on Linux; without a keyring Linux gets basic protection in a file only you
  can read, and Settings says so). It never goes to Host-Caster's servers, and the web and phone apps cannot use it.
- Usage counts against your ChatGPT plan's limits; Host-Caster does not charge for it.

**Why it is off by default.** OpenAI's Sign in with ChatGPT lets open-source apps that run locally use a person's
ChatGPT plan without approval, and asks paid or remotely hosted apps to apply first. Host-Caster's desktop app is open
source (AGPL-3.0) and runs the ChatGPT part entirely on your computer, but it comes from the same owner as a paid
hosted service, and OpenAI does not say how that case counts. Until OpenAI confirms it (through its interest form,
https://openai.com/form/sign-in-with-chatgpt-interest/), the option is fully built and yours to turn on. What OpenAI
publishes (checked 2026-10-31):

- "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it
  in a paid or remotely hosted app, complete the interest form."
  https://developers.openai.com/siwc/token-sharing-open-source
- "If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users."
  https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- "If you're a commercial partner interested in integrating Sign in with ChatGPT, with or without token sharing,
  please complete this interest form." https://help.openai.com/en/articles/20001542
- Tokens: "Keep access, refresh, and retained ID tokens in protected local or self-hosted runtime storage. Keep tokens
  out of browser storage..." https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- Callback: an `http://127.0.0.1:<port>/auth/callback` loopback ("Do not substitute with localhost").
  https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- OpenAI's DevKit (`@siwc/local`, `@siwc/react`) is under a noncommercial license, so Host-Caster implements the
  protocol from the docs instead. https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/LICENSE

How the app follows those rules: it registers itself as "Host-Caster" with dynamic client registration, keeps one
stable opaque agent host id per installation, uses a 127.0.0.1 callback on this computer, keeps tokens out of the page
(the main process holds them, sealed by the keychain), and calls the public Responses API directly from this computer.

## AI and voices on your computer or network

Add them in Settings, Brains and Settings, Voices with their address, for example `http://localhost:11434/v1` for
Ollama, `http://localhost:1234/v1` for LM Studio, `http://localhost:8880/v1` for Kokoro, or the address of another
computer on your network. They work while this computer can reach them; they sync to your other devices as entries,
and there they work only if that device can reach the same address.

## Updates

Host-Caster looks for a new version at start and every 6 hours (Settings, Desktop app can turn that off or check now).
When there is one it says "A new version is ready" (the same card as the Android download) with a **Download** button
that opens the Download page in your browser, with the file for each system and the first-open steps; install it over
the old version, your stations and sign-in stay. **Later** hides that version for 3 days. It never installs anything
by itself.

## Privacy and security

- The page runs sandboxed with context isolation: no Node.js, one fixed bridge (`window.hostcasterDesktop`).
  Navigation outside the app opens in your browser; only `http`, `https` and `mailto` links leave the app. Scripts
  load only from the app itself and the YouTube and Spotify players (Content-Security-Policy).
- The **local helper** listens on `127.0.0.1` only, on a random port, and answers only requests that carry a secret
  made at every launch, come from the app's own page (or no page) and name the exact `127.0.0.1:<port>` host (no DNS
  rebinding). It runs the ChatGPT plan and carries the app's own brain and voice calls; nothing else.
- Data folder: Windows `%APPDATA%\Host-Caster`, macOS `~/Library/Application Support/Host-Caster`, Linux
  `~/.config/Host-Caster`. It holds the app's database (your library, stations, account session), `chatgpt.json`
  (the ChatGPT registration and the keychain-sealed token set, mode 600), `chatgpt-host.json` (the agent host id),
  `desktop-settings.json` and `logs/desktop.log` (no tokens or personal data).
- YouTube's player gets `Referer: https://com.hostcaster.app/`, the app's identity, as YouTube requires of desktop apps
  (YouTube API Services, Required Minimum Functionality, "API Client Identity").

## For developers

Layout: `desktop/main/` (Electron main process, `preload.cjs`, `helper/` = the local helper), `desktop/scripts/`,
`desktop/e2e/`, `desktop/test/`, `desktop/build/` (icons, macOS entitlements), `desktop/electron-builder.config.cjs`.
The web app's desktop hooks are in `app/src/core/native/desktop.ts` (bridge, `helperFetch`, `desktopFetch`),
`app/src/core/api/helper.ts`, `app/src/state/desktop.ts` and `app/src/ui/screens/settings/Desktop.tsx`.

```bash
cd app && npm ci && cd ../desktop && npm ci
node node_modules/electron/install.js     # npm 11 may skip Electron's download; this fetches it
scripts/build-app.sh                      # web app -> .build/app-dist, then .build/stage
npm start                                 # run it (HOSTCASTER_SERVER=http://127.0.0.1:8660 for a local server)
npm test                                  # helper + update logic (node --test)
npm run dist:linux                        # .build/out: AppImage + .deb
npm run dist:win                          # NSIS installer + portable zip (needs Windows, or Wine on Linux)
npm run dist:mac                          # universal .dmg (needs a Mac)
HC_EXE=.build/out/linux-unpacked/host-caster HC_E2E=e2e/smoke.mjs e2e/run-xvfb.sh   # launch smoke test (any packaged build)
npm run manifest -- --dir .build/out --base https://example.com/download/desktop --notes "What changed"
```

`e2e/smoke.mjs` starts a packaged app (`HC_EXE`) against this repo's own server on 127.0.0.1 and checks the window,
the bridge, the helper guard, the sign-in screen, Settings > Desktop app and the update check; CI runs it on every
system (on Windows and macOS with plain `node e2e/smoke.mjs`, on Linux under `xvfb-run`). `e2e/run-xvfb.sh` gives it a
virtual screen and a private D-Bus so it never touches the keyring of the person logged in.

Build-time defaults for a fork (written into the app by `scripts/stage.mjs`): `HOSTCASTER_SERVER` (default
`https://app.host-caster.com`), `HOSTCASTER_SITE` (`https://host-caster.com`), `HOSTCASTER_UPDATE_URL`
(`<site>/download/desktop/latest.json`). The same names in the running app's environment win (tests use them, plus
`HOSTCASTER_USER_DATA`, `HOSTCASTER_NO_PROTOCOL=1`, `HOSTCASTER_PASSWORD_STORE=basic` and `HOSTCASTER_CHATGPT_ISSUER`,
`HOSTCASTER_CHATGPT_API_BASE`, `HOSTCASTER_CHATGPT_CALLBACK_PORT` for the fake OpenAI).

**Release manifest** (`latest.json` at `<site>/download/desktop/latest.json`, what the update check reads):

```json
{ "version": "0.1.2", "versionCode": 10200, "released": "2026-11-01", "notes": ["..."], "minimumSupported": 10200,
  "page": "https://host-caster.com/download/#desktop",
  "files": { "windows-x64": { "url": "...", "sha256": "...", "size": 0, "name": "..." }, "windows-x64-zip": {},
             "mac-universal": {}, "linux-x64-appimage": {}, "linux-x64-deb": {} } }
```

`versionCode` uses the Android scheme (MAJOR*1e6 + MINOR*1e4 + PATCH*100 + BUILD) from `app/package.json`'s version.
Below `minimumSupported` the notice cannot be put off. The app picks its own file by key (`windows-x64`,
`mac-universal`, `linux-x64-appimage` when it runs as an AppImage, else `linux-x64-deb`) for the size it shows; Download
opens `page`. `scripts/manifest.mjs` writes this file from a folder of builds (for your own download host).

**CI** (`.github/workflows/desktop.yml`, a reusable workflow): the helper tests, then Linux, Windows and macOS builds on
their own runners, each followed by the launch smoke test of the packaged app (Windows: the installer run silently,
then the portable zip; macOS: the dmg mounted, signature and both architectures checked; Linux: the AppImage, then the
.deb installed with apt). It runs on pull requests that touch `desktop/`, by hand, and from `release.yml` on a `v*`
tag, which attaches the installers to that tag's GitHub Release next to the web zip and APKs, with `SHA256SUMS.txt`.
Later, signed builds can move to `electron-updater` with GitHub Releases: add electron-builder's `publish` (github) and
run with `HOSTCASTER_AUTO_UPDATE=github` (hook in `desktop/main/updates.js`).

**Signing (owner, later):**

- Windows: a code signing certificate (OV or EV, or Azure Trusted Signing). Repository secrets `WIN_CSC_LINK`
  (base64 .pfx) and `WIN_CSC_KEY_PASSWORD`; SmartScreen warnings fade as the signed app gains reputation (EV at once).
- macOS: an Apple Developer Program membership (organization, after the LLC and D-U-N-S), a "Developer ID
  Application" certificate as `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`, and notarization with `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. With those the Gatekeeper steps above go away.
- Linux needs no signing; publish the SHA-256 from `latest.json` next to the downloads.
