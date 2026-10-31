# Contributing to Host-Caster

Thanks for helping. Bug reports, fixes, new provider presets, translations of the docs and screenshots of things that
look wrong on your phone are all welcome.

## Before you start

- Read [ARCHITECTURE.md](ARCHITECTURE.md). It is the contract between the modules; change it in the same pull
  request as the code that depends on it.
- For a bigger change, open an issue or a discussion first so we can agree on the shape.
- Read the [contributor license agreement](#contributor-license-agreement) below. Opening a pull request means you
  agree to it.

## Set up

You need Node.js 24 or newer.

```sh
cd server && npm ci && npm run dev    # http://localhost:8660
cd app && npm ci && npm run dev       # http://localhost:5173
```

## Before you open a pull request

```sh
cd app && npm run typecheck && npm test && npm run build
cd server && npm test
```

All of them must pass. If you changed a screen, check it at phone size (390 x 844) and desktop size (1440 x 900),
in the dark and the light theme, and add a screenshot to the pull request.

## How the code is written

- Small files (under about 400 lines), named exports, no default exports except React screens.
- `app/src/core` has no React. Logic lives there; `app/src/state` stays thin; `app/src/ui` is presentation.
- No `any` without a comment saying why.
- Use the design system (`app/src/ui/tokens.css`, `app/src/ui/components`). Neutral greys with one orange signal
  colour, used sparingly. No purple.
- The database schema (`app/src/core/db/schema.ts`) only grows: add a new `version()` block, never edit a shipped
  one. Server migrations in `server/src/db.js` work the same way.
- Everything must work with no account and no internet. Every call to the server handles `api.available === false`.
- No hardcoded hosts, keys, addresses or personal data. Anything a self-hoster might change is a setting or an
  environment variable (documented in `.env.example`).
- New AI brain or voice presets go in `app/src/core/ai/presets.ts` and `app/src/core/voice/presets.ts`, and in
  [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Writing

Docs and app text use plain, short, friendly sentences. Say what the person can do, not how the code works.

## Security

Please do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## How changes reach a release

Host-Caster is developed in the project owner's own repository, and each release is published here as one commit.
Accepted pull requests are brought into that repository and appear here with the next release, credited to you in
the release notes (and in the pull request). That is also why the agreement below is needed: the same code runs the
hosted version at host-caster.com.

## Contributor license agreement

This agreement is between you and the Host-Caster project owner (today the person who runs the project; once it is
formed, My Virtual Industries LLC, which will then take the owner's place in this agreement). By opening a pull request,
or otherwise submitting code, documentation, images or other material ("your contribution") to Host-Caster, you agree
to the following.

1. **You keep your copyright.** You still own your contribution and may use it however you like.
2. **License to the project owner.** You grant the project owner, and anyone who receives Host-Caster from the project
   owner, a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable license to use, copy, modify,
   publish, distribute, sublicense and sell your contribution and works based on it, under any license terms,
   including licenses other than the AGPL-3.0 and proprietary licenses. This lets the project owner relicense
   Host-Caster in the future and use your contribution in the hosted version at host-caster.com and in the app stores.
3. **Patents.** You grant the project owner and everyone who receives Host-Caster a perpetual, worldwide,
   non-exclusive, no-charge, royalty-free, irrevocable patent license for any patent claims you can license that your
   contribution alone, or combined with Host-Caster, would infringe. If anyone sues claiming that Host-Caster or a
   contribution infringes a patent, the patent licenses they received under this agreement end on the date of filing.
4. **It is yours to give.** Your contribution is your own original work, or you have the right to submit it under
   these terms (for example, your employer agreed). If it includes someone else's work, you say so in the pull request
   with its license, and that license allows these terms.
5. **No obligation.** The project owner does not have to use your contribution. It is given as is, without warranty
   of any kind.
6. **Public record.** You agree that your contribution and your name or user name as its author may be kept public in
   this repository's history and release notes.
7. **Successors.** The project owner may transfer the rights in this agreement to a successor, such as My Virtual
   Industries LLC once it is formed, or to whoever takes over the project. The agreement then binds them in the same
   way.

Your contribution is also released to everyone under the [AGPL-3.0](LICENSE), like the rest of this repository.

Questions about the agreement: [support@host-caster.com](mailto:support@host-caster.com).
