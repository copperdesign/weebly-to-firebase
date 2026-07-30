/**
 * `weebly-to-firebase cms` — scaffold the Sveltia CMS layer and lift each
 * ported page's `<main>` content into per-page section YAML.
 *
 * @docs README.md — see the "cms options" section and the CMS workflow
 * paragraph for the full walkthrough: what gets scaffolded, the lift/marker
 * mechanic, the idempotency + --force rules, and the auth-relay note.
 *
 * What it does, per invocation:
 *   - Enumerates src/html/*.html (or the named page positionals), skipping
 *     `_`-prefixed partials — the same exclusion posthtml's build glob uses.
 *   - Per page: splits the ported `<main>` at h1/h2 boundaries (stopping at
 *     the first `<form>` — form markup and everything after it stays
 *     hand-authored), converts each section to markdown, writes
 *     `src/content/<page>.yml`, and swaps the lifted markup for
 *     `<!-- @render:sections -->` in `src/html/<page>.html`.
 *   - Once per run: writes the admin shell, `render-content.mjs`,
 *     `docs/cms.md` (writeIfMissing), registers every processed page in
 *     `public/admin/config.yml`, and wires `package.json` for the build-time
 *     render step + `yaml`/`marked` devDeps.
 *
 * Idempotency mirrors `port`: a page already carrying the render marker is
 * left alone (its content is gone from the HTML, so there's nothing left to
 * re-lift even with `--force` — see the marker-present branch below); a page
 * whose `src/content/<page>.yml` already exists is skipped unless `--force`.
 * Named positionals get thrown errors instead of skip logs where enumeration
 * would otherwise silently continue — an explicit ask deserves an explicit
 * failure. Throws only for these "nothing useful can happen" preconditions;
 * everything else logs and continues.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveTarget } from '../lib/target.mjs';
import { exists } from '../lib/fs-utils.mjs';
import { extractTag, isSkeleton, splitAtHeadings, topLevelElements, stripComments, textContent, decodeEntities } from '../lib/extract.mjs';
import { htmlToMarkdown, encodeMarkdownUrl, decodeMarkdownUrl } from '../lib/html-markdown.mjs';
import {
  RENDER_MARKER,
  isRendered,
  pageYaml,
  adminIndexHtml,
  configYml,
  configYmlAddPage,
  renderContentMjs,
  applyCmsToPackageJson,
  cmsDocsMd,
} from '../lib/cms-templates.mjs';

async function readJson(p, fallback = {}) {
  if (!(await exists(p))) return fallback;
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return fallback; }
}

/** Write file only if it doesn't already exist. Same semantics as init.mjs's helper. */
async function writeIfMissing(root, relPath, contents) {
  const filePath = path.join(root, relPath);
  if (await exists(filePath)) {
    console.log(`  skip ${relPath} (exists)`);
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
  console.log(`  +    ${relPath}`);
  return true;
}

/**
 * Top-level page slugs in src/html/: `.html` files, `_`-prefixed partials
 * excluded (posthtml's `src/html/[!_]*.html` build glob convention). `index`
 * sorts first, then alphabetical — same ordering rule as port.mjs's
 * discoverPagesInMirror, kept here purely for stable, diff-clean re-runs.
 */
async function discoverPages(htmlDir) {
  const entries = await fs.readdir(htmlDir, { withFileTypes: true });
  // Keep the real filename alongside the slug — `.htm` is accepted too, and
  // reading `${page}.html` for a page that lives in `about.htm` would ENOENT
  // mid-run.
  const pages = entries
    .filter(e => e.isFile() && /\.html?$/i.test(e.name) && !e.name.startsWith('_'))
    .map(e => ({ page: e.name.replace(/\.html?$/i, ''), file: e.name }));
  pages.sort((a, b) => {
    if (a.page === 'index') return -1;
    if (b.page === 'index') return 1;
    return a.page.localeCompare(b.page);
  });
  return pages;
}

/** Resolve a named page positional to its on-disk filename (.html or .htm). */
async function resolvePageFile(htmlDir, page) {
  for (const ext of ['html', 'htm']) {
    if (await exists(path.join(htmlDir, `${page}.${ext}`))) return `${page}.${ext}`;
  }
  return null;
}

/**
 * The first `<img>` in a section body becomes the section's `image` field
 * (stripped from the body) only when it's the section's *only* image AND it
 * sits alone in its own `<p>`/`<figure>` block — i.e. immediately after the
 * open tag and immediately before the matching close tag, ignoring
 * whitespace. An image sharing a paragraph with text stays inline (handled
 * by htmlToMarkdown's `![alt](src)` conversion instead). Built on string
 * indices rather than a regex assembled from the matched tag text — the tag
 * can contain arbitrary attribute values, and turning arbitrary content into
 * a regex source is its own bug class.
 */
function extractSectionImage(bodyHtml) {
  const matches = [...bodyHtml.matchAll(/<img\b[^>]*>/gi)];
  if (matches.length !== 1) return { image: null, body: bodyHtml };
  const [tag] = matches;
  const start = tag.index;
  const end = start + tag[0].length;
  const before = bodyHtml.slice(0, start);
  const after = bodyHtml.slice(end);
  const openMatch = before.match(/<(p|figure)\b[^>]*>\s*$/i);
  if (!openMatch) return { image: null, body: bodyHtml };
  const wrapper = openMatch[1].toLowerCase();
  const closeMatch = after.match(new RegExp(`^\\s*<\\/${wrapper}>`, 'i'));
  if (!closeMatch) return { image: null, body: bodyHtml };
  const src = tag[0].match(/\ssrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  const wrapStart = before.length - openMatch[0].length;
  const wrapEnd = end + closeMatch[0].length;
  const body = bodyHtml.slice(0, wrapStart) + bodyHtml.slice(wrapEnd);
  return { image: decodeEntities(src), body };
}

/**
 * Copy a root-relative asset reference (e.g. `/assets/gfx/team.jpg`, wherever
 * `port` put it) into `public/assets/files/<basename>` — the Sveltia media
 * library convention — and return the rewritten `/assets/files/<basename>`
 * reference. External URLs and protocol-relative URLs (`//host/...`) pass
 * through untouched; so does anything whose source file can't be found on
 * disk. `assetMap` is scoped to one `cms` run: it tracks which source path
 * claimed each basename so a second, *different* source with the same
 * basename is flagged as a collision and left unrewritten rather than
 * silently overwriting the first copy.
 */
async function resolveAssetRef(root, src, assetMap) {
  if (!src || !src.startsWith('/') || src.startsWith('//')) return src;
  // Markdown refs arrive percent-encoded (encodeMarkdownUrl — parens in
  // Weebly's duplicate-upload filenames); decode for filesystem lookups,
  // callers re-encode for the context they write into.
  const clean = decodeMarkdownUrl(src.split('?')[0].split('#')[0]);
  const basename = path.basename(clean);
  if (!basename) return src;
  const sourcePath = path.join(root, 'public', clean);
  if (!(await exists(sourcePath))) {
    console.log(`  !  asset not found: ${src} — left unrewritten`);
    return src;
  }
  const claimedBy = assetMap.get(basename);
  if (claimedBy && claimedBy !== sourcePath) {
    console.log(`  !  name collision: ${basename} — left ${src} unrewritten`);
    return src;
  }
  assetMap.set(basename, sourcePath);
  const destPath = path.join(root, 'public/assets/files', basename);
  if (!(await exists(destPath))) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(sourcePath, destPath);
  }
  return `/assets/files/${basename}`;
}

/**
 * Rewrite every `![alt](src)` reference in converted markdown through
 * `resolveAssetRef`. Manual splice (not `String.replace`) because the
 * replacement is async — `replace()` has no async-replacer form — which
 * conveniently also means there's no `$`-token expansion to guard against
 * here (nothing here is a *replacement string*, it's plain concatenation).
 */
async function rewriteMarkdownImages(markdown, root, assetMap) {
  const re = /!\[([^\]]*)\]\(([^)]*)\)/g;
  let result = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(markdown))) {
    const [full, alt, src] = m;
    const rewritten = await resolveAssetRef(root, src, assetMap);
    result += markdown.slice(lastIndex, m.index) + `![${alt}](${encodeMarkdownUrl(decodeMarkdownUrl(rewritten))})`;
    lastIndex = m.index + full.length;
  }
  return result + markdown.slice(lastIndex);
}

