# Contributing

Thanks for the interest. This is a small, focused CLI — contributions that
make it sharper, less surprising, or more useful for the next person
porting a Weebly site are welcome.

## Ownership and merging

I (@copperdesign) maintain the repo and merge all PRs. You're welcome to
fork, branch, and propose changes — I'll review on my own timeline. No CLA.

## What fits

Yes:

- Bug fixes with a clear repro
- Edge cases in `crawl` / `port` / `convert` you hit on a real site
- Sharper extraction heuristics (Weebly markup variants the current code
  misses or mangles)
- Doc clarifications — especially the WHY of a step that bit you
- Quality-of-life flags on existing commands

Probably no — open an issue first to discuss:

- New top-level commands
- Switching the crawler off `wget`
- Adding runtime dependencies (the tool is intentionally zero-deps; Node
  built-ins plus `wget` is the contract)
- Restructuring `commands/` or `lib/`

Hard no:

- Adding a build step, bundler, or transpile pipeline. The CLI is plain
  `.mjs` shipped as-is.
- Telemetry, analytics, "phone home" of any kind.
- Auto-generated boilerplate PRs (license bumps from bots, dependency
  pings against non-existent deps, mass formatting reflows).

## Getting set up

```bash
git clone https://github.com/copperdesign/weebly-to-firebase.git
cd weebly-to-firebase
npm link           # makes `weebly-to-firebase` and `w2f` available globally
```

Requirements: Node ≥ 18 and `wget` on PATH. No `npm install` step — there
are no runtime dependencies.

Try it against a real Weebly site in a scratch directory:

```bash
mkdir /tmp/w2f-scratch && cd /tmp/w2f-scratch
w2f init --yes \
  --name "Test" \
  --firebase-project test-project \
  --live-domain example.weebly.com
```

## PR workflow

1. Fork and branch off `main`. Branch names are free-form.
2. Keep PRs scoped. One concern per PR; bundle small drive-by cleanups
   into the same diff if they're in the file you're touching, otherwise
   open a separate PR.
3. Write commit messages that explain *why*, not what. Mirror the style
   already in `git log` — short prefix, present-tense subject, body when
   it earns its place.
4. In the PR description: what changed, why, and how you tested. Screenshots
   for anything user-visible (extracted markup before/after, dumped CSS
   diffs).
5. Open the PR against `main`.

## Code style

The repo is plain ES modules (`.mjs`) targeting Node ≥ 18. No transpile.

- **Zero runtime deps.** Node built-ins only. The `postinstall` hook is
  the one exception (auto-installs `wget` on macOS via brew).
- **Small files, one concept per file.** See `lib/` for the shape —
  `args.mjs`, `prompt.mjs`, `target.mjs`, etc. each own one thing.
- **Comment liberally.** Inline comments explain WHY. Surprising
  behavior, edge cases, hidden invariants — write them down. Don't
  narrate the obvious line below.
- **Long, descriptive names** over short clever ones. `computeMirrorRoot`
  beats `cmr`.
- **`async`/`await` over callbacks or stray `.then()` chains.**
- **`node:util.parseArgs` for CLI parsing.** Don't reach for `commander`,
  `yargs`, or anything similar — the contract is zero deps.
- **Idempotent commands.** Everything `init` / `port` / `convert` does
  should be safe to re-run. If you add behavior, make it idempotent or
  gate it behind `--force`.

## Testing

There's no test suite — the tool is exercised against real sites. Before
opening a PR:

1. Run your change against at least one real Weebly site end-to-end
   (`w2f init` → `npm install` → `npm run build` → spot-check the output).
2. Run the affected subcommand twice in a row to confirm idempotency.
3. If you changed `port` or `convert`, run with `--force` and without —
   the marker-gated rewrite path is easy to break silently.

Note what you tested in the PR description.

## Reporting bugs

Open an issue with:

- The live Weebly domain (if public) or a minimal repro you can share
- The exact command you ran
- What you expected vs. what happened
- The version (`w2f --version`) and your OS

Screenshots / mirror snippets help a lot for extraction bugs.

## Asking questions

Issues are fine for questions too — tag them `question`. Don't email me
directly with usage questions; an issue helps the next person.
