/**
 * `weebly-to-firebase crawl` — mirror the live Weebly site into
 * <target>/reference/<domain>/ via wget.
 *
 * wget is the right tool here — battle-tested recursive download, link
 * rewriting, page-requisite fetching. Rewriting that in Node would be a
 * weekend project for no benefit.
 *
 * Output goes to reference/, which is gitignored. Re-running just refreshes;
 * wget's --mirror is timestamp-aware so unchanged files aren't re-downloaded.
 *
 * Domain resolution order:
 *   1. --domain <d>
 *   2. positional argument: `weebly-to-firebase crawl <domain>`
 *   3. cached value in <target>/.weebly-migrate.json
 *   4. interactive prompt (unless --yes, in which case bail)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ask, askYesNo } from '../lib/prompt.mjs';
import { resolveTarget } from '../lib/target.mjs';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function loadConfig(root) {
  const file = path.join(root, '.weebly-migrate.json');
  if (!(await exists(file))) return {};
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return {}; }
}

/** Confirm wget exists on $PATH; if not, print install hint and bail. */
async function ensureWget() {
  return new Promise(resolve => {
    const child = spawn('which', ['wget']);
    child.on('exit', code => {
      if (code === 0) return resolve(true);
      console.error('\nwget not found. Install it first:');
      console.error('  brew install wget\n');
      resolve(false);
    });
    child.on('error', () => {
      console.error('\nwget not found. Install it first:\n  brew install wget\n');
      resolve(false);
    });
  });
}

/**
 * Normalize a domain input. Accepts any of:
 *   nele-quaas.com, www.nele-quaas.com, https://nele-quaas.com/, http://...
 * Returns { domain, url } where domain is bare (for --domains=) and url is
 * the full https://… root for wget to start from.
 */
function normalizeDomain(raw) {
  let s = raw.trim();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/\/+$/, '');
  return { domain: s, url: `https://${s}/` };
}

function runWget(args, cwd) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ wget ${args.join(' ')}\n`);
    const child = spawn('wget', args, { cwd, stdio: 'inherit' });
    child.on('exit', code => {
      // wget exits non-zero on partial fetches (404s on subpages, etc.) —
      // normal for public-site mirroring; surface it but don't throw.
      if (code !== 0) console.log(`\n(wget exited ${code} — partial mirror; this is usually fine.)`);
      resolve(code);
    });
    child.on('error', reject);
  });
}

export async function run(flags = {}, positionals = []) {
  const root = resolveTarget(flags.target);
  const cfg = await loadConfig(root);
  const autoAccept = !!flags.yes;

  // Resolve domain: --domain wins, then positional, then cache, then prompt.
  const explicit = flags.domain || positionals[0];
  const rawDomain = explicit
    || cfg.liveDomain
    || (autoAccept ? '' : await ask('Live Weebly domain (e.g. nele-quaas.com)', { default: '' }));

  if (!rawDomain) {
    console.log('No domain provided — skipping crawl.');
    return;
  }

  const { domain, url } = normalizeDomain(rawDomain);
  await fs.mkdir(path.join(root, 'reference'), { recursive: true });

  // Only confirm if neither --yes nor an explicit domain was given.
  if (!explicit && !autoAccept) {
    const ok = await askYesNo(`Mirror ${url} into reference/${domain}/?`, { default: true });
    if (!ok) return;
  }

  if (!(await ensureWget())) return;

  // wget flags, deliberately chosen:
  //   --mirror              recursive + timestamps + infinite depth
  //   --convert-links       rewrite links so the mirror works offline
  //   --adjust-extension    foo.php → foo.php.html for browseability
  //   --page-requisites     include CSS/JS/images each page needs
  //   --no-parent           don't walk up above the start URL
  //   --domains=            restrict to the site itself
  //   --restrict-file-names=unix   safe for macOS
  //   -e robots=off         Weebly's robots.txt blocks much of the site
  //   --user-agent          some Weebly CDNs serve different markup to bots
  //   -P reference/         output base
  const args = [
    '--mirror',
    '--convert-links',
    '--adjust-extension',
    '--page-requisites',
    '--no-parent',
    `--domains=${domain}`,
    '--restrict-file-names=unix',
    '-e', 'robots=off',
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36',
    '-P', 'reference',
    url,
  ];

  await runWget(args, root);

  console.log(`\nMirror in ${path.join(root, 'reference', domain)}/`);
  console.log('(re-run any time — wget skips unchanged files.)');
}