/** Turn one raw `{ headingText, body, level?, headingTodo? }` section into pageYaml's expected shape. */
async function buildSectionYamlData(root, raw, assetMap) {
  const { image: extractedImage, body: strippedBody } = extractSectionImage(raw.body);
  const { markdown, unconvertible } = htmlToMarkdown(strippedBody);
  const body = await rewriteMarkdownImages(markdown, root, assetMap);
  const section = { heading: raw.headingText || '', body, draft: false };
  if (extractedImage) section.image = await resolveAssetRef(root, extractedImage, assetMap);
  if (raw.level === 1) section.level = 1; // preserve the page's <h1> through the render
  if (raw.headingTodo) section.headingTodo = raw.headingTodo;
  if (unconvertible) section.bodyTodo = 'TODO(w2f): verify — contains raw HTML passthrough';
  return section;
}

/**
 * Weebly wraps page content in `.banner-wrap`/`.main-wrap`-style divs, so a
 * page's h1/h2s usually sit one or two levels down — where the top-level-only
 * splitAtHeadings (rightly) refuses to cut. Descend: while no top-level
 * headings exist but exactly ONE top-level element contains every heading,
 * step inside it, accumulating the wrapper markup as page-side prefix/suffix
 * that stays hand-authored around the marker (chrome stays chrome — and the
 * fragments stay balanced, which is the whole point).
 *
 * When headings are scattered across sibling wrappers, sectioning cleanly
 * without cutting through a wrapper is impossible — return the current
 * fragment as-is; the caller lifts it as a single flagged section.
 */
