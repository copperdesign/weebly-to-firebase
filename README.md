# weebly-to-firebase

CLI to scaffold a Firebase Hosting project from a live Weebly site. The
crawled mirror (`wget`) is the source of truth: HTML, CSS, images and fonts
are pulled from it directly. An unzipped Weebly theme export is an
**optional overlay** — drop one into `reference/WeeblyExport/` to upgrade
the dumped CSS/JS with cleaner authored source (un-minified LESS, individual
JS modules). Zero deps (Node built-ins only; `wget` for the crawler).

## Install

```bash
git clone https://github.com/copperdesign/weebly-to-firebase.git
cd weebly-to-firebase
npm link          # one-time — makes `weebly-to-firebase` and `w2f` available globally
```

Or invoke directly without linking:

```bash
node /path/to/weebly-to-firebase/cli.mjs [command] [options]
```

## Quick start

From an empty project folder:

```bash
weebly-to-firebase            # interactive — prompts for everything
```

…or fully non-interactive:

```bash
w2f init --yes \
  --name "My Site" \
  --firebase-project my-site-web \
  --hosting-site my-site \
  --live-domain example.weebly.com \
  --github-repo your-org/my-site \
  --setup-firebase   # create the Firebase project + hosting site via CLI
```

`weebly-to-firebase` and `w2f` are the same binary — `w2f` is just the short
alias. Examples below use whichever reads more clearly in context.

## Typical workflow

```bash
w2f                  # 1. scaffold + crawl + port-all (one command, end to end)
npm install          # 2. inside the scaffolded project
npm run build        # 3. posthtml + less + js → public/
npm run deploy       # 4. firebase hosting
```

After confirming the config at the "Proceed?" prompt, the wizard runs the
whole pipeline automatically: scaffold → wget mirror (sitemap-seeded) →
port every page + dump CSS/fonts/images → optional WeeblyExport overlay
(only if `reference/WeeblyExport/` has content) → git init + initial
commit. Opt out per step with `--skip-crawl`, `--skip-port`,
`--skip-convert`, `--skip-git`.

For re-runs / iteration:

```bash
w2f crawl            # refresh the wget mirror
w2f port --all       # re-port every page in the mirror
w2f port kontakt     # re-extract a single page (faster iteration on cleanup)
w2f convert          # overlay a Weebly theme export dropped in later
```

