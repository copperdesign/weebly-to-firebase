# weebly-to-firebase

CLI to scaffold a Firebase Hosting project from a Weebly theme export — with
optional full-site mirror for asset/content porting. Zero deps (Node built-ins
only; `wget` for the crawler).

## Install

```bash
cd "/Users/home/Work Files/Weebly-to-Firebase"
npm link          # one-time — makes `weebly-to-firebase` and `w2f` available globally
```

Or invoke directly:

```bash
node "/Users/home/Work Files/Weebly-to-Firebase/cli.mjs" [command] [options]
```

## Quick start

Drop a Weebly export into a fresh project folder:

```
<project-root>/
  src/
    WeeblyExport/    # unzipped Weebly theme export
```

Then from the project root:

```bash
weebly-to-firebase            # interactive — prompts for everything
```

…or fully non-interactive:

```bash
w2f init --yes \
  --name "Nele Quaas" \
  --firebase-project nele-quaas-web \
  --hosting-site nele-quaas \
  --live-domain nele-quaas.com \
  --github-repo copperdesign/website-nelequaas
```

## Commands

```
weebly-to-firebase [command] [options]

Commands:
  init       Scaffold project (default if no command given)
  convert    Migrate WeeblyExport assets into src/{less,js,html}
  crawl      Mirror the live Weebly site into reference/
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
| `--skip-convert`            | Don't run the asset migration step |
| `--skip-crawl`              | Don't run the live-site crawl |
| `--skip-git`                | Don't init git |

### `convert` options

| flag | meaning |
| --- | --- |
| `--skip-styles` | Skip copying LESS |
| `--skip-js`     | Skip copying JS |
| `--skip-html`   | Skip generating `.html` partial/page skeletons |
| `--skip-move`   | Don't move `src/WeeblyExport` → `reference/` |

### `crawl` options

| flag | meaning |
| --- | --- |
| `--domain <domain>` | Domain to mirror (overrides cached config) |

`crawl` also accepts a positional: `weebly-to-firebase crawl example.com`.

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
  src/
    html/   # pages + Sass-style `_*.html` partials → compiled to public/
    less/   # → public/assets/css/
    js/     # → public/assets/js/
    gfx/    # design sources (PSD/AFD; gitignored)
    img/    # raw images
  public/
    assets/{css,js,img}/
  reference/
    WeeblyExport/       # the original theme, moved out of src/
    <domain>/           # wget mirror of the live site (gitignored)
```

## Idempotency

`init` is safe to re-run. Existing files are never overwritten. Prior answers
cache to `<target>/.weebly-migrate.json` and are offered as defaults next time.
The `convert` and `crawl` commands are idempotent too — convert skips existing
files; crawl uses wget's timestamp-aware mirror mode.

## Prerequisites

- Node ≥ 18
- `wget` for the crawler — `brew install wget`
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
- **Why `public/` is checked in.** Mirrors the Q42 / Katrin Fillies pattern:
  `npm run build:html` (posthtml) compiles `src/html/*.html` → `public/` locally;
  the compiled HTML is committed so Firebase deploy doesn't need a build step
  in CI.
- **Why the tool lives outside the scaffolded project.** The project ships
  clean — no `scripts/` folder, no migration tooling in its repo. The tool
  stays useful for the next Weebly site you migrate.

## Source layout

```
cli.mjs                  entry point (bin → weebly-to-firebase, w2f)
commands/
  init.mjs               scaffold + orchestrate convert/crawl/git
  convert.mjs            WeeblyExport assets → src/
  crawl.mjs              wget --mirror of the live site
lib/
  args.mjs               parseArgs wrapper + help text
  prompt.mjs             readline wrapper (ask / askYesNo / askValid)
  target.mjs             resolve project root from --target / cwd
  templates.mjs          file generators for the scaffolded project
```
