/**
 * `weebly-to-firebase port` — first-pass content extraction from the crawled
 * live-site mirror into the src/ skeletons.
 *
 * What it does, per invocation:
 *   - Reads reference/<domain>/<page>.html (default: index)
 *   - Extracts <head>, header/nav, footer, and main sections via best-effort
 *     regex pattern matching. Multiple fallback selectors per section so
 *     Weebly's slightly-different markup shapes still surface something.
 *   - Rewrites referenced image URLs to local /assets/img/<filename>; downloads
 *     each referenced image into public/assets/img/.
 *   - Writes _meta.html, _nav.html, _footer.html (partials) and <page>.html
 *     under src/html/. Partials are written only once (when the existing file
 *     is still a TODO-marker skeleton); pages get their <main>…</main> slot
 *     replaced with the extracted content.
 *
 * This is a starter. The output is intentionally lossy — Weebly markup is
 * full of inline tracking, render-blocking script tags, and CDN-shaped
 * stylesheets. The point is to bootstrap the porting work so the user spends
 * their time on cleanup, not on the structural copy-paste.
 *
 * Idempotency:
 *   - Partials: skipped if the file no longer contains the skeleton TODO
 *     marker (so hand-edits aren't clobbered). --force overrides.
 *   - Page main slot: replaced only if it still contains the skeleton TODO
 *     marker, unless --force is set.
 *   - Image downloads: skipped if the destination already exists.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveTarget } from '../lib/target.mjs';
import { normalizeDomain } from '../lib/domain.mjs';

/* ──────────────────────────────────────────────────────────────────────────
 * Extraction helpers
 * Regex-based. Each helper returns the inner HTML of the matched element,
 * or null when nothing matched. Multiple fallback patterns per section keep
 * the lossiness manageable across slightly different Weebly markup variants.
 * ────────────────────────────────────────────────────────────────────────── */

/** Inner HTML of the first `<tag …>…</tag>` block. */
function extractTag(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * Inner HTML of the first element matching `id="<name>"` or
 * `class="… <name> …"`. Walks tag depth to find the balancing close — naive
 * but handles nested same-tag siblings well enough for the markup we see.
 */
function extractByIdOrClass(html, name) {
  const openRe = new RegExp(
    `<(\\w+)\\b[^>]*(?:id=["']${name}["']|class=["'][^"']*\\b${name}\\b[^"']*["'])[^>]*>`,
    'i',
  );
  const start = html.match(openRe);
  if (!start) return null;
  const tag = start[1];
  const openAll = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closeAll = new RegExp(`<\\/${tag}>`, 'gi');
  const contentStart = start.index + start[0].length;
  openAll.lastIndex = contentStart;
  closeAll.lastIndex = contentStart;
  let depth = 1;
  let cursor = contentStart;
  while (depth > 0) {
    openAll.lastIndex = cursor;
    closeAll.lastIndex = cursor;
    const nextOpen = openAll.exec(html);
    const nextClose = closeAll.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0) return html.slice(contentStart, nextClose.index);
    }
  }
  return null;
}

/** Try several selectors in order; first hit wins. */
function tryEach(html, attempts) {
  for (const fn of attempts) {
    const out = fn(html);
    if (out && out.trim()) return out;
  }
  return null;
}

function extractHead(html) {
  return extractTag(html, 'head');
}

function extractNav(html) {
  return tryEach(html, [
    h => extractTag(h, 'header'),
    h => extractTag(h, 'nav'),
    h => extractByIdOrClass(h, 'wsite-header-section'),
    h => extractByIdOrClass(h, 'wsite-header'),
    h => extractByIdOrClass(h, 'header'),
  ]);
}

function extractFooter(html) {
  return tryEach(html, [
    h => extractTag(h, 'footer'),
    h => extractByIdOrClass(h, 'wsite-footer-section'),
    h => extractByIdOrClass(h, 'wsite-footer'),
    h => extractByIdOrClass(h, 'footer'),
  ]);
}

