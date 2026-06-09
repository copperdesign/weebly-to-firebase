/**
 * CLI argument parsing + help/version output.
 *
 * Uses Node's built-in `node:util.parseArgs` — no deps. Flags are defined
 * once in OPTIONS; kebab-case keys are normalized to camelCase for command
 * code (e.g. `--firebase-project` → `flags.firebaseProject`).
 *
 * Subcommands are dispatched by cli.mjs via dynamic import — no registry,
 * each command is its own module under commands/.
 */

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

export const VALID_COMMANDS = ['init', 'convert', 'crawl', 'port', 'forms'];

const OPTIONS = {
  // global
  target:           { type: 'string' },
  yes:              { type: 'boolean', short: 'y' },
  help:             { type: 'boolean', short: 'h' },
  version:          { type: 'boolean', short: 'v' },

  // init config (also accepted on the convert/crawl subcommands; ignored if unused)
  name:             { type: 'string' },
  slug:             { type: 'string' },
  description:      { type: 'string' },
  'firebase-project': { type: 'string' },
  'hosting-site':   { type: 'string' },
  'live-domain':    { type: 'string' },
  'github-repo':    { type: 'string' },

  // init step toggles
  'setup-firebase': { type: 'boolean' },
  'skip-convert':   { type: 'boolean' },
  'skip-crawl':     { type: 'boolean' },
  'skip-port':      { type: 'boolean' },
  'skip-git':       { type: 'boolean' },

  // convert step toggles
  'skip-styles':    { type: 'boolean' },
  'skip-js':        { type: 'boolean' },
  'skip-html':      { type: 'boolean' },

  // crawl / port
  domain:           { type: 'string' },

  // port
  force:            { type: 'boolean' },
  all:              { type: 'boolean' },

  // forms
  sitekey:          { type: 'string' },
  'skip-install':   { type: 'boolean' },
  'skip-secret':    { type: 'boolean' },
};

function kebabToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Parse argv into { command, flags, positionals, error? }.
 * On parse error returns { error: <message> } instead of throwing.
 */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    return { error: e.message };
  }

  const { values, positionals } = parsed;
  const flags = {};
  for (const [k, v] of Object.entries(values)) flags[kebabToCamel(k)] = v;

  // First positional is the subcommand IF it matches a known one. Otherwise
  // there's no explicit command — cli.mjs decides the default action so it
  // can distinguish `--help` (global) from `init --help` (init-specific).
  const first = positionals[0];
  const isCommand = first && (VALID_COMMANDS.includes(first) || first === 'help' || first === 'version');
  if (!isCommand) {
    return { command: undefined, flags, positionals };
  }
  return { command: first, flags, positionals: positionals.slice(1) };
}

export function printVersion() {
  console.log(`${PKG.name} ${PKG.version}`);
}

const HELP_GLOBAL = `weebly-to-firebase — scaffold a Firebase Hosting project from a live Weebly site.
wget mirror is the primary source; an optional WeeblyExport theme overlays cleaner LESS/JS source.

USAGE
  weebly-to-firebase [command] [options]

COMMANDS
  init                     Scaffold the project (default if no command given)
  convert                  Migrate WeeblyExport assets into src/{less,js,html}
  crawl                    Mirror the live Weebly site into reference/
  port                     Extract crawled HTML into src/html/ + public/assets/gfx/
  forms                    Finalize the forms handler (npm install, sitekey,
                           HCAPTCHA_SECRET) — run once after 'port' detects
                           a form and you have your real hCaptcha keys
  help [command]           Show help (or help for a specific command)
  version                  Print version

GLOBAL OPTIONS
  --target <path>          Project root (default: current directory)
  -y, --yes                Accept all defaults; skip confirmations
  -h, --help               Show help
  -v, --version            Print version

Run 'weebly-to-firebase help <command>' for command-specific options.

EXAMPLES
  # Interactive scaffold in current directory
  w2f

  # Non-interactive with all flags + Firebase project creation
  w2f init --yes \\
    --name "My Site" \\
    --firebase-project my-site-web \\
    --hosting-site my-site \\
    --live-domain example.weebly.com \\
    --github-repo your-org/my-site \\
    --setup-firebase

  # Re-mirror the live site any time
  w2f crawl

  # Convert assets only (no scaffold, no crawl)
  w2f convert

  # First-pass content extraction from the crawled mirror
  w2f port               # default page: index
  w2f port kontakt       # extract just /kontakt
  w2f port --force       # overwrite even if hand-edited

  # Finalize the contact-form handler (after port scaffolded functions/)
  w2f forms                                   # npm install + secret prompt
  w2f forms abcd1234-...-...-...              # also swap in real sitekey
  w2f forms --sitekey <key> --skip-secret     # just rewrite HTML, no Firebase

'w2f' and 'weebly-to-firebase' are the same binary.`;

const HELP_INIT = `weebly-to-firebase init — scaffold a Firebase project from a live Weebly site.

USAGE
  weebly-to-firebase [init] [options]

The wizard mirrors the live site with wget (primary source), ports every
crawled page into src/html/ + dumps mirror CSS / fonts / images, and only
then offers to overlay a WeeblyExport theme if you've dropped one into
reference/WeeblyExport/.

OPTIONS
  --target <path>            Project root (default: current directory)
  --name <string>            Project display name
  --slug <string>            npm package slug
  --description <string>     One-line description
  --firebase-project <id>    Firebase project ID                (required)
  --hosting-site <name>      firebase.json hosting.site         (optional)
  --live-domain <domain>     Live Weebly domain                 (primary source)
  --github-repo <owner/name> GitHub repo for the project        (optional)
  --setup-firebase           Create Firebase project + hosting site via CLI
  --skip-crawl               Don't run the live-site crawl (primary source)
  --skip-port                Don't auto-port pages after crawl
  --skip-convert             Don't offer the WeeblyExport overlay step
  --skip-git                 Don't init git
  -y, --yes                  Accept all defaults; skip confirmations
  -h, --help                 Show this help

Re-running init is idempotent — prior answers are cached in
<target>/.weebly-migrate.json and offered as defaults.`;