function descendToHeadingSections(liftRegion) {
  let prefix = '';
  let suffix = '';
  let inner = liftRegion;
  for (let hop = 0; hop < 12; hop++) {
    const { lead, sections } = splitAtHeadings(inner);
    if (sections.length || !/<h[12]\b/i.test(inner)) {
      return { prefix, suffix, lead, sections, interleaved: false };
    }
    const withHeadings = topLevelElements(inner)
      .filter(el => /<h[12]\b/i.test(inner.slice(el.start, el.end)));
    if (withHeadings.length !== 1) {
      return { prefix, suffix, lead: inner, sections: [], interleaved: true };
    }
    const el = withHeadings[0];
    prefix += inner.slice(0, el.innerStart);
    suffix = inner.slice(el.innerEnd) + suffix;
    inner = inner.slice(el.innerStart, el.innerEnd);
  }
  return { prefix, suffix, lead: inner, sections: [], interleaved: true };
}

/**
 * Process one page. Returns `null` when the page shouldn't be registered in
 * config.yml at all (still a port skeleton, no `<main>`, or nothing to
 * lift), or `{ lifted: boolean }` when it should — `lifted` distinguishes
 * fresh extraction (this run) from an already-done page kept for the
 * summary counts. Named pages throw instead of logging + continuing on the
 * two preconditions that make lifting impossible outright; enumerated pages
 * just skip and move on to the next one.
 */
