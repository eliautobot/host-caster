# Your ChatGPT plan as the hosts' brain

If you pay for ChatGPT (Plus, Pro or another paid plan), your hosts can think with it: no API key, no extra bill.
This is OpenAI's "Sign in with ChatGPT", which OpenAI allows for open-source and self-hosted apps like Host-Caster.

## Contents

1. [What you need](#1-what-you-need)
2. [Connect it](#2-connect-it)
3. [The 127.0.0.1 page (other devices)](#3-the-127001-page-other-devices)
4. [Server settings and Docker](#4-server-settings-and-docker)
5. [Limits](#5-limits)
6. [Privacy](#6-privacy)
7. [Running a server for other people](#7-running-a-server-for-other-people)
8. [Troubleshooting](#8-troubleshooting)

## 1. What you need

- A paid ChatGPT plan.
- A Host-Caster server you are signed in to (Settings, Account). The server keeps the ChatGPT sign-in, encrypted, so it
  works on every device you sign in on. It never sits in the browser or on the phone. Without a server, use an API key
  or a local model instead ([PROVIDERS.md](PROVIDERS.md#1-brains)).

## 2. Connect it

1. **Settings, Brains, Continue with ChatGPT** (the welcome screen offers it too).
2. A ChatGPT page opens. Sign in and allow Host-Caster to use your plan.
3. In the Android app, and in a browser on the computer that runs your server, this finishes by itself.
4. Pick a model (the list comes from your ChatGPT account), press **Test**, then **Save**.
5. Give your hosts this brain (Hosts, pick a host, Brain). The first brain you add goes to every host that has none.

## 3. The 127.0.0.1 page (other devices)

OpenAI only sends the sign-in answer to `http://127.0.0.1:1455/auth/callback`, and `127.0.0.1` always means "the
device this browser runs on". On a laptop or phone browser that is not the server, the ChatGPT tab therefore ends on a
page that cannot be reached. That is expected:

1. Copy the whole address of that page (it starts with `http://127.0.0.1`).
2. Paste it into Host-Caster and press **Connect**.

The answer works once and only for the sign-in that asked for it.

## 4. Server settings and Docker

| Setting | Default | What it does |
| --- | --- | --- |
| `CHATGPT_PLAN` | `true` | `false` hides the option for everyone on this server. |
| `CHATGPT_CALLBACK_PORT` | `1455` | The port in the answer address. Keep 1455 unless something else uses it. |
| `CHATGPT_CALLBACK_BIND` | `127.0.0.1` | Where the server listens for the answer while a sign-in is open. |

The server listens on that port only while a sign-in is open, and only answers requests addressed to
`127.0.0.1:<port>`.

**Docker on the computer you browse from**: let the answer reach the container. In `.env`:

```sh
CHATGPT_CALLBACK_BIND=0.0.0.0
```

and publish the port to this computer only, in `docker-compose.yml` under `ports:`:

```yaml
      - "127.0.0.1:1455:1455"
```

Then a browser on that computer finishes the sign-in by itself. Everywhere else, use the paste step above; nothing
needs to be published for it.

## 5. Limits

- Breaks count toward your plan's usage limits, which are shared with your other ChatGPT apps. On Plus there is a
  limit every five hours. See and manage usage at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
- When a limit is reached, or the sign-in expires or is removed, the scripted fallback fills in and Home says why,
  with a **Manage usage** link when that is the fix. The music never goes quiet.
- Everyone on a shared server connects their own ChatGPT account. One person's plan is never used for another
  person's breaks.

## 6. Privacy

Each break is one request to OpenAI on your ChatGPT account, with "do not store" set. The server sends OpenAI a random
id for itself, never your name or email. Host-Caster gets no access to your ChatGPT chats. **Disconnect** (Settings,
Brains) ends the sign-in at OpenAI; you can also remove Host-Caster in ChatGPT's settings. More in
[PRIVACY.md](PRIVACY.md).

## 7. Running a server for other people

Your own server, for yourself, your family or friends, needs nothing extra. A paid or publicly hosted service for
other people needs OpenAI's approval first:
[openai.com/form/sign-in-with-chatgpt-interest](https://openai.com/form/sign-in-with-chatgpt-interest/). Until then,
turn the option off with `CHATGPT_PLAN=false`.

## 8. Troubleshooting

- **No Continue with ChatGPT**: you are not signed in to a server, or the server has `CHATGPT_PLAN=false`.
- **The tab ends on "This site can't be reached"**: use the paste step in section 3.
- **"Your ChatGPT sign-in expired or was removed"**: connect again with Continue with ChatGPT.
- **"This ChatGPT account or workspace cannot use its plan in other apps"**: some plans and workspaces turn this off.
  Use an API key brain or a local model instead.
- **"ChatGPT plan use is off for Host-Caster"**: it was turned off in ChatGPT's own settings; turn it on again there.
