# Security

This is a small CLI that runs locally on a developer's machine. It writes
files into a chosen project directory, invokes `wget` to mirror a public
website, and (opt-in) drives the Firebase CLI. It does not run as a
server, has no auth surface, and ships no runtime telemetry.

## Reporting a vulnerability

Please email **christian@manolab.com** with details. Include:

- The exact command and flags that trigger the issue
- The version (`w2f --version`) and OS
- A minimal repro if you have one

I'll acknowledge within a few days. If the report is sensitive, mark the
subject `[security]` and I'll keep the discussion off public issues until
there's a fix. Please don't open a public issue for anything you suspect
is exploitable until we've talked.

## Scope

In scope:

- Path-traversal or arbitrary-write bugs in `port` / `convert` / `crawl`
  (e.g. a Weebly mirror containing crafted paths that escape the project
  root)
- Command injection via flags, prompts, or scraped content reaching a
  shell invocation
- The hCaptcha secret handling in the `forms` command (the secret is
  passed via the Firebase CLI's own interactive paste prompt — never via
  argv — and that contract should hold)
- Issues with the scaffolded `functions/index.js` template (hCaptcha
  verification, Firestore writes, redirect handling)

Out of scope:

- Vulnerabilities in `wget`, `firebase-tools`, or Node itself — please
  report those upstream
- Bugs in the user's own Weebly source content
- Anything in the scaffolded project that the user has hand-edited after
  scaffold time