async function processPage({ root, page, file, named, force, htmlDir, assetMap }) {
  const filePath = path.join(htmlDir, file);
  const html = await fs.readFile(filePath, 'utf8');
  const main = extractTag(html, 'main');
  if (main === null) {
    if (named) throw new Error(`src/html/${file} has no <main> slot.`);
    console.log('  !  no <main> slot — skipping');
    return null;
  }
  if (isSkeleton(main)) {
    if (named) throw new Error(`src/html/${file} is still the port skeleton — run \`w2f port\` first.`);
    console.log('  !  still the port skeleton — run `w2f port` first');
    return null;
  }

  const contentPath = path.join(root, 'src/content', `${page}.yml`);
  const ymlExists = await exists(contentPath);

  if (isRendered(main)) {
    if (!force && ymlExists) {
      console.log(`  skip ${page} (already lifted)`);
      return { lifted: false };
    }
    // Either --force (which can't help — the content is already gone from
    // the HTML, only the marker remains) or the yml was deleted out from
    // under an already-lifted page. Same message either way per the plan:
    // there is nothing left in the HTML to re-extract from.
    console.log('  !  marker present — restore page HTML from git to re-extract');
    return { lifted: false };
  }

  if (ymlExists && !force) {
    console.log(`  skip src/content/${page}.yml (exists)`);
    return { lifted: false };
  }

  // Lift stops at the first <form> — form markup and everything after it is
  // hand-authored territory (the `forms` command owns it).
  const formIdx = main.search(/<form\b/i);
  const liftRegion = formIdx === -1 ? main : main.slice(0, formIdx);
  const tail = formIdx === -1 ? '' : main.slice(formIdx);

  if (!liftRegion.trim()) {
    console.log('  !  nothing to lift — skipping');
    return null;
  }

  const { prefix, suffix, lead, sections, interleaved } = descendToHeadingSections(liftRegion);
  let rawSections;
  if (sections.length === 0) {
    // One flagged single section, heading left EMPTY so the rendered page
    // stays byte-faithful to the original (an invented <h2> would fail the
    // round-trip guarantee). Two ways here: genuinely heading-less pages
    // (title suggestion in the TODO), or headings scattered across sibling
    // wrappers that can't be sectioned without cutting a wrapper open.
    // Comments out first: a commented-out <title> earlier in the head would
    // anchor extractTag inside the comment and bleed "--> …" into the suggestion.
    const titleSuggestion = textContent(extractTag(stripComments(html), 'title') || '');
    rawSections = [{
      headingText: '',
      body: lead,
      headingTodo: interleaved
        ? 'TODO(w2f): headings too deeply interleaved to section — lifted as a single block; heading left empty'
        : `TODO(w2f): page had no h1/h2 — heading left empty; page <title> is ${JSON.stringify(titleSuggestion)}`,
    }];
    if (interleaved) console.log('  !  headings interleaved across wrappers — lifted as a single flagged section');
  } else {
    rawSections = sections.map(s => ({ headingText: s.headingText, body: s.body, level: s.level }));
    if (lead.trim()) rawSections.unshift({ headingText: '', body: lead });
  }

  const yamlSections = [];
  for (const raw of rawSections) yamlSections.push(await buildSectionYamlData(root, raw, assetMap));

  await fs.mkdir(path.dirname(contentPath), { recursive: true });
  await fs.writeFile(contentPath, pageYaml(page, yamlSections));
  console.log(`  +    src/content/${page}.yml`);

  const openTagMatch = html.match(/<main\b[^>]*>/i);
  const openTag = openTagMatch[0];
  // Wrapper markup the descent kept page-side wraps the marker, so the
  // rendered sections land exactly where the lifted content came from and
  // the wrappers themselves stay hand-authored.
  const newMainBlock = `${openTag}${prefix}${RENDER_MARKER}\n${suffix}${tail}</main>`;
  // Replacement *function*, not a string — Weebly content routinely contains
  // literal `$`, and a string replacement would interpret `$&`/`$1`/etc. as
  // tokens (the same rule commands/port.mjs's writePageMain follows).
  const nextHtml = html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i, () => newMainBlock);
  await fs.writeFile(filePath, nextHtml);
  console.log(`  +    src/html/${file} (main replaced)`);

  return { lifted: true };
}