const HELP_CONVERT = `weebly-to-firebase convert — migrate WeeblyExport assets into src/.

USAGE
  weebly-to-firebase convert [options]

OPTIONS
  --target <path>          Project root (default: current directory)
  --skip-styles            Skip copying LESS
  --skip-js                Skip copying JS
  --skip-html              Skip generating .html partial/page skeletons
  -y, --yes                Accept all defaults; skip confirmations
  -h, --help               Show this help

Idempotent: existing files in src/{less,js,html} are never overwritten.`;

const HELP_PORT = `weebly-to-firebase port — extract content from the crawled mirror.

USAGE
  weebly-to-firebase port [page] [options]

OPTIONS
  --target <path>          Project root (default: current directory)
  --domain <domain>        Override the cached liveDomain (which mirror to read)
  --all                    Port every .html file found in the crawled mirror,
                           scaffolding skeletons for pages not yet in src/html/
  --force                  Replace partials and page main even if hand-edited
  -h, --help               Show this help

Reads reference/<domain>/<page>.html (default page: index), extracts
<head> → _meta.html, header/nav → _nav.html, footer → _footer.html, and
<main> / content block → src/html/<page>.html's <main> slot.

With --all, partials + global setup (fonts, mirror CSS, main.less, app.js)
run once against the index page, then every other .html file in the mirror
is ported in turn. New pages (no existing src/html/<name>.html) get a
skeleton scaffolded automatically before their main block is extracted.

Referenced images are downloaded into public/assets/gfx/ and URLs are
rewritten to /assets/gfx/<filename>. Cache-buster query strings and
URL-encoded path noise are stripped from filenames.

Linked stylesheets are fetched (including external CDNs that crawl skips):
@font-face declarations are harvested into public/assets/fonts/ +
src/less/_fonts.less, and same-origin stylesheets are dumped as
src/less/_w2f-<name>.less so the project is buildable without a
WeeblyExport theme — wget is the source of truth.

src/less/main.less is rewritten with the canonical Weebly import order
(variables → _fonts → _w2f-<dumps> → _resets → _global → _ui-kit → …) —
only if the file was generated by w2f (marker comment) or --force is set.
Structured Weebly partials (from \`w2f convert\`) compose AFTER the mirror
dumps and override them rule-by-rule.

Partials are written only once (subsequent ports leave them alone unless
--force). Page main slots are replaced only while still the skeleton TODO.

This is a starter, not a finished port. Weebly markup is messy — clean up
in src/html/ before \`npm run build\`.`;

const HELP_CRAWL = `weebly-to-firebase crawl — mirror the live Weebly site via wget.

USAGE
  weebly-to-firebase crawl [domain] [options]

OPTIONS
  --target <path>          Project root (default: current directory)
  --domain <domain>        Domain to mirror (overrides cached .weebly-migrate.json)
  -y, --yes                Accept all defaults; skip confirmations
  -h, --help               Show this help

Requires wget (brew install wget). Re-running just refreshes — wget's --mirror
is timestamp-aware so unchanged files aren't re-downloaded.

The crawl is seeded from /sitemap.xml when available (Weebly's nav is
JS-rendered, so a recursive walk from the homepage alone usually misses
pages). Both bare and www. variants of the domain are accepted as
in-scope so mixed internal links don't get dropped.

Output goes to <target>/reference/<domain>/ (gitignored).`;

const HELP_FORMS = `weebly-to-firebase forms — finalize the contact-form handler.

USAGE
  weebly-to-firebase forms [sitekey] [options]

OPTIONS
  --target <path>          Project root (default: current directory)
  --sitekey <key>          Real hCaptcha sitekey to swap in for the test key
                           (also accepts a bare positional, see examples).
                           Get one at https://dashboard.hcaptcha.com/sites.
  --skip-install           Don't run npm install in functions/
  --skip-secret            Don't run firebase functions:secrets:set
  -h, --help               Show this help

Runs three independent steps in order; each prints its own result line and
can be skipped:

  1. npm install in functions/        (skipped automatically when
                                       functions/node_modules is populated)
  2. Replace the hCaptcha test sitekey with --sitekey across src/html/
     (no-op when --sitekey is not given)
  3. firebase functions:secrets:set HCAPTCHA_SECRET
     (interactive — pastes into the firebase CLI's own prompt; never put
     the secret on argv, shell history would leak it)

Preconditions:
  - functions/ must exist (i.e. 'w2f port' detected at least one form).
  - Step 3 needs firebase-tools on PATH + a logged-in user + the project
    on the Blaze plan.

Safe to re-run — the npm-install short-circuits when deps are already in
place, the sitekey rewrite is idempotent (no test key found → no-op), and
the secret-set just overwrites the prior value when invoked again.

EXAMPLES
  w2f forms                                      # install + interactive secret
  w2f forms abcd1234-ef56-...-real-...           # also rewrite sitekey
  w2f forms --sitekey <key> --skip-secret        # local only, no Firebase`;

const HELP = {
  init: HELP_INIT,
  convert: HELP_CONVERT,
  crawl: HELP_CRAWL,
  port: HELP_PORT,
  forms: HELP_FORMS,
};

export function printHelp(sub) {
  console.log(HELP[sub] || HELP_GLOBAL);
}
