# Weebly → Firebase

Scaffold a Firebase Hosting project from a Weebly theme export, with optional
full-site mirror for asset/content porting. Zero external deps (Node built-ins
only; `wget` for the crawler).

## Install

Run once:

```bash
cd "/Users/home/Work Files/Weebly-to-Firebase"
npm link        # makes `weebly-to-firebase` available globally
```

Or just invoke directly with `node` — no install step needed.

## Use

Point a fresh project folder at a Weebly export:

```
<project-root>/
  src/
    WeeblyExport/    # drop the unzipped Weebly theme export here
```

Then run from the project root:

```bash
cd <project-root>
weebly-to-firebase
# or: node "/Users/home/Work Files/Weebly-to-Firebase/converter.mjs"
# or: node "/Users/home/Work Files/Weebly-to-Firebase/converter.mjs" <project-root>
```

The converter prompts for project name, npm slug, Firebase project ID, hosting
site, live domain, and GitHub repo. It then scaffolds:

```
package.json   firebase.json   .firebaserc   .gitignore   .gitattributes   README.md
src/{html,less,js,gfx,img}/
public/assets/{css,js,img}/
reference/
.weebly-migrate.json   # cached answers — re-runs use these as defaults
```

…and offers to (a) migrate Weebly assets into `src/`, (b) mirror the live site
into `reference/`, (c) `git init` with an initial commit.

## Scripts

| script               | what it does |
| ---                  | --- |
| `converter.mjs`      | Main interactive entry. Orchestrates everything. Idempotent. |
| `convert-assets.mjs` | Copy `WeeblyExport/styles/*.less` → `src/less/`, `assets/*.js` → `src/js/`, generate skeleton `.kit` partials, move `WeeblyExport/` → `reference/`. |
| `crawl-site.mjs`     | `wget --mirror` the live Weebly domain into `reference/<domain>/`. Timestamp-aware. |
| `lib/prompt.mjs`     | `readline/promises` wrapper (`ask`, `askYesNo`, `askValid`). |
| `lib/target.mjs`     | Resolve target project root from argv / cwd. |
| `lib/templates.mjs`  | File-content generators for the scaffolded project. |

Each sub-script also runs standalone:

```bash
node convert-assets.mjs [target-root]
node crawl-site.mjs     [target-root] [domain]
```

Both default `target-root` to `process.cwd()`.

## Prerequisites

- Node 18+
- `wget` for the crawler — `brew install wget`
- `firebase-tools` in the target project (after scaffold) — `npm i -g firebase-tools`

## Design notes

- **Why skeleton `.kit` files, not auto-converted partials?**
  Weebly partials are Mustache (`{logo}`, `{{#sections}}`); CodeKit uses
  `<!-- @include _head.kit -->`. A half-converted file misleads more than
  it helps. Each skeleton names the Weebly file to port from.

- **Why keep `reference/` outside `src/`?**
  Clear mental separation: `src/` is the new source of truth, `reference/`
  is the corpus you read while porting. `reference/` is gitignored
  (regenerate via `crawl-site.mjs`).

- **Why `public/` is checked in.**
  Mirrors the Q42 / Katrin Fillies pattern: CodeKit compiles `.kit` → `.html`
  locally; the compiled HTML is committed so Firebase deploy doesn't need a
  build step in CI.

- **Why the tool lives outside the scaffolded project.**
  The project ships clean — no `scripts/` folder, no migration tooling in
  its repo. Once you're past the porting phase the tool stays useful for
  the next Weebly site you migrate.
