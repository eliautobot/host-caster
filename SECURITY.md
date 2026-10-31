# Security

Thank you for helping keep Host-Caster and the people who use it safe.

## Reporting a vulnerability

Email **support@host-caster.com** with "Security" in the subject, or use GitHub's private vulnerability reporting
(**Security, Report a vulnerability**) on this repository. Please include:

- what you found and where (a route, a file and line, or an app screen),
- the steps to reproduce it, and what an attacker could do with it,
- the version or commit you tested, and whether it was a self-hosted server, the phone apps or the hosted service at
  host-caster.com.

Please do not open a public issue for a vulnerability, and do not include other people's data in your report.

What happens next:

- We confirm we received it within 3 working days.
- We tell you what we found and our plan within 10 working days.
- We fix serious problems as fast as we can and tell you when the fix is out. If you like, we thank you by name in the
  release notes.

## Testing rules

Self-hosted servers belong to the people who run them: test your own. You may test the hosted service only with
accounts you own. Please do not:

- read, change or delete other people's data,
- run denial of service tests, send spam, or create large numbers of accounts,
- abuse plans or included AI to run up costs, or make payments with cards that are not yours,
- use social engineering against the team or users.

If you act in good faith and follow these rules, we will not take legal action against you for your research.

## Supported versions

Security fixes go into the newest release. If you run your own server, update to the newest release
([docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#11-backups-updates-and-moving)).

## How Host-Caster protects you

- API keys, sign-in tokens and mailbox passwords are encrypted on the server (AES-256-GCM) and are never sent back to an
  app in full.
- Songs you add stay on your devices.
- Sign-in cookies are `HttpOnly` (and `Secure` over HTTPS); changes made with a cookie need the app's own request
  header, and sign-ins are tied to the browser or phone app that started them.
- Addresses people type in (feeds, their own AI or voice servers) cannot reach your private network or cloud metadata
  unless you allow it (`ALLOW_PRIVATE_FETCH`, `FETCH_ALLOW`).
- Deleting an account deletes what the server stores for it.

More for people who run a server: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#12-security-notes).
