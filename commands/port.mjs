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
import {
  composeMainImports,
  dumpStylesheetName,
  findUndefinedVariables,
  MAIN_LESS_MARKER,
  W2F_STUBS_NAME,
} from '../lib/less.mjs';
import { composeAppImports, APP_JS_MARKER } from '../lib/js.mjs';
import { writeSkeletonHtml } from './convert.mjs';

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
    // Weebly themes wrap the menu strip in <div class="nav-wrap"> sitting
    // outside any semantic header — common enough to deserve an early hit.
    h => extractByIdOrClass(h, 'nav-wrap'),
    h => extractByIdOrClass(h, 'wsite-menu-wrap'),
    h => extractByIdOrClass(h, 'wsite-header-section'),
    h => extractByIdOrClass(h, 'wsite-header'),
    h => extractByIdOrClass(h, 'main-nav'),
    h => extractByIdOrClass(h, 'site-nav'),
    h => extractByIdOrClass(h, 'header'),
  ]);
}

function extractFooter(html) {
  return tryEach(html, [
    h => extractTag(h, 'footer'),
    h => extractByIdOrClass(h, 'wsite-footer-section'),
    h => extractByIdOrClass(h, 'wsite-footer'),
    h => extractByIdOrClass(h, 'site-footer'),
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
  return /\.(?:png|jpe?g|gif|webp|avif|svg|ico)(?:\?|$|#|%3[Ff])/i.test(u);
}

/**
 * Derive a clean local filename from a remote URL. Weebly URLs are full of
 * noise we don't want on disk:
 *   - cache-busting query strings (`?1560895278`)
 *   - those same strings double-encoded in the HTML (`%3F1560895278`)
 *   - URL-encoded path segments (`my%20file.png`)
 *
 * Strategy: pull the last path segment, decode it, then strip everything from
 * the first `?` or `#` onward. The double-decode is what makes the encoded
 * cache-buster case work — the encoded `%3F` becomes `?` after decode and
 * gets stripped along with the rest.
 *
 * Returns null when the URL has no usable segment (root URL, malformed, etc.).
 */
function basenameFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (!seg) return null;
    // Decode percent-encoding once (handles %20 → space, %3F → ?).
    let name;
    try { name = decodeURIComponent(seg); } catch { name = seg; }
    // Strip the cache-buster / fragment suffix that may now be present.
    name = name.split(/[?#]/)[0].trim();
    // A handful of Weebly URLs land with trailing dots or stray whitespace —
    // both unsafe on macOS / lossy on some Firebase rewrites.
    name = name.replace(/[\s.]+$/, '');
    return name || null;
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
 * Walk all image-looking URLs in `html`, download each to `gfxDir`, and
 * return the rewritten HTML. URLs we can't fetch are left untouched so the
 * user sees them in the source and can address them by hand.
 */
async function rewriteAndDownloadAssets(html, gfxDir) {
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
    const local = await downloadOne(url, gfxDir);
    if (local) downloads.set(url, local);
  }
  const ok = [...downloads.entries()].filter(([, v]) => v).length;
  if (downloads.size) console.log(`    ${ok}/${downloads.size} images downloaded`);

  // 3. Rewrite occurrences. Only URLs we successfully downloaded get
  //    rewritten — leave broken ones visible.
  const rewriteOne = u => {
    const local = downloads.get(u);
    return local ? `/assets/gfx/${local}` : u;
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
 * Font extraction
 *
 * Linked stylesheets in <head> often live on external CDNs (Weebly's own
 * cdn1.editmysite.com, Google Fonts, …) and are NOT in the crawled mirror —
 * `w2f crawl` runs wget with --domains locked to the user's host, and
 * --page-requisites doesn't recursively follow @font-face url() inside
 * CSS files either way. So we fetch the linked stylesheets live at port
 * time, harvest @font-face declarations, download the actual font files
 * into public/assets/fonts/, and emit src/less/_fonts.less for the LESS
 * build to import.
 * ────────────────────────────────────────────────────────────────────────── */

const FONT_EXT_RE = /\.(?:woff2?|ttf|otf|eot|svg)(?:\?|$)/i;
const LINK_TAG_RE = /<link\b[^>]*?>/gi;

async function fetchText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`    ! ${url} → ${res.status}`); return null; }
    return await res.text();
  } catch (err) {
    console.log(`    ! ${url} → ${err.message}`);
    return null;
  }
}

/** Pull href= from every <link rel=stylesheet>, regardless of attribute order. */
function findLinkedStylesheets(headHtml) {
  const urls = new Set();
  for (const m of headHtml.matchAll(LINK_TAG_RE)) {
    if (!/rel=["']?stylesheet["']?/i.test(m[0])) continue;
    const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (href && !href.startsWith('data:')) urls.add(href);
  }
  return [...urls];
}

function extractFontFaces(cssText) {
  return [...cssText.matchAll(/@font-face\s*\{[\s\S]*?\}/gi)].map(m => m[0]);
}

function findFontUrlsInFace(faceBlock, baseUrl) {
  const out = [];
  for (const m of faceBlock.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    const raw = m[1];
    if (raw.startsWith('data:')) continue;
    let absolute;
    try { absolute = new URL(raw, baseUrl).href; } catch { continue; }
    if (FONT_EXT_RE.test(absolute)) out.push({ raw, absolute });
  }
  return out;
}

/** Download every font URL referenced by `face` and rewrite to /assets/fonts/. */
async function downloadFontsInFace(face, baseUrl, fontDir) {
  let out = face;
  for (const { raw, absolute } of findFontUrlsInFace(face, baseUrl)) {
    const local = await downloadOne(absolute, fontDir);
    if (local) out = out.split(raw).join(`/assets/fonts/${local}`);
  }
  return out;
}

/**
 * Find variables used by any LESS file but defined by none, and write
 * `_w2f-undefined.less` with stub definitions so the LESS build doesn't
 * fail with "undefined variable" errors. These are typically Weebly editor
 * tokens (`@shade`, `@text`, …) that the static export references but
 * never actually writes to disk.
 *
 * Each stub is initialized to `transparent` with a TODO comment naming the
 * referencing files — visible enough on hover/background usage that the
 * user notices, harmless enough not to crash on size/border properties.
 */
async function portUndefinedVariables(root, force) {
  console.log('\n→ _w2f-undefined.less');
  const lessDir = path.join(root, 'src/less');
  if (!(await exists(lessDir))) {
    console.log('  !  src/less/ missing — skipping');
    return;
  }
  // Read every LESS file except the one we're about to write and main.less
  // itself (main.less is just imports — including it would double-count).
  const stubFilename = `${W2F_STUBS_NAME}.less`;
  const filenames = (await fs.readdir(lessDir))
    .filter(f => f.endsWith('.less') && f !== stubFilename && f !== 'main.less');
  const files = await Promise.all(filenames.map(async name => ({
    name,
    content: await fs.readFile(path.join(lessDir, name), 'utf8'),
  })));
  const undef = findUndefinedVariables(files);
  if (!undef.length) {
    console.log('  ok all referenced variables are defined');
    return;
  }
  const dest = path.join(lessDir, stubFilename);
  if (await exists(dest) && !force) {
    const existing = await fs.readFile(dest, 'utf8');
    if (!MAIN_LESS_MARKER.test(existing)) {
      console.log(`  skip src/less/${stubFilename} (hand-edited; use --force)`);
      return;
    }
  }
  // Build a `var → [referencing files]` map so each stub names its origin —
  // makes "what value should this be?" answerable from the comment alone.
  const refs = new Map(undef.map(v => [v, []]));
  for (const { name, content } of files) {
    for (const m of content.matchAll(/@([a-zA-Z_][\w-]*)\b/g)) {
      if (refs.has(m[1]) && !refs.get(m[1]).includes(name)) refs.get(m[1]).push(name);
    }
  }
  const stubs = undef.map(v => {
    const where = refs.get(v).join(', ');
    return `@${v}: transparent; // TODO: used in ${where}`;
  }).join('\n');
  const body = `// _w2f-undefined.less — Generated by w2f port.
//
// Stub definitions for variables that Weebly's static export references
// but never defines (often editor-time tokens like @shade, @text). Each
// is initialized to \`transparent\` so the LESS build succeeds; replace
// with real values, ideally inside variables.less.
//
// Re-generated on every \`w2f port\` while this marker is present.

${stubs}
`;
  await fs.writeFile(dest, body);
  console.log(`  +    src/less/${stubFilename} (${undef.length} stub${undef.length === 1 ? '' : 's'}: ${undef.join(', ')})`);
}

/**
 * Write src/js/app.js — side-effect imports of every JS file in src/js/ in
 * the canonical order (plugins/vendor first, custom last). Mirrors the
 * main.less story: hand-edited app.js survives subsequent ports unless
 * `--force` is on. Order rules live in lib/js.mjs.
 */
async function portAppJs(root, force) {
  console.log('\n→ app.js');
  const jsDir = path.join(root, 'src/js');
  if (!(await exists(jsDir))) {
    console.log('  !  src/js/ missing — skipping app.js');
    return;
  }
  const present = (await fs.readdir(jsDir)).filter(f => f.endsWith('.js'));
  const dest = path.join(jsDir, 'app.js');
  if (await exists(dest) && !force) {
    const existing = await fs.readFile(dest, 'utf8');
    if (!APP_JS_MARKER.test(existing)) {
      console.log('  skip src/js/app.js (hand-edited; use --force)');
      return;
    }
  }
  const imports = composeAppImports(present);
  if (!imports.length) {
    console.log('  !  no JS files in src/js/ to import');
    return;
  }
  const body = `// app.js — Generated by w2f port.
//
// Side-effect imports of the Weebly JS files in load order. Rollup inlines
// each script into the IIFE bundle. Re-generated on every \`w2f port\`
// while this marker is present; delete the comment block to lock the file
// against further w2f rewrites.

${imports.map(f => `import './${f}';`).join('\n')}
`;
  await fs.writeFile(dest, body);
  console.log(`  +    src/js/app.js (${imports.length} imports)`);
}

/**
 * Write src/less/main.less with the canonical import order — but only when
 * either the file doesn't exist, was previously generated by w2f (marker
 * present), or `--force` is on. Hand-edited main.less files survive
 * subsequent ports.
 *
 * Composition rules live in lib/less.mjs so `convert` and `port` agree on
 * what the canonical entry-point looks like.
 */
async function portMainLess(root, force) {
  console.log('\n→ main.less');
  const lessDir = path.join(root, 'src/less');
  if (!(await exists(lessDir))) {
    console.log('  !  src/less/ missing — skipping main.less');
    return;
  }
  const present = new Set(
    (await fs.readdir(lessDir)).filter(f => f.endsWith('.less')),
  );
  const dest = path.join(lessDir, 'main.less');
  if (await exists(dest) && !force) {
    const existing = await fs.readFile(dest, 'utf8');
    if (!MAIN_LESS_MARKER.test(existing)) {
      console.log('  skip src/less/main.less (hand-edited; use --force)');
      return;
    }
  }
  const imports = composeMainImports(present);
  if (!imports.length) {
    console.log('  !  no canonical LESS files found in src/less/');
    return;
  }
  const lines = imports.map(name => `@import "${name}.less";`);
  const body = `// main.less — Generated by w2f port.
//
// Imports every variables*.less variant present, then the canonical Weebly
// LESS layer order. Re-generated on every \`w2f port\` while this marker is
// present; delete the comment block to lock the file against future
// w2f rewrites.

${lines.join('\n')}
`;
  await fs.writeFile(dest, body);
  console.log(`  +    src/less/main.less (${lines.length} imports)`);
}

/**
 * Strip @font-face blocks from a CSS body — they're harvested into
 * `_fonts.less` separately, no need to repeat them in the mirror dump.
 */
function stripFontFaces(css) {
  return css.replace(/@font-face\s*\{[\s\S]*?\}\s*/gi, '');
}

/**
 * Same-origin filter for "this is a real Weebly site stylesheet, dump it" vs
 * "this is a CDN webfont sheet, leave it to portFonts." We dump only files
 * whose URL host matches the user's live domain — CDN-served theme CSS lands
 * in `convert`'s territory, and Google-Fonts-style sheets are exclusively
 * font-face anyway.
 */
function isSameOriginCss(absUrl, host) {
  try { return new URL(absUrl).host === host; } catch { return false; }
}

/**
 * Rewrite `url(…)` references inside a dumped stylesheet body. Two transforms:
 *
 *   1. Image-extension URLs that we successfully downloaded get pointed at
 *      `/assets/gfx/<name>`. Same rule as the HTML rewriter — broken/foreign
 *      URLs stay visible.
 *   2. Relative paths are resolved against the stylesheet's own URL (CSS
 *      `url(...)` is relative to the .css file, not the host page).
 *
 * Font URLs are NOT touched here — they're already pulled into
 * `public/assets/fonts/` by `portFonts`, and the @font-face blocks containing
 * them are stripped out before this runs (see `stripFontFaces`).
 */
async function rewriteDumpCss(css, baseUrl, gfxDir) {
  const map = new Map();
  for (const m of css.matchAll(CSS_URL_RE)) {
    const raw = m[2];
    if (isLocalishUrl(raw) || !isImageUrl(raw)) continue;
    let abs;
    try { abs = new URL(raw, baseUrl).href; } catch { continue; }
    if (!map.has(raw)) map.set(raw, abs);
  }
  const downloaded = new Map();
  for (const [raw, abs] of map.entries()) {
    const local = await downloadOne(abs, gfxDir);
    if (local) downloaded.set(raw, local);
  }
  return css.replace(CSS_URL_RE, (_, q, u) => {
    const local = downloaded.get(u);
    return local ? `url(${q}/assets/gfx/${local}${q})` : `url(${q}${u}${q})`;
  });
}

/**
 * Pull every same-origin linked stylesheet from the page head, drop @font-face
 * declarations (those go to _fonts.less), download any referenced images, and
 * write the result to `src/less/_w2f-<basename>.less`.
 *
 * This is the "wget as source of truth" pillar: even without a WeeblyExport
 * theme to crib LESS source files from, the project ends up with usable CSS
 * after `port`. When the user *does* run `convert` later, the cleaner
 * structured partials (`variables.less`, `_global.less`, …) compose AFTER
 * the dump in main.less and override it rule-by-rule.
 *
 * Same-origin only — CDN-hosted theme sheets are usually webfont catalogs
 * (handled by portFonts) and dragging them in as inline LESS adds nothing
 * the build needs.
 */
async function portMirrorStyles(root, headHtml, baseUrl, gfxDir, force) {
  console.log('\n→ _w2f-*.less (mirror stylesheets)');
  const links = findLinkedStylesheets(headHtml);
  if (!links.length) {
    console.log('  !  no <link rel=stylesheet> in head');
    return;
  }
  let host;
  try { host = new URL(baseUrl).host; } catch { host = ''; }
  const lessDir = path.join(root, 'src/less');
  await fs.mkdir(lessDir, { recursive: true });

  let dumped = 0;
  for (const link of links) {
    let absLink;
    try { absLink = new URL(link, baseUrl).href; } catch { continue; }
    if (!isSameOriginCss(absLink, host)) continue;
    const css = await fetchText(absLink);
    if (!css) continue;
    const stripped = stripFontFaces(css).trim();
    if (!stripped) continue; // sheet was pure @font-face
    const name = dumpStylesheetName(absLink);
    const dest = path.join(lessDir, `${name}.less`);
    if (await exists(dest) && !force) {
      const existing = await fs.readFile(dest, 'utf8');
      if (!MAIN_LESS_MARKER.test(existing)) {
        console.log(`  skip src/less/${name}.less (hand-edited; use --force)`);
        continue;
      }
    }
    const rewritten = await rewriteDumpCss(stripped, absLink, gfxDir);
    const body = `// ${name}.less — Generated by w2f port from ${absLink}.
//
// Raw compiled CSS from the wget mirror. Imported between variables/stubs
// and the canonical Weebly partials in main.less — structured partials (from
// \`w2f convert\`, if you have a WeeblyExport) override rules in here.
//
// Progressively replace these rules with cleaner LESS source files and
// shrink this file down. Re-generated on every \`w2f port\` while this
// marker is present; delete the marker to lock the file.

${rewritten}
`;
    await fs.writeFile(dest, body);
    console.log(`  +    src/less/${name}.less (${Math.round(rewritten.length / 1024)} KB)`);
    dumped++;
  }
  if (!dumped) console.log('  !  no same-origin stylesheets dumped');
}

/**
 * Visit every linked stylesheet, harvest @font-face declarations, download
 * the font files, and write the resulting block to src/less/_fonts.less.
 * Skipped silently when no stylesheets / no @font-face show up — the user's
 * site may not use webfonts at all.
 */
async function portFonts(root, headHtml, baseUrl, force) {
  console.log('\n→ _fonts.less');
  const links = findLinkedStylesheets(headHtml);
  if (!links.length) {
    console.log('  !  no <link rel=stylesheet> in head');
    return;
  }
  const fontDir = path.join(root, 'public/assets/fonts');
  const faces = [];
  for (const link of links) {
    let absLink;
    try { absLink = new URL(link, baseUrl).href; } catch { continue; }
    console.log(`  · ${absLink}`);
    const css = await fetchText(absLink);
    if (!css) continue;
    const found = extractFontFaces(css);
    if (!found.length) continue;
    for (const face of found) faces.push(await downloadFontsInFace(face, absLink, fontDir));
    console.log(`    ${found.length} @font-face`);
  }
  if (!faces.length) {
    console.log('  !  no @font-face declarations harvested');
    return;
  }
  const dest = path.join(root, 'src/less/_fonts.less');
  if (await exists(dest) && !force) {
    console.log('  skip src/less/_fonts.less (exists; use --force)');
    return;
  }
  const body = `// _fonts.less — @font-face declarations ported by \`w2f port\`.
// Font files downloaded into public/assets/fonts/.
// Re-run with \`w2f port --force\` to refresh.

${faces.join('\n\n')}
`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body);
  console.log(`  +    src/less/_fonts.less (${faces.length} @font-face)`);
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

/**
 * Walk the crawled mirror and return a sorted list of top-level page names
 * (no extension, no subdirectories). Subdirs are skipped with a warning —
 * Weebly's blog feature can produce nested URLs but they need bespoke
 * handling and would otherwise pollute src/html/ with sibling files whose
 * names collide. The user can port them by passing the explicit path.
 *
 * `index.html` always sorts first when present so partials get extracted
 * from the homepage (typically the richest source of nav/footer markup).
 */
async function discoverPagesInMirror(mirrorDir) {
  const entries = await fs.readdir(mirrorDir, { withFileTypes: true });
  const pages = [];
  const skippedDirs = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      skippedDirs.push(e.name);
      continue;
    }
    if (!e.isFile()) continue;
    if (!/\.html?$/i.test(e.name)) continue;
    // Strip extension. wget's --adjust-extension may write .php.html /
    // .asp.html — we just want the bare stem since that's our skeleton name.
    const stem = e.name.replace(/\.html?$/i, '');
    if (!stem) continue;
    pages.push(stem);
  }
  if (skippedDirs.length) {
    console.log(`  (skipping nested mirror dirs: ${skippedDirs.join(', ')} — port by hand if needed)`);
  }
  // index first, then alphabetical. Stable order keeps subsequent re-runs
  // diff-clean in the user's terminal.
  pages.sort((a, b) => {
    if (a === 'index') return -1;
    if (b === 'index') return 1;
    return a.localeCompare(b);
  });
  return pages;
}

/**
 * Run the once-per-mirror setup: harvest fonts, dump mirror CSS, scan for
 * undefined LESS variables, regenerate main.less + app.js, and write the
 * three shared partials (_meta, _nav, _footer). All gated on the marker /
 * skeleton checks that already protect against clobbering hand-edits.
 *
 * Separated from per-page main extraction so `--all` can run this once
 * (against the index page's head/nav/footer, which on Weebly is shared
 * across every page) instead of re-fetching the same CSS for every page.
 */
async function portSetupFromIndex(root, html, baseUrl, gfxDir, force) {
  const head = extractHead(html);
  if (head) {
    // Fonts first — uses the *unfiltered* head so external <link
    // rel=stylesheet> tags are still discoverable before filterMetaHead
    // strips them. Base URL is the user's live host so any relative
    // stylesheet hrefs resolve correctly.
    await portFonts(root, head, baseUrl, force);
    // Same-origin stylesheets, dumped as LESS partials so the project is
    // buildable even when the user hasn't dropped a WeeblyExport into
    // reference/. composeMainImports picks them up automatically.
    await portMirrorStyles(root, head, baseUrl, gfxDir, force);
    // Undefined-variable stubs go on disk BEFORE main.less composes so the
    // generated entry-point picks them up via composeMainImports().
    await portUndefinedVariables(root, force);
    await portMainLess(root, force);
    await portAppJs(root, force);

    console.log('\n→ _meta.html');
    const filtered = filterMetaHead(head);
    const withAssets = await rewriteAndDownloadAssets(filtered, gfxDir);
    await writePartial(root, '_meta', withAssets, force);
  } else {
    console.log('  !  no <head> found in source');
  }

  const nav = extractNav(html);
  if (nav) {
    console.log('\n→ _nav.html');
    const filtered = filterBodyChunk(nav);
    const withAssets = await rewriteAndDownloadAssets(filtered, gfxDir);
    await writePartial(root, '_nav', withAssets, force);
  } else {
    console.log('  !  no header/nav block found');
  }

  const footer = extractFooter(html);
  if (footer) {
    console.log('\n→ _footer.html');
    const filtered = filterBodyChunk(footer);
    const withAssets = await rewriteAndDownloadAssets(filtered, gfxDir);
    await writePartial(root, '_footer', withAssets, force);
  } else {
    console.log('  !  no <footer> block found');
  }
}

/**
 * Extract a single page's <main> block and overwrite src/html/<page>.html's
 * main slot. Falls back to scaffolding a skeleton when the page doesn't
 * exist yet (`port --all` discovers pages not in convert's fixed list).
 */
async function portPageMain(root, domain, page, html, gfxDir, force) {
  const main = extractMain(html);
  if (!main) {
    console.log(`  !  no <main> / content block found for ${page}`);
    return;
  }
  const dest = path.join(root, 'src/html', `${page}.html`);
  if (!(await exists(dest))) {
    // Scaffold from the same template `convert` writes. Reference points at
    // the mirror file so the porter knows what to compare against.
    await writeSkeletonHtml(root, page, `reference/${domain}/${page}.html`);
  }
  console.log(`\n→ ${page}.html (main slot)`);
  const filtered = filterBodyChunk(main);
  const withAssets = await rewriteAndDownloadAssets(filtered, gfxDir);
  await writePageMain(root, page, withAssets, force);
}

export async function run(flags = {}, positionals = []) {
  const root = resolveTarget(flags.target);
  const force = !!flags.force;
  const all = !!flags.all;

  // Resolve which crawled mirror to read. Flag wins, otherwise cache.
  // Normalize defensively — older caches may have stored the raw user input
  // (with `https://` or a trailing slash), but wget writes the mirror into
  // a directory named with just the bare host.
  const cached = await readJson(path.join(root, '.weebly-migrate.json'));
  const domain = normalizeDomain(flags.domain || cached.liveDomain);
  if (!domain) {
    throw new Error('No domain available. Pass --domain or run `init` first to cache one.');
  }

  const mirrorDir = path.join(root, 'reference', domain);
  if (!(await exists(mirrorDir))) {
    throw new Error(`Mirror not found: ${mirrorDir}. Run \`w2f crawl ${domain}\` first.`);
  }

  const gfxDir = path.join(root, 'public/assets/gfx');
  const baseUrl = `https://${domain}/`;

  // — Decide the list of pages to port —
  //
  // --all walks the mirror and ports everything; otherwise honor the
  // positional (default index). When --all is set, positionals are
  // ignored — the user's already opted into "everything you can find."
  let pages;
  if (all) {
    pages = await discoverPagesInMirror(mirrorDir);
    if (!pages.length) {
      throw new Error(`No .html files in ${mirrorDir}. Run \`w2f crawl ${domain}\` first.`);
    }
    console.log(`\nFound ${pages.length} page${pages.length === 1 ? '' : 's'} in reference/${domain}/: ${pages.join(', ')}`);
  } else {
    pages = [positionals[0] || 'index'];
  }

  // — One-time setup, sourced from the first page (typically index) —
  //
  // Nav/footer/head are shared across Weebly pages, so we extract them
  // from one page and reuse for all. The single-page path also runs setup
  // (gated by markers; no-op once the first port has landed).
  const setupPage = pages[0];
  const setupSourcePath = path.join(mirrorDir, `${setupPage}.html`);
  if (!(await exists(setupSourcePath))) {
    throw new Error(`Crawled page not found: ${setupSourcePath}.`);
  }
  console.log(`\nPorting setup from reference/${domain}/${setupPage}.html`);
  const setupHtml = await fs.readFile(setupSourcePath, 'utf8');
  await portSetupFromIndex(root, setupHtml, baseUrl, gfxDir, force);

  // — Per-page main slot extraction —
  //
  // Includes the setup page itself, since portSetupFromIndex only wrote
  // partials + global config, not the page's own <main>.
  for (const page of pages) {
    const sourcePath = path.join(mirrorDir, `${page}.html`);
    if (!(await exists(sourcePath))) {
      console.log(`  !  missing ${sourcePath} — skipping`);
      continue;
    }
    const html = page === setupPage ? setupHtml : await fs.readFile(sourcePath, 'utf8');
    await portPageMain(root, domain, page, html, gfxDir, force);
  }

  console.log('\nDone. Review src/html/, run `npm run build`, then `npm run dev`.');
}