export async function run(flags = {}, positionals = []) {
  const root = resolveTarget(flags.target);
  const force = !!flags.force;
  const htmlDir = path.join(root, 'src/html');

  if (!(await exists(htmlDir))) {
    throw new Error(`No src/html/ found in ${root} — run \`w2f init\` (or \`w2f port\`) first.`);
  }

  let pageList;
  if (positionals.length) {
    pageList = [];
    for (const p of positionals) {
      const file = await resolvePageFile(htmlDir, p);
      if (!file) {
        throw new Error(`unknown page "${p}" — expected src/html/${p}.html (run \`w2f port\` first?)`);
      }
      pageList.push({ page: p, file, named: true });
    }
  } else {
    pageList = (await discoverPages(htmlDir)).map(({ page, file }) => ({ page, file, named: false }));
  }

  const assetMap = new Map();
  const processedPages = [];
  let liftedCount = 0;
  let skippedCount = 0;

  for (const { page, file, named } of pageList) {
    console.log(`\n→ ${page}`);
    const result = await processPage({ root, page, file, named, force, htmlDir, assetMap });
    if (result === null) continue;
    processedPages.push(page);
    if (result.lifted) liftedCount++;
    else skippedCount++;
  }

  console.log('\nScaffolding CMS:');
  await writeIfMissing(root, 'public/admin/index.html', adminIndexHtml());
  await writeIfMissing(root, 'scripts/render-content.mjs', renderContentMjs());
  await writeIfMissing(root, 'docs/cms.md', cmsDocsMd());

  // config.yml: fresh generation when absent AND at least one page was
  // processed — a zero-page `files:` list parses as null and Sveltia rejects
  // the whole config, which is worse than no config (e.g. when init runs cms
  // after port failed/was skipped). Deferred until the first real lift;
  // otherwise append whichever processed pages aren't registered yet.
  const configPath = path.join(root, 'public/admin/config.yml');
  if (!(await exists(configPath))) {
    if (processedPages.length) {
      const cached = await readJson(path.join(root, '.weebly-migrate.json'));
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, configYml(processedPages, { githubRepo: cached.githubRepo }));
      console.log('  +    public/admin/config.yml');
    } else {
      console.log('  !  config.yml deferred — no pages lifted yet (re-run `w2f cms` once `port` has produced content)');
    }
  } else if (processedPages.length) {
    let configContents = await fs.readFile(configPath, 'utf8');
    let appended = false;
    let markerMissing = false;
    for (const page of processedPages) {
      if (configContents.includes(`file: src/content/${page}.yml`)) continue; // already registered
      const next = configYmlAddPage(configContents, page);
      if (next === null) { markerMissing = true; continue; }
      configContents = next;
      appended = true;
    }
    if (appended) {
      await fs.writeFile(configPath, configContents);
      console.log('  +    public/admin/config.yml (pages appended)');
    }
    if (markerMissing) {
      console.log('  skip config.yml (marker removed; add page by hand)');
    } else if (!appended) {
      console.log('  ok   public/admin/config.yml (already registered)');
    }
  }

  const pkgPath = path.join(root, 'package.json');
  if (await exists(pkgPath)) {
    const pkgRaw = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const { pkg, changed } = applyCmsToPackageJson(pkgRaw);
    if (changed) {
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log('  +    package.json (build:content script + yaml/marked devDeps)');
    } else {
      console.log('  ok   package.json (already wired)');
    }
    if (!(pkg.scripts.build || '').includes('npm run build:content')) {
      console.log('  !  package.json "build" script has no `npm run build:html` to insert after — add `npm run build:content` to the chain by hand');
    }
  } else {
    console.log('  !  package.json missing — run init first');
  }

  console.log(`\n${liftedCount} page${liftedCount === 1 ? '' : 's'} lifted, ${skippedCount} skipped.`);
  console.log('next: npm i && npm run build');
  console.log('See docs/cms.md — /admin needs an auth relay configured before it can save to GitHub.');
}
