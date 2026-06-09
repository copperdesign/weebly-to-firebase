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
 * Why sitemap-seeded:
 *   Weebly's navigation is JS-rendered — wget can't follow links it never
 *   sees in the static HTML, so a recursive crawl from the homepage alone
 *   typically misses most pages. Every Weebly site exposes /sitemap.xml,
 *   so we fetch it, parse the `<loc>` entries, and pass them to wget as
 *   additional seeds via -i. Recursive --mirror still runs from the
 *   homepage, picking up assets reachable from each seed.
 *
 * Why both bare and www. domains:
 *   Internal links on Weebly sites often mix `example.com` and
 *   `www.example.com`. Locking --domains to one would drop the other.
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
import { normalizeDomain as normalizeHost } from '../lib/domain.mjs';

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
 * Returns { domain, url } — `domain` is bare (matches the directory wget
 * writes the mirror to), `url` is the https:// root wget starts crawling from.
 */
function normalizeDomain(raw) {
  const domain = normalizeHost(raw);
  return { domain, url: `https://${domain}/` };
}

/**
 * Fetch a URL as text. Returns null on any error (HTTP non-2xx, network
 * failure, etc.) — callers handle missing sitemaps gracefully.
 */
async function fetchText(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

/**
 * Parse `<loc>…</loc>` entries from a sitemap XML body. Handles both
 * urlset (page list) and sitemapindex (links to nested sitemaps) — the
 * latter is rare on Weebly but cheap to support.
 *
 * Regex-based rather than full XML parsing because we only need one
 * element and the structure is predictable. Drops malformed entries
 * silently.
 */
function parseSitemapLocs(xml) {
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const url = m[1].trim();
    if (!url) continue;
    // Decode HTML entities the sitemap may contain (`&amp;` → `&`, etc.).
    const decoded = url
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    out.push(decoded);
  }
  return out;
}

/**
 * Discover every URL that should seed the crawl. Strategy:
 *   1. Try both /sitemap.xml on the bare host and www. variant.
 *   2. If either returns a sitemapindex, recurse one level into each
 *      nested sitemap.
 *   3. De-duplicate and return.
 *
 * Returns an empty array if no sitemap is reachable — caller falls back
 * to the homepage alone, same as the old behaviour.
 */
async function collectSitemapUrls(host) {
  const candidates = [
    `https://${host}/sitemap.xml`,
    `https://www.${host.replace(/^www\./, '')}/sitemap.xml`,
  ];
  const seen = new Set();
  for (const candidate of [...new Set(candidates)]) {
    const xml = await fetchText(candidate);
    if (!xml) continue;
    const locs = parseSitemapLocs(xml);
    if (!locs.length) continue;
    // A sitemapindex points at more sitemaps; a urlset points at pages.
    // Tell them apart by inspecting the outermost element name.
    const isIndex = /<sitemapindex\b/i.test(xml);
    if (isIndex) {
      for (const nested of locs) {
        const inner = await fetchText(nested);
        if (!inner) continue;
        for (const u of parseSitemapLocs(inner)) seen.add(u);
      }
    } else {
      for (const u of locs) seen.add(u);
    }
    // First sitemap that works wins; trying both bare and www. when one
    // succeeded would just duplicate the same URLs.
    if (seen.size) break;
  }
  return [...seen];
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

  // Sitemap-seed the crawl. Weebly's nav is JS-rendered so wget's recursive
  // walk from the homepage misses most pages. /sitemap.xml is the canonical
  // page list — feed every URL in as an additional seed.
  console.log(`\nFetching sitemap from ${domain}…`);
  const sitemapUrls = await collectSitemapUrls(domain);
  let seedFile = null;
  if (sitemapUrls.length) {
    seedFile = path.join(root, 'reference', '.w2f-crawl-seeds.txt');
    await fs.writeFile(seedFile, sitemapUrls.join('\n') + '\n');
    console.log(`  ${sitemapUrls.length} URL${sitemapUrls.length === 1 ? '' : 's'} discovered.`);
  } else {
    console.log('  no sitemap found — falling back to recursive crawl from homepage only.');
    console.log('  (some Weebly pages reached only via JS nav may be missed.)');
  }

  // Bare + www. variants in --domains so internal links can mix and match
  // without wget dropping the "wrong" host.
  const bareHost = domain.replace(/^www\./, '');
  const allowedHosts = [bareHost, `www.${bareHost}`].join(',');

  // wget flags, deliberately chosen:
  //   --mirror              recursive + timestamps + infinite depth
  //   --convert-links       rewrite links so the mirror works offline
  //   --adjust-extension    foo.php → foo.php.html for browseability
  //   --page-requisites     include CSS/JS/images each page needs
  //   --no-parent           don't walk up above the start URL
  //   --domains=            restrict to the site itself (bare + www.)
  //   --no-host-directories collapse bare + www. into one mirror tree —
  //                         without this, sitemap seeds on the "other" host
  //                         (e.g. www. when the cached domain is bare) land
  //                         in a sibling reference/www.<host>/ directory that
  //                         `port --all` never reads. Weebly sitemaps almost
  //                         always pin a single canonical host, so without
  //                         this flag we'd silently mirror half the site into
  //                         the wrong dir.
  //   --restrict-file-names=unix   safe for macOS
  //   -e robots=off         Weebly's robots.txt blocks much of the site
  //   --user-agent          some Weebly CDNs serve different markup to bots
  //   -P reference/<host>/  output base — paired with --no-host-directories
  //                         so the mirror lands at the same path the port
  //                         step reads from regardless of which host wget
  //                         actually fetched
  //   -i <seed-file>        seed the crawl from sitemap URLs (when available)
  const args = [
    '--mirror',
    '--convert-links',
    '--adjust-extension',
    '--page-requisites',
    '--no-parent',
    `--domains=${allowedHosts}`,
    '--no-host-directories',
    '--restrict-file-names=unix',
    '-e', 'robots=off',
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36',
    '-P', `reference/${bareHost}`,
  ];
  if (seedFile) args.push('-i', seedFile);
  args.push(url);

  await runWget(args, root);

  // Clean up the seed file — it lives in reference/ which is gitignored, but
  // leaving it around clutters the dir listing.
  if (seedFile) {
    try { await fs.unlink(seedFile); } catch { /* best effort */ }
  }

  console.log(`\nMirror in ${path.join(root, 'reference', domain)}/`);
  // Surface the actual page count so the user notices when something looks
  // off (e.g. sitemap had 12 URLs but only 3 HTML files in the mirror).
  try {
    const entries = await fs.readdir(path.join(root, 'reference', domain));
    const htmlCount = entries.filter(f => /\.html?$/i.test(f)).length;
    console.log(`(${htmlCount} HTML file${htmlCount === 1 ? '' : 's'} at mirror root; re-run any time — wget skips unchanged files.)`);
  } catch {
    console.log('(re-run any time — wget skips unchanged files.)');
  }
}