function extractMain(html) {
  return tryEach(html, [
    h => extractTag(h, 'main'),
    h => extractByIdOrClass(h, 'wsite-content'),
    h => extractByIdOrClass(h, 'main-content'),
    h => extractByIdOrClass(h, 'content'),
  ]);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Filters
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Remove visible Weebly attributions: the "Proudly powered by Weebly" link,
 * any other anchor pointing to weebly.com, weebly tracking iframes/images,
 * and meta tags whose content references Weebly's CDN. Wrappers left empty
 * by the removal are collapsed in a single pass.
 *
 * Class names on the markup (e.g. `wsite-footer-credit`) are left alone —
 * they're inert without Weebly's CSS, and the user may want them as
 * porting landmarks.
 */
function stripWeeblyTraces(html) {
  let out = html
    // "Proudly powered by <a …>Weebly</a>" (including the trailing period)
    .replace(/Proudly powered by\s*<a\b[\s\S]*?<\/a>\.?/gi, '')
    // Any anchor whose href points at weebly.com / editmysite.com
    .replace(/<a\b[^>]*?\b(?:weebly\.com|editmysite\.com)[^>]*?>[\s\S]*?<\/a>/gi, '')
    // Tracking iframes / images on weebly CDNs
    .replace(/<iframe\b[^>]*?\b(?:weebly\.com|editmysite\.com)[^>]*?>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<img\b[^>]*?\b(?:weebly\.com|editmysite\.com)[^>]*?\/?>/gi, '')
    // Weebly-flavored meta tags (generator, og:site_name, twitter:image, …)
    .replace(/<meta\b[^>]*?\b(?:weebly|editmysite)[^>]*?\/?>/gi, '');

  // Collapse empty wrappers left behind. Loops so nested empties go too —
  // a typical Weebly credit is <div class=wsite-footer-credit><p>…</p></div>,
  // and a single pass would leave the outer div behind.
  const emptyRe = /<(p|span|div)\b[^>]*>\s*<\/\1>/gi;
  let prev;
  do { prev = out; out = out.replace(emptyRe, ''); } while (out !== prev);
  return out;
}

/**
 * Strip noise from the head block: scripts, tracking <noscript>, external
 * stylesheets, plus Weebly-specific traces. Keep semantic meta (charset,
 * title, description, og:*) and the language attribute. The build re-attaches
 * our own CSS/JS via package.json scripts, so dragging Weebly's link tags
 * forward only hurts.
 */
function filterMetaHead(headHtml) {
  return stripWeeblyTraces(headHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*\/?>/gi, '')
    .replace(/<link\b[^>]*(?:editmysite|weebly|squarespace)[^>]*\/?>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ''))
    // collapse leftover empty lines
    .replace(/^\s*[\r\n]/gm, '')
    .trim();
}

/** Same noise filter for body sections. */
function filterBodyChunk(html) {
  return stripWeeblyTraces(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ''))
    .trim();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Asset rewriting + download
 * Finds <img src>, <img srcset>, and CSS-`url(…)` references. Downloads each
 * to public/assets/img/ and rewrites the URL to /assets/img/<filename>.
 * ────────────────────────────────────────────────────────────────────────── */

