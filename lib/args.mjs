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

export const VALID_COMMANDS = ['init', 'convert', 'crawl', 'port'];

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
  'skip-git':       { type: 'boolean' },

  // convert step toggles
  'skip-styles':    { type: 'boolean' },
  'skip-js':        { type: 'boolean' },
  'skip-html':      { type: 'boolean' },
  'skip-move':      { type: 'boolean' },

  // crawl / port
  domain:           { type: 'string' },

  // port
  force:            { type: 'boolean' },
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

const HELP_GLOBAL = `weebly-to-firebase — scaffold a Firebase Hosting project from a Weebly theme export.

USAGE
  weebly-to-firebase [command] [options]

COMMANDS
  init                     Scaffold the project (default if no command given)
  convert                  Migrate WeeblyExport assets into src/{less,js,html}
  crawl                    Mirror the live Weebly site into reference/
  port                     Extract crawled HTML into src/html/ + public/assets/img/
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
    --name "Nele Quaas" \\
    --firebase-project nele-quaas-web \\
    --hosting-site nele-quaas \\
    --live-domain nele-quaas.com \\
    --github-repo copperdesign/website-nelequaas \\
    --setup-firebase

  # Re-mirror the live site any time
  w2f crawl

  # Convert assets only (skip moving WeeblyExport to reference/)
  w2f convert --skip-move

  # First-pass content extraction from the crawled mirror
  w2f port               # default page: index
  w2f port kontakt       # extract just /kontakt
  w2f port --force       # overwrite even if hand-edited

'w2f' and 'weebly-to-firebase' are the same binary.`;

const HELP_INIT = `weebly-to-firebase init — scaffold a Firebase project from src/WeeblyExport/.

USAGE
  weebly-to-firebase [init] [options]

OPTIONS
  --target <path>            Project root (default: current directory)
  --name <string>            Project display name
  --slug <string>            npm package slug
  --description <string>     One-line description
  --firebase-project <id>    Firebase project ID                (required)
  --hosting-site <name>      firebase.json hosting.site         (optional)
  --live-domain <domain>     Live Weebly domain                 (optional)
  --github-repo <owner/name> GitHub repo for the project        (optional)
  --setup-firebase           Create Firebase project + hosting site via CLI
  --skip-convert             Don't run the asset migration step
  --skip-crawl               Don't run the live-site crawl
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
  --skip-move              Don't move src/WeeblyExport → reference/
  -y, --yes                Accept all defaults; skip confirmations
  -h, --help               Show this help

Idempotent: existing files in src/{less,js,html} are never overwritten.`;

const HELP_PORT = `weebly-to-firebase port — extract content from the crawled mirror.

USAGE
  weebly-to-firebase port [page] [options]

OPTIONS
  --target <path>          Project root (default: current directory)
  --domain <domain>        Override the cached liveDomain (which mirror to read)
  --force                  Replace partials and page main even if hand-edited
  -h, --help               Show this help

Reads reference/<domain>/<page>.html (default page: index), extracts
<head> → _meta.html, header/nav → _nav.html, footer → _footer.html, and
<main> / content block → src/html/<page>.html's <main> slot.

Referenced images are downloaded into public/assets/img/ and URLs are
rewritten to /assets/img/<filename>.

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

Output goes to <target>/reference/<domain>/ (gitignored).`;

const HELP = {
  init: HELP_INIT,
  convert: HELP_CONVERT,
  crawl: HELP_CRAWL,
  port: HELP_PORT,
};

export function printHelp(sub) {
  console.log(HELP[sub] || HELP_GLOBAL);
}