Between build and deploy, clean up by hand in `src/html/` and `src/less/` —
`port` is a starter, not a finished port (see [port options](#port-options)).

**`convert` is optional.** Without a WeeblyExport, `port` alone produces a
buildable project: dumped `src/less/_w2f-*.less` files cover the styles,
fonts land in `src/less/_fonts.less`, and images go to `public/assets/gfx/`.
With a WeeblyExport present, `convert` overlays structured source files
(`variables.less`, `_global.less`, individual JS modules) that override the
dump rule-by-rule — progressively replace the `_w2f-*` files as you migrate.

## Commands

```
weebly-to-firebase [command] [options]

Commands:
  init       Scaffold project (default if no command given)
  convert    Migrate WeeblyExport assets into src/{less,js,html}
  crawl      Mirror the live Weebly site into reference/
  port       First-pass extract from crawled mirror → src/html/ + public/assets/img/
  forms      Finalize the contact-form handler scaffolded by `port`
             (npm install + sitekey + HCAPTCHA_SECRET)
  help [cmd] Show help (or help for a specific command)
  version    Print version
```

Run `weebly-to-firebase help <command>` for command-specific options.

### Global options

| flag | meaning |
| --- | --- |
| `--target <path>` | Project root (default: `process.cwd()`) |
| `-y, --yes`       | Accept all defaults; skip confirmations |
| `-h, --help`      | Show help |
| `-v, --version`   | Print version |

### `init` options

| flag | meaning |
| --- | --- |
| `--name <string>`           | Project display name |
| `--slug <string>`           | npm package slug |
| `--description <string>`    | One-line description |
| `--firebase-project <id>`   | Firebase project ID *(required)* |
| `--hosting-site <name>`     | `firebase.json` `hosting.site` |
| `--live-domain <domain>`    | Live Weebly domain (for mirror) |
| `--github-repo <owner/name>`| GitHub repo for the scaffolded project |
| `--setup-firebase`          | Create Firebase project + hosting site via CLI (requires `firebase login`) |
| `--skip-crawl`              | Don't run the live-site crawl (primary source) |
| `--skip-port`               | Don't auto-port pages after crawl |
| `--skip-convert`            | Don't offer the WeeblyExport overlay step |
| `--skip-git`                | Don't init git |

### `convert` options

| flag | meaning |
| --- | --- |
| `--skip-styles` | Skip copying LESS |
| `--skip-js`     | Skip copying JS |
| `--skip-html`   | Skip generating `.html` partial/page skeletons |

### `crawl` options

| flag | meaning |
| --- | --- |
| `--domain <domain>` | Domain to mirror (overrides cached config) |

`crawl` also accepts a positional: `weebly-to-firebase crawl example.com`.

The crawl is **seeded from `/sitemap.xml`** when reachable. Weebly's
navigation is JS-rendered, so a recursive walk from the homepage alone
typically misses most pages — feeding the sitemap's `<loc>` entries to
wget as seeds catches them. Both bare and `www.` variants are accepted
as in-scope so mixed internal links don't get dropped. wget prints the
number of HTML files at the mirror root when it finishes so under-counts
are visible immediately.

### `port` options

| flag | meaning |
| --- | --- |
| `--domain <domain>` | Override the cached `liveDomain` (which mirror to read from) |
| `--all`             | Port every `.html` file in the mirror; scaffold skeletons for unknown pages |
| `--force`           | Replace partials and page main slot even if hand-edited |

`port` also accepts a positional page name (default `index`):
`weebly-to-firebase port kontakt`.

With `--all`, the partials/global setup runs once against the index page,
then every other `.html` file at the mirror root is ported in turn. Pages
not already in `src/html/` (i.e. anything beyond convert's fixed list of
`index`/`404`/`impressum`/`datenschutz`/`kontakt`) get a skeleton scaffolded
automatically before their `<main>` block is extracted. Nested mirror
directories (e.g. blog post folders) are skipped — port them by hand if
needed.

First run extracts `_meta.html`, `_nav.html`, `_footer.html` (partials are
only written once — subsequent ports leave them alone unless `--force`).
Each page run replaces the `<main>…</main>` slot in `src/html/<page>.html`
with the extracted content. Referenced images are downloaded straight into
`public/assets/gfx/` and URLs are rewritten to `/assets/gfx/<filename>`.
Cache-buster query strings (`?1560895278`) and URL-encoded path noise
(`%3F…`, `%20…`) are stripped from filenames so the disk stays clean.

`port` fetches the linked stylesheets from the page head (including external
CDNs that `crawl` skips):

- **`@font-face` blocks** are harvested; font files downloaded into
  `public/assets/fonts/`; `src/less/_fonts.less` written with the cleaned
  block.
- **Same-origin stylesheets** are dumped as `src/less/_w2f-<name>.less` so
  the project builds without a WeeblyExport — `wget` is the source of
  truth. `url(…)` references inside are rewritten to `/assets/gfx/<name>`
  and the referenced images are downloaded too.
- **Weebly chrome stylesheets** (Fancybox skin, social-icons skin, commerce
  skin, VideoJS, Select2) are skipped — they wrap features no migrated
  site uses. The deny-list lives in `lib/weebly-chrome.mjs`.
- **Weebly chrome sprites** (fancybox sprites, social-share sprites,
  commerce/cart, blog-comment, loaders, decorative bars, `@2x-s<hash>`
  retina sprites, and a few dozen more) are skipped at download time for
  the same reason — they end up unreferenced once the user retires the
  `_w2f-*.less` compat layer. A summary count prints at the end of `port`.

After fonts, `port` rewrites `src/less/main.less` with the canonical import
order (`variables` → `_fonts` → `_w2f-<dumps>` → `_resets` → `_global` →
`_ui-kit` → …), pulling in only the files that actually exist in
`src/less/`. The rewrite is gated on a `Generated by w2f` marker comment —
hand-edited main.less files are left alone unless `--force` is set.

The extraction is intentionally lossy — Weebly markup is full of inline
tracking, render-blocking scripts, and CDN-bound stylesheets. The output is
a starter you clean up by hand, not a finished port.

### `forms` options

| flag | meaning |
| --- | --- |
| `--sitekey <key>`   | Real hCaptcha sitekey — replaces the test sitekey across `src/html/`. Bare positional accepted: `w2f forms <sitekey>` |
| `--skip-install`    | Don't run `npm install` in `functions/` |
| `--skip-secret`     | Don't run `firebase functions:secrets:set HCAPTCHA_SECRET` |

`forms` only runs after `port` has scaffolded the `functions/` directory
(triggered automatically on first form detection). Three independent steps
in order:

1. `npm install` in `functions/` — auto-skipped when `node_modules` is
   already populated, so re-runs are cheap.
2. Sitekey rewrite — replaces the official test sitekey
   (`10000000-ffff-…-0001`) with your real one from the [hCaptcha
   dashboard](https://dashboard.hcaptcha.com/sites) across every
   `src/html/*.html` file. Idempotent: re-running with the same key is a
   no-op.
3. `firebase functions:secrets:set HCAPTCHA_SECRET` — interactive: stdio is
   inherited so the firebase CLI's own paste prompt drives the flow. Never
   pass the secret on argv (shell history would leak it). Auto-skipped when
   stdin isn't a TTY (CI, piped runs, agent sessions) — the firebase prompt
   would block forever with no one to type into it. Run it yourself from a
   real terminal in that case.

Preconditions for step 3: `firebase-tools` on PATH, `firebase login`, and
the Blaze plan enabled on the project. Failures in any step are surfaced
but don't abort the others — a Blaze-pending project can still benefit
from step 1+2 landing locally.

## What it scaffolds

```
<project-root>/
  package.json          # build:html (posthtml), build:css (lessc), build:js (rollup), deploy
  firebase.json         # hosting only, cleanUrls, src/ + reference/ ignored
  .firebaserc           # default → <firebase-project>
  .posthtmlrc.js        # posthtml-include config (root → src/html)
  .gitignore .gitattributes
  README.md
  .weebly-migrate.json  # cached answers for re-runs (gitignored)
  .github/workflows/
    firebase-hosting-merge.yml   # only when --github-repo + --firebase-project set
  src/
    html/   # pages + Sass-style `_*.html` partials → compiled to public/
    less/   # → public/assets/css/   (includes _w2f-*.less mirror dumps,
            #                         plus opt-in _embed-consent / _lightbox)
    js/     # → public/assets/js/    (includes opt-in email-hider /
            #                         embed-consent / lightbox modules)
    gfx/    # graphics — deployable images committed, design sources
            # (PSD/AFD/etc.) sit alongside but are stripped by .gitignore
  public/
    assets/{css,js,gfx,fonts}/
  reference/
    WeeblyExport/       # the original theme, moved out of src/
    <domain>/           # wget mirror of the live site (gitignored)
```

## Reusable modules (opt-in)

Three modules every Weebly migration tends to need land in `src/` from
`init`. They're scaffolded *unused* — neither `app.js` nor `main.less`
imports them — so they cost nothing until you wire one up. Each ships with
an `@docs` MD sibling explaining the HTML contract and wiring.

| Module                              | Replaces                                   | Why scaffolded |
| ----------------------------------- | ------------------------------------------ | -------------- |
| `src/js/email-hider.js`             | Cloudflare `__cf_email__` runtime          | Weebly mailto links break on first deploy; Firebase Hosting has no equivalent edge decoder. |
| `src/js/embed-consent.js` + LESS    | Weebly's "single global OK" cookie banner  | GDPR-conformant click-to-load gate for YouTube / SoundCloud / Google Maps. Iframe stays out of the DOM until consent. |
| `src/js/lightbox.js` + LESS         | Fancybox + jQuery                          | Same `rel="lightbox[group]"` HTML hook the Weebly theme used; chrome deny-list also strips the Fancybox sprite assets at port time. |

To wire one up, add `import "./<module>.js"` in `src/js/app.js` and (where
relevant) `@import "_<module>.less"` in `src/less/main.less`. See each
sibling `.md` for the full HTML contract.

## CI / deploys

When both `--firebase-project` and `--github-repo` are set, `init` scaffolds
`.github/workflows/firebase-hosting-merge.yml` — pushes to `main` run
`npm ci && npm run build` then deploy `public/` via
`FirebaseExtended/action-hosting-deploy`. The workflow references a repo
secret named `FIREBASE_SERVICE_ACCOUNT_<PROJECT>` (uppercased, dashes →
underscores) — create it once via `firebase init hosting:github` or by
pasting a service-account JSON into a secret of that name.

## Declaring independence — retiring the `_w2f-*` compat layer

`port` lands a *buildable* project — pages render, fonts load, the LESS
compiles — but it's still wearing the Weebly skin. The natural arc after
that is to strip the compat layer and rewrite the pages on your own small
vocabulary. From a real migration:

- Delete the dumped CSS dumps (`_w2f-*.less`) and the original Weebly
  partials you don't want (`_blog.less`, `_commerce.less`, `_ui-kit.less`,
  large parts of `_responsive.less`). These exist for the buildable-out-
  of-the-box property; once your own page-types/global rules cover what
  you actually use, they're noise.
- Rewrite pages on a small editorial vocabulary — `.block`, `.cols`,
  `.hero`, whatever the design wants. The point of the rewrite is to own
  the markup; trying to preserve Weebly's class soup forever is the
  expensive path.
- Drop the Fancybox dependency and switch image galleries to the
  scaffolded `lightbox.js` — the HTML hook (`rel="lightbox[group]"`) is
  unchanged.
- Cross-check `public/assets/gfx/` against `src/less/*.less` and
  `src/html/*.html` references after the strip — anything orphaned is fair
  game to delete. The chrome deny-list catches the predictable Weebly
  sprite categories at download time, but project-specific cruft can still
  linger.

Track this work in its own commit (or PR) — keep the structural changes
separate from per-page content edits so the diff stays reviewable. The
port output is the starter; the rewrite is the project becoming itself.

## Forms

Two-phase workflow: `port` lays down the scaffold (works out of the box with
hCaptcha test keys, so the local build is functional); `forms` finalizes the
project with real hCaptcha credentials when you're ready to go live.

### Phase 1 — automatic, runs during `port`

If `port` detects a Weebly form (`<form>` carrying `wsite-form-*` markers) in
any extracted nav / footer / page body, it auto-scaffolds a Firebase Cloud
Function handler so the form keeps working without a Weebly backend:

- Rewrites every `<form action>` → `/api/submit-form` and forces `method="POST"`
- Injects an hCaptcha widget (ships with the official **test sitekey** so
  the scaffold works immediately — replace before going live) and a
  `_gotcha` honeypot input
- Drops `functions/index.js` — a v2 `onRequest` handler that verifies hCaptcha
  via [siteverify](https://docs.hcaptcha.com/#verify-the-user-response-server-side),
  writes submissions to Firestore (`formSubmissions/`), and redirects the
  visitor back to the source page with `?ok=1`
- Mutates `firebase.json` to add the `/api/submit-form` rewrite + `functions`
  block, and adds `deploy:functions` to the project's `package.json`

If no forms are detected, no scaffold lands — the project stays hosting-only.

### Phase 2 — explicit, run `w2f forms` once before deploying

```bash
w2f forms <real-hcaptcha-sitekey>
```

Three steps, each independently skippable:

1. `npm install` in `functions/` (auto-skipped when already installed)
2. Swap the hCaptcha test sitekey for your real one across every page in
   `src/html/` (no-op when no sitekey is passed)
3. `firebase functions:secrets:set HCAPTCHA_SECRET` (interactive — pastes
   into the firebase CLI's own prompt; never via argv). When stdin isn't a
   TTY, step 3 auto-skips with a "run this yourself" message so
   non-interactive callers (CI, agent sessions) don't hang on the prompt.

Flags: `--sitekey <key>`, `--skip-install`, `--skip-secret`.

`forms` is split from `port` so iterations on HTML cleanup don't pay the
npm-install + Firebase-roundtrip cost every time, and so `port` stays
offline-safe. Requires the Blaze plan + `firebase login` for step 3.

See the scaffolded `functions/README.md` for the full walkthrough, including
the email-notification stub.

## Idempotency

`init` is safe to re-run. Existing files are never overwritten. Prior answers
cache to `<target>/.weebly-migrate.json` and are offered as defaults next time.

- **convert** — skips files that already exist in `src/{less,js,html}/`.
- **crawl** — wget's timestamp-aware `--mirror` mode skips unchanged files.
- **port** — partials only written if still the skeleton TODO marker; page
  `<main>` slots replaced only while still the skeleton; image downloads skip
  existing files in `public/assets/gfx/`; `_w2f-*.less` dumps regenerate only
  while the `Generated by w2f` marker is present. `--force` overrides all four.
  Forms scaffold (`functions/`) lands on first form detection; subsequent
  ports skip existing files and check before mutating `firebase.json` /
  `package.json`.

## Prerequisites

- Node ≥ 18
- `wget` for the crawler (auto-installed via brew by the `postinstall` hook on macOS; install manually elsewhere)
- `firebase-tools` in the scaffolded project — `npm i -g firebase-tools`

## Design notes

- **CLI via `node:util.parseArgs`.** Built into Node 18+, zero deps. Subcommands
  are dispatched by dynamic `import('./commands/<name>.mjs')` — no registry.
- **Why posthtml + posthtml-include instead of CodeKit `.kit`.** CLI-driven,
  installed via `npm install` (no GUI dependency), and the include syntax
  (`<include src="_meta.html"></include>`) is plain HTML — readable, no
  template language to learn. Sass-style `_` prefix on partials lets the
  build glob (`src/html/[!_]*.html`) pick up pages cleanly.
- **Why skeleton `.html` files, not auto-converted partials.** Weebly partials
  are Mustache (`{logo}`, `{{#sections}}`); posthtml-include is tag-based with
  different semantics. A half-converted file misleads more than it helps. Each
  skeleton names the Weebly file to port from.
- **Why `reference/` is outside `src/`.** Clear mental separation: `src/` is
  the new source of truth, `reference/` is the corpus you read while porting.
  Gitignored (regenerate via `crawl`).
- **Why `public/` is checked in.** `npm run build:html` (posthtml) compiles
  `src/html/*.html` → `public/` locally; the compiled HTML is committed so
  Firebase deploy doesn't need a build step in CI.
- **Why the tool lives outside the scaffolded project.** The project ships
  clean — no `scripts/` folder, no migration tooling in its repo. The tool
  stays useful for the next Weebly site you migrate.

## Source layout

```
cli.mjs                  entry point (bin → weebly-to-firebase, w2f)
commands/
  init.mjs               scaffold + orchestrate firebase/convert/crawl/git
  convert.mjs            WeeblyExport assets → src/
  crawl.mjs              wget --mirror of the live site
  port.mjs               extract sections from crawled HTML → src/html/ + public/assets/img/
lib/
  args.mjs               parseArgs wrapper + help text
  prompt.mjs             readline wrapper (ask / askYesNo / askValid)
  target.mjs             resolve project root from --target / cwd
  templates.mjs          file generators for the scaffolded project
  firebase.mjs           `firebase` CLI driver for --setup-firebase
```

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
the PR workflow, and what fits the scope of the tool. The repo follows the
[Contributor Covenant](CODE_OF_CONDUCT.md).

Quick version: fork, branch off `main`, run your change against a real
Weebly site, open a PR. I (@copperdesign) review and merge.

## License

MIT — see [LICENSE](./LICENSE).

Created by [Christian Fillies](https://www.christianfillies.com).