const URL_ATTR_RE = /(\s(?:src|href|poster)\s*=\s*)(["'])([^"']+)\2/gi;
const SRCSET_RE = /(\ssrcset\s*=\s*)(["'])([^"']+)\2/gi;
const CSS_URL_RE = /url\(\s*(["']?)([^)"']+)\1\s*\)/gi;

function isLocalishUrl(u) {
  return !u || u.startsWith('data:') || u.startsWith('#') || u.startsWith('mailto:') || u.startsWith('tel:');
}

function isImageUrl(u) {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|ico)(?:\?|$)/i.test(u);
}

function basenameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const seg = u.pathname.split('/').pop();
    return decodeURIComponent(seg) || null;
  } catch { return null; }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function downloadOne(url, destDir) {
  const name = basenameFromUrl(url);
  if (!name) return null;
  const dest = path.join(destDir, name);
  if (await exists(dest)) return name;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`    ! ${url} → ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(dest, buf);
    return name;
  } catch (err) {
    console.log(`    ! ${url} → ${err.message}`);
    return null;
  }
}

/**
 * Walk all image-looking URLs in `html`, download each to `imgDir`, and
 * return the rewritten HTML. URLs we can't fetch are left untouched so the
 * user sees them in the source and can address them by hand.
 */
async function rewriteAndDownloadAssets(html, imgDir) {
  const downloads = new Map(); // original URL → local filename
  const collect = u => {
    if (isLocalishUrl(u)) return;
    if (!isImageUrl(u)) return;
    if (downloads.has(u)) return;
    downloads.set(u, null); // placeholder; filled after download
  };

  // 1. Discover all candidate URLs in attributes + srcset + url(...).
  for (const m of html.matchAll(URL_ATTR_RE)) collect(m[3]);
  for (const m of html.matchAll(SRCSET_RE)) {
    for (const part of m[3].split(',')) collect(part.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(CSS_URL_RE)) collect(m[2]);

  // 2. Download each unique URL.
  for (const url of downloads.keys()) {
    const local = await downloadOne(url, imgDir);
    if (local) downloads.set(url, local);
  }
  const ok = [...downloads.entries()].filter(([, v]) => v).length;
  if (downloads.size) console.log(`    ${ok}/${downloads.size} images downloaded`);

  // 3. Rewrite occurrences. Only URLs we successfully downloaded get
  //    rewritten — leave broken ones visible.
  const rewriteOne = u => {
    const local = downloads.get(u);
    return local ? `/assets/img/${local}` : u;
  };
  let out = html
    .replace(URL_ATTR_RE, (_, pre, q, u) => `${pre}${q}${rewriteOne(u)}${q}`)
    .replace(SRCSET_RE, (_, pre, q, set) => {
      const rewritten = set.split(',').map(part => {
        const [u, ...rest] = part.trim().split(/\s+/);
        return [rewriteOne(u), ...rest].join(' ');
      }).join(', ');
      return `${pre}${q}${rewritten}${q}`;
    })
    .replace(CSS_URL_RE, (_, q, u) => `url(${q}${rewriteOne(u)}${q})`);
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * File-writing helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** A skeleton is detected by the TODO marker the converter writes. */
function isSkeleton(content) {
  return /<!--\s*TODO:\s*port (?:from|content from)/i.test(content);
}

async function writePartial(root, name, body, force) {
  const dest = path.join(root, 'src/html', `${name}.html`);
  if (await exists(dest) && !force) {
    const existing = await fs.readFile(dest, 'utf8');
    if (!isSkeleton(existing)) {
      console.log(`  skip src/html/${name}.html (hand-edited; use --force)`);
      return;
    }
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body.endsWith('\n') ? body : body + '\n');
  console.log(`  +    src/html/${name}.html`);
}

/**
 * For pages: replace just the `<main>…</main>` body. Leaves the surrounding
 * include composition intact so hand-edits to page structure survive.
 */
async function writePageMain(root, page, mainHtml, force) {
  const dest = path.join(root, 'src/html', `${page}.html`);
  const skeleton = await exists(dest) ? await fs.readFile(dest, 'utf8') : null;
  if (!skeleton) {
    console.log(`  !  src/html/${page}.html missing — run init/convert first`);
    return;
  }
  const mainBlock = `<main>\n    ${mainHtml.trim().replace(/\n/g, '\n    ')}\n  </main>`;
  const next = skeleton.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, mainBlock);
  if (next === skeleton) {
    console.log(`  !  src/html/${page}.html has no <main> block to fill`);
    return;
  }
  // Refuse to clobber a non-skeleton main unless forced.
  const currentMain = skeleton.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? '';
  if (!isSkeleton(currentMain) && !force) {
    console.log(`  skip src/html/${page}.html main (hand-edited; use --force)`);
    return;
  }
  await fs.writeFile(dest, next);
  console.log(`  +    src/html/${page}.html (main replaced)`);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Runner
 * ────────────────────────────────────────────────────────────────────────── */

async function readJson(p, fallback = {}) {
  if (!(await exists(p))) return fallback;
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return fallback; }
}

export async function run(flags = {}, positionals = []) {
  const root = resolveTarget(flags.target);
  const page = positionals[0] || 'index';
  const force = !!flags.force;

  // Resolve which crawled mirror to read. Flag wins, otherwise cache.
  // Normalize defensively — older caches may have stored the raw user input
  // (with `https://` or a trailing slash), but wget writes the mirror into
  // a directory named with just the bare host.
  const cached = await readJson(path.join(root, '.weebly-migrate.json'));
  const domain = normalizeDomain(flags.domain || cached.liveDomain);
  if (!domain) {
    throw new Error('No domain available. Pass --domain or run `init` first to cache one.');
  }

  const sourcePath = path.join(root, 'reference', domain, `${page}.html`);
  if (!(await exists(sourcePath))) {
    throw new Error(`Crawled page not found: ${sourcePath}. Run \`w2f crawl ${domain}\` first.`);
  }

  console.log(`\nPorting ${page} from reference/${domain}/${page}.html`);
  const html = await fs.readFile(sourcePath, 'utf8');
  const imgDir = path.join(root, 'public/assets/img');

  // — Partials (only on first port; subsequent pages reuse them) —

  const head = extractHead(html);
  if (head) {
    console.log('\n→ _meta.html');
    const filtered = filterMetaHead(head);
    const withAssets = await rewriteAndDownloadAssets(filtered, imgDir);
    await writePartial(root, '_meta', withAssets, force);
  } else {
    console.log('  !  no <head> found in source');
  }

  const nav = extractNav(html);
  if (nav) {
    console.log('\n→ _nav.html');
    const filtered = filterBodyChunk(nav);
    const withAssets = await rewriteAndDownloadAssets(filtered, imgDir);
    await writePartial(root, '_nav', withAssets, force);
  } else {
    console.log('  !  no header/nav block found');
  }

  const footer = extractFooter(html);
  if (footer) {
    console.log('\n→ _footer.html');
    const filtered = filterBodyChunk(footer);
    const withAssets = await rewriteAndDownloadAssets(filtered, imgDir);
    await writePartial(root, '_footer', withAssets, force);
  } else {
    console.log('  !  no <footer> block found');
  }

  // — Page main slot —

  const main = extractMain(html);
  if (main) {
    console.log(`\n→ ${page}.html (main slot)`);
    const filtered = filterBodyChunk(main);
    const withAssets = await rewriteAndDownloadAssets(filtered, imgDir);
    await writePageMain(root, page, withAssets, force);
  } else {
    console.log(`  !  no <main> / content block found for ${page}`);
  }

  console.log('\nDone. Review src/html/, run `npm run build`, then `npm run dev`.');
}
