/**
 * Generated-file sources for the Sveltia CMS layer `w2f cms` scaffolds into
 * a ported project: the admin shell (`public/admin/index.html`), the pages
 * content model (`public/admin/config.yml`), per-page section YAML
 * (`src/content/<page>.yml`), the build-time content renderer
 * (`scripts/render-content.mjs`), the `package.json` wiring for it, and the
 * project-facing `docs/cms.md`.
 *
 * Mirrors `lib/scaffold-modules.mjs`'s shape — pure functions returning
 * file contents as strings; the caller (`commands/cms.mjs`) owns all fs
 * I/O, idempotency decisions, and logging. Unlike scaffold-modules' three
 * independent opt-in modules, cms is one cohesive feature, so it gets one
 * shared `docs/cms.md` instead of per-file `@docs` siblings (see
 * `cmsDocsMd()` below).
 *
 * The two YAML documents here are hand-rolled emitters, not templates fed
 * through a library: w2f itself stays zero-dependency (philosophy.md), and
 * w2f never needs to *parse* these files back — idempotency for cms is
 * file-existence + marker based, not content-diffing — so a string builder
 * is enough. `renderContentMjs()` is the one place `yaml` and `marked`
 * enter the picture, and only as devDependencies of the *scaffolded*
 * project, never of w2f.
 */

// ---------------------------------------------------------------------------
// Render marker — the hinge between src/html/<page>.html (permanent marker,
// committed source of truth) and public/<page>.html (marker swapped for
// rendered content on every build).
// ---------------------------------------------------------------------------

/**
 * Marks the point in a page's `<main>` where lifted section content is
 * re-injected at build time. `cms.mjs` writes this marker into
 * `src/html/<page>.html` in place of the extracted markup; it stays there
 * permanently. `render-content.mjs` (shipped into the scaffolded project)
 * looks for the same marker in the posthtml-built `public/<page>.html` and
 * swaps it for rendered HTML on every `npm run build`.
 *
 * `RENDER_MARKER_RE` is duplicated verbatim inside `renderContentMjs()`'s
 * source string below rather than imported — that script ships standalone
 * into the scaffolded project and must not depend on w2f at runtime. Keep
 * the two literals in sync if this ever changes.
 *
 * The definitions live in lib/extract.mjs (re-exported here) because `port`
 * needs the `isRendered` predicate too — `port --force` must refuse to
 * clobber a cms-lifted page whose content now lives only in YAML.
 */
export { RENDER_MARKER, RENDER_MARKER_RE, isRendered } from './extract.mjs';

// ---------------------------------------------------------------------------
// src/content/<page>.yml — hand-rolled YAML emission
// ---------------------------------------------------------------------------

/** Double-quoted YAML scalar with `\`, `"`, and embedded newlines escaped. */
function yamlQuotedString(value) {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Lines for one `sections:` list entry. Two independent TODO slots, each
 * rendered directly above the field it concerns — the two v1 extraction
 * uncertainties land in different places in the source HTML, so they need
 * different comment placement:
 *   - `headingTodo` — heading was left empty because the source had no
 *     h1/h2, e.g. 'TODO(w2f): page had no h1/h2 — heading left empty;
 *     page <title> is "…"' (the title is a suggestion only — rendering it
 *     would add a heading the original page never had).
 *     Placed above `heading:`, at the list item's own indent.
 *   - `bodyTodo` — body contains unconverted raw-HTML passthrough, e.g.
 *     "TODO(w2f): verify — contains raw HTML passthrough". Placed above
 *     `body:`.
 * `image` is omitted entirely when absent (not emitted as `image: null`).
 * `draft` always renders — Sveltia's boolean widget wants a concrete
 * default, and an explicit `false` is clearer to a client editor than a
 * missing key.
 */
function sectionLines(section) {
  const lines = [];
  if (section.headingTodo) lines.push(`  # ${section.headingTodo}`);
  lines.push(`  - heading: ${yamlQuotedString(section.heading || '')}`);
  if (section.bodyTodo) lines.push(`    # ${section.bodyTodo}`);
  lines.push('    body: |');
  for (const line of String(section.body ?? '').split('\n')) {
    // Blank lines inside a literal block scalar must stay truly empty —
    // trailing whitespace on an otherwise-blank line is the kind of diff
    // noise that makes hand-edited YAML painful to review.
    lines.push(line === '' ? '' : `      ${line}`);
  }
  // Quoted like heading — a filename with `: `, ` #`, or a leading YAML
  // indicator (& * ? etc.) would otherwise corrupt or truncate the scalar.
  if (section.image) lines.push(`    image: ${yamlQuotedString(section.image)}`);
  // Only h1 sections carry an explicit level — h2 is the renderer's default,
  // and omitting the common case keeps the YAML small for hand editing.
  if (Number(section.level) === 1) lines.push('    level: 1');
  lines.push(`    draft: ${section.draft ? 'true' : 'false'}`);
  return lines;
}

/**
 * Emit `src/content/<page>.yml`. w2f never parses this back — re-running
 * `w2f cms` skips a page whose content file already exists (file-existence
 * idempotency), and `--force` simply re-lifts and overwrites it — so a
 * hand-rolled emitter is all this needs to be.
 *
 * @param {string} page - page slug, no extension (e.g. "index", "about").
 * @param {Array<{
 *   heading: string,
 *   body: string,
 *   image?: string,
 *   level?: number,   // 1 = source heading was the page's <h1>; else h2
 *   draft?: boolean,
 *   headingTodo?: string,
 *   bodyTodo?: string,
 * }>} sections
 * @returns {string} full file contents, trailing newline included.
 */
export function pageYaml(page, sections) {
  const header = [
    `# ${page}.yml — Generated by w2f cms.`,
    '#',
    `# Sections for src/html/${page}.html — edit in /admin or by hand.`,
    "# Re-running `w2f cms` will not touch this file (delete it + restore the",
    '# page HTML from git, or pass --force, to re-extract).',
  ].join('\n');
  const body = sections.flatMap(sectionLines).join('\n');
  return `${header}\n\nsections:\n${body}\n`;
}

// ---------------------------------------------------------------------------
// public/admin/index.html — Sveltia CMS shell
// ---------------------------------------------------------------------------

/**
 * Pinned via `npm view @sveltia/cms version` at implement time. Sveltia has
 * no long-term-support channel and ships fast; pinning (rather than tracking
 * `@latest` on every load) keeps the admin shell from breaking under a
 * client's feet between w2f runs. Bump by editing the constant here (or the
 * version literal directly in an already-scaffolded project's
 * `public/admin/index.html` — this file is writeIfMissing, so w2f will not
 * touch it again once it exists).
 */
const SVELTIA_CMS_VERSION = '0.176.0';

/**
 * `public/admin/index.html` — the entire Sveltia CMS app is this one script
 * tag loaded from unpkg; there is no build step and nothing else to
 * scaffold. Sveltia resolves `config.yml` as a sibling of this file by
 * default (see its `getConfigPath()`), so the explicit
 * `<link rel="cms-config-url">` below is redundant here — kept anyway as
 * self-documentation, and so a future non-sibling config path is a one-line
 * change instead of a discovery exercise.
 */
export function adminIndexHtml({ siteName = '', version = SVELTIA_CMS_VERSION } = {}) {
  const title = siteName ? `Admin — ${siteName}` : 'Admin';
  return `<!doctype html>
<!-- index.html — Generated by w2f cms. writeIfMissing: w2f will not
     overwrite this file on re-runs, so hand edits (and version bumps) are
     safe. Shape follows the maerchenforum-hamburg.de reference
     implementation of this CMS layer. -->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <!-- The editor must never be indexed or trained on. -->
  <meta name="robots" content="noindex, nofollow" />
  <!-- Redundant given the sibling-file default (see file header) — kept
       explicit on purpose. -->
  <link rel="cms-config-url" href="/admin/config.yml" />
</head>
<body>
  <!-- Pinned to a known-good Sveltia CMS release
       (https://github.com/sveltia/sveltia-cms). To bump: read the release
       notes at https://github.com/sveltia/sveltia-cms/releases, confirm the
       current version (\`npm view @sveltia/cms version\`), then edit the
       version segment in the URL below. -->
  <script src="https://unpkg.com/@sveltia/cms@${version}/dist/sveltia-cms.js" type="module"></script>
  <!-- Load the real site CSS into the editor's preview pane so authored
       content previews with the site's fonts, colours, and component
       styling — not Sveltia's generic defaults. Same main.css the live
       pages ship. -->
  <script>
    CMS.registerPreviewStyle('/assets/css/main.css');
  </script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// public/admin/config.yml — content model
// ---------------------------------------------------------------------------

/** Literal marker comment line `configYmlAddPage` searches for, verbatim. */
const PAGES_MARKER = '# w2f:pages';

/** YAML anchor name shared by every page entry's `fields:` schema. */
const PAGE_FIELDS_ANCHOR = '&page_fields';

/** "about-us" -> "About us"; "index" -> "Index". Sentence case, not Title Case. */
function pageLabel(page) {
  const words = page.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The `sections` list-widget schema every page's content model shares.
 * `baseIndent` is the indentation of the `fields:` key this schema hangs
 * under; each nested level adds two spaces, matching the file's 2-space
 * YAML nesting throughout. Shared by `configYml()`'s first entry (where the
 * schema is defined under the `&page_fields` anchor) and
 * `configYmlAddPage()`'s no-anchor fallback (where it's repeated in full).
 */
function pageWidgetFieldsLines(baseIndent) {
  const i1 = `${baseIndent}  `; // "- name: sections"
  const i2 = `${i1}  `; // "label:", "widget:", "fields:"
  const i3 = `${i2}  `; // nested "- { ... }" field defs
  return [
    `${i1}- name: sections`,
    `${i2}label: Sections`,
    `${i2}label_singular: Section`,
    `${i2}widget: list`,
    // Open the editor with every section folded to its summary line, so a
    // long page is a scannable list rather than a wall of open forms — the
    // reference implementation's editor-UX call, kept verbatim. The ternary
    // emits separators only when the preceding field is present.
    `${i2}collapsed: true`,
    `${i2}summary: "{{fields.draft | ternary('✏️ Draft · ','')}}{{fields.heading}}{{fields.heading | ternary(' — ','')}}{{fields.body | truncate(60)}}"`,
    `${i2}fields:`,
    `${i3}- { name: heading, label: Heading, widget: string, required: false }`,
    // hidden, not select: the value is set by the lift (1 when the source
    // heading was an <h1>) and must survive CMS saves untouched — editors
    // shouldn't be choosing heading levels section-by-section in v1.
    `${i3}- { name: level, label: Heading level, widget: hidden, required: false }`,
    `${i3}- { name: body, label: Body, widget: markdown }`,
    `${i3}- { name: image, label: Image, widget: image, required: false }`,
    `${i3}- { name: draft, label: Draft, widget: boolean, required: false, default: false, hint: "On = section stays off the live site (work in progress). Turn off to publish." }`,
  ];
}

/**
 * Lines for one `files:` list entry (one page). `fieldsMode` picks how the
 * `fields:` key is emitted:
 *   - 'define' — first entry in a fresh config: `fields: &page_fields`
 *     followed by the full schema (the anchor's definition site).
 *   - 'alias'  — later entries when the anchor scheme is in use:
 *     `fields: *page_fields` (single line, no repeated schema).
 *   - 'full'   — no anchor available (e.g. `configYmlAddPage()` appending
 *     to a hand-restructured config that dropped the anchor): the full
 *     schema repeated verbatim, un-anchored.
 */
function pageFileEntryLines(page, indent, fieldsMode) {
  const inner = `${indent}  `;
  const lines = [
    `${indent}- name: ${page}`,
    `${inner}label: ${pageLabel(page)}`,
    `${inner}file: src/content/${page}.yml`,
  ];
  if (fieldsMode === 'alias') {
    lines.push(`${inner}fields: *page_fields`);
  } else if (fieldsMode === 'define') {
    lines.push(`${inner}fields: &page_fields`);
    lines.push(...pageWidgetFieldsLines(inner));
  } else {
    lines.push(`${inner}fields:`);
    lines.push(...pageWidgetFieldsLines(inner));
  }
  return lines;
}

/**
 * `backend:` block. `githubRepo` (cached in the scaffolded project's
 * `.weebly-migrate.json` from the `init` interview) fills `repo:` directly;
 * absent, it's a TODO the user fills by hand. `base_url` always TODOs — v1
 * documents the two auth-relay options in `docs/cms.md` but scaffolds
 * neither (see that function's header).
 */
function backendBlock(githubRepo) {
  const repoLine = githubRepo
    ? `  repo: ${githubRepo}`
    : [
        '  # TODO(w2f): no "githubRepo" cached in .weebly-migrate.json — set',
        '  # this by hand, or re-run `w2f` after `git remote add origin ...`',
        '  # so the answer gets cached for next time.',
        '  repo: # TODO(w2f): owner/name',
      ].join('\n');
  return `backend:
  name: github
${repoLine}
  branch: main
  base_url: # TODO(w2f): auth relay ORIGIN — see docs/cms.md in this project
            # (sveltia-cms-auth Cloudflare Worker, or a Firebase Function
            # OAuth relay). /admin can't talk to GitHub until one is set.
            # Must match the GitHub OAuth App's callback origin exactly.
  # auth_endpoint: /api/auth   # uncomment + adjust when the relay is served
  #                            # from a path on base_url (e.g. a Firebase
  #                            # Hosting rewrite to a function) rather than
  #                            # the relay origin's default /auth.
`;
}

/**
 * Emit `public/admin/config.yml`. Sveltia parses this as plain YAML with
 * anchors/aliases enabled (its config loader calls
 * `parseYAML(text, { maxAliasCount: -1 })` specifically to lift the default
 * alias-count ceiling) — so the `&page_fields` / `*page_fields` scheme
 * below is not a hopeful guess, it's what the loader is built to expect.
 * Anchoring the `fields:` *value* (not the whole file entry) is
 * deliberate: `name`/`label`/`file` differ per page, only the widget
 * schema is shared.
 *
 * @param {string[]} pages - page slugs to register, in the order processed.
 * @param {{ githubRepo?: string }} [opts]
 */
export function configYml(pages, { githubRepo } = {}) {
  const header = [
    '# config.yml — Generated by w2f cms.',
    '#',
    '# Sveltia CMS content model for this project. Page entries are',
    "# appended automatically by `w2f cms` (see the marker comment in the",
    "# `files:` list below) — everything else here is yours to edit freely;",
    '# w2f never rewrites this file wholesale once it exists.',
  ].join('\n');

  const markerComment = [
    `      ${PAGES_MARKER} — entries below are appended by \`w2f cms\`; edit`,
    '      # freely. w2f only ever appends missing pages after this marker,',
    '      # and only while this exact comment line is present — remove it',
    '      # to opt out of automatic registration and add pages by hand.',
  ].join('\n');

  const entries = pages
    .flatMap((page, i) => pageFileEntryLines(page, '      ', i === 0 ? 'define' : 'alias'))
    .join('\n');

  return `${header}

# Shown in the admin header and browser tab in place of Sveltia's default.
# (Sveltia is not white-label, so its own name still appears in places.)
# Add a \`logo: { src: /assets/gfx/<file>, show_in_header: true }\` block
# here if the site has a mark worth putting on the login screen.
app_title: "Admin"

${backendBlock(githubRepo)}
media_folder: public/assets/files
public_folder: /assets/files

# Auto-optimize uploads — a 4 MB phone photo ships as a sized WebP instead
# of landing in the repo raw. Raster → WebP@85 capped at 2000px; SVG
# minified. (Reference-implementation setting, kept as the default.)
media_libraries:
  default:
    config:
      transformations:
        raster_image:
          format: webp
          quality: 85
          width: 2000
        svg:
          optimize: true

collections:
  - name: pages
    label: Pages
    files:
${markerComment}
${entries}
`;
}

/**
 * Append a page entry to an existing `config.yml`, or return `null` when
 * there's nothing to do:
 *   - the page is already registered (`file: src/content/<page>.yml`
 *     literal containment — no YAML parsing, matching w2f's file-existence
 *     idempotency model elsewhere), or
 *   - the `# w2f:pages` marker line is gone (config was hand-restructured;
 *     the caller logs `skip config.yml (marker removed; add page by hand)`
 *     and leaves it alone).
 *
 * The new entry is appended at the **end** of the `files:` list — not
 * dropped in immediately after the marker comment. This matters more than
 * it sounds: the anchor scheme means the *first* entry in the list is
 * where `&page_fields` is actually defined, and YAML resolves anchors in
 * document order — an aliased (`fields: *page_fields`) entry inserted
 * ahead of it would reference an anchor that doesn't exist yet and fail to
 * parse. Appending after every existing entry keeps the anchor's
 * definition site first, always. (Confirmed against the `yaml` package,
 * the same parser Sveltia uses — inserting right after the marker throws
 * `Unresolved alias` on load.) Falls back to a full (un-anchored) field
 * list when `&page_fields` is no longer present in the file — see
 * `pageFileEntryLines()`'s 'full' mode.
 *
 * Finding "the end of the list" is indentation-based, not a YAML parse:
 * starting after the marker's comment block, walk forward while each
 * non-blank line is indented at least as deep as a list entry (`- name:`)
 * would be; the first line that dedents below that (or end of file) marks
 * the boundary.
 *
 * @param {string} existing - current config.yml contents.
 * @param {string} page - page slug to add.
 * @returns {string | null}
 */
export function configYmlAddPage(existing, page) {
  if (existing.includes(`file: src/content/${page}.yml`)) return null;

  const lines = existing.split('\n');
  // A strict prefix match (not `.includes()`) on purpose: the header
  // comment above also mentions the marker in prose, and a loose substring
  // match would land on that line instead of the real marker.
  const markerIdx = lines.findIndex((line) => line.trim().startsWith(PAGES_MARKER));
  if (markerIdx === -1) return null;

  const indent = lines[markerIdx].match(/^\s*/)[0];

  // Skip the marker's own explanatory comment lines.
  let cursor = markerIdx + 1;
  while (cursor < lines.length && /^\s*#/.test(lines[cursor])) cursor++;

  // Walk to the end of the existing entries: blank lines are ambiguous
  // (could be inside the list or trailing the file) and don't move the
  // boundary either way; a line indented shallower than our own entries
  // marks the first thing *after* the list.
  let insertAt = cursor;
  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.match(/^ */)[0].length < indent.length) break;
    insertAt = i + 1;
  }

  const fieldsMode = existing.includes(PAGE_FIELDS_ANCHOR) ? 'alias' : 'full';
  const entryLines = pageFileEntryLines(page, indent, fieldsMode);

  lines.splice(insertAt, 0, ...entryLines);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// scripts/render-content.mjs — shipped into the scaffolded project
// ---------------------------------------------------------------------------

/**
 * Source for `scripts/render-content.mjs`. Self-contained ESM, deliberately
 * cut loose from w2f: it has to keep working on every future build long
 * after the CLI that generated it is gone from the machine, so it imports
 * nothing from this repo (the `RENDER_MARKER_RE` literal is duplicated, not
 * shared — see the constant's own doc comment above). `.mjs` extension
 * means it runs as ESM via plain `node` regardless of whether the
 * scaffolded `package.json` sets `"type": "module"` (it doesn't — see
 * `lib/templates.mjs`'s `packageJson()`).
 *
 * Runs inside `build:html`, right after posthtml has produced
 * `public/*.html`: reads every `src/content/*.yml` (glob-free — a plain
 * `readdir` filtered to `.yml`, so adding a page never means editing this
 * file, only dropping a new content file + marker + config.yml entry),
 * renders non-draft sections to HTML with `marked`, and swaps the marker in
 * the matching `public/<page>.html`.
 */
export function renderContentMjs() {
  return `// render-content.mjs — Generated by w2f cms.
//
// @docs docs/cms.md
//
// Ships into the scaffolded project (not w2f itself) and runs as the last
// step of \`npm run build\`, after posthtml has produced \`public/*.html\`.
// Self-contained on purpose — no import from the w2f CLI — because this
// file has to keep working long after the CLI that generated it is gone
// from the machine. The \`@render:sections\` marker regex is duplicated
// here rather than imported for the same reason; keep it in sync with
// w2f's lib/cms-templates.mjs if it ever changes.
//
// Reads every src/content/*.yml (plain readdir, no glob — adding a page
// never touches this file), renders each non-draft section's markdown body
// with \`marked\`, and swaps the \`<!-- @render:sections -->\` marker in the
// matching public/<page>.html for the rendered HTML. src/html/<page>.html
// keeps its marker permanently — it's the committed source of truth, and
// this script is safe (and expected) to re-run on every build.
//
// Exit behavior: a missing public/<page>.html or a page whose marker is
// gone is *not* fatal — posthtml may legitimately skip a page mid-build,
// and this script must not turn that into a red build. It logs a warning
// and moves on. Unparseable YAML *is* fatal (a real content error the
// editor needs to see) — the script keeps rendering the remaining pages
// but exits 1 once any page fails to parse.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { marked } from 'marked';

const CONTENT_DIR = 'src/content';
const PUBLIC_DIR = 'public';
const MARKER_RE = /<!--\\s*@render:sections\\s*-->/;

const MARKDOWN_OPTIONS = { gfm: true, breaks: true };

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

// marked wraps a lone \`![alt](src)\` in an ordinary <p> — a paragraph that
// is *only* an image reads better as a <figure> than as a text paragraph.
function wrapStandaloneImages(html) {
  return html.replace(/<p>\\s*(<img\\b[^>]*>)\\s*<\\/p>/g, '<figure>$1</figure>');
}

function renderSection(section) {
  const heading = String(section.heading || '').trim();
  // \`level: 1\` in the YAML means the source heading was the page's <h1> —
  // preserve it (SEO/a11y); everything else renders as <h2>.
  const headingTag = Number(section.level) === 1 ? 'h1' : 'h2';
  const parts = [];
  if (heading) parts.push(\`<\${headingTag}>\${escapeHtml(heading)}</\${headingTag}>\`);
  if (section.image) {
    // alt text comes from the heading — the image field has no separate
    // alt input in the CMS widget (keeps the section model small); the
    // heading is almost always a reasonable stand-in, and an empty alt on
    // a genuinely decorative image is still valid.
    parts.push(\`<figure><img src="\${escapeAttr(section.image)}" alt="\${escapeAttr(heading)}"></figure>\`);
  }
  if (section.body) parts.push(wrapStandaloneImages(marked.parse(section.body, MARKDOWN_OPTIONS)));
  return \`<section class="w2f-section">\\n\${parts.join('\\n')}\\n</section>\`;
}

async function renderPage(file) {
  const page = path.basename(file, '.yml');
  const contentPath = path.join(CONTENT_DIR, file);
  const raw = await readFile(contentPath, 'utf8');

  let data;
  try {
    data = parseYaml(raw);
  } catch (err) {
    console.error(\`render-content: \${contentPath} failed to parse — \${err.message}\`);
    process.exitCode = 1;
    return;
  }

  const sections = (data && data.sections) || [];
  const rendered = sections.filter((section) => !section.draft);
  const html = rendered.map(renderSection).join('\\n');

  const publicPath = path.join(PUBLIC_DIR, \`\${page}.html\`);
  let publicHtml;
  try {
    publicHtml = await readFile(publicPath, 'utf8');
  } catch {
    console.warn(\`render-content: skip \${page} — public/\${page}.html not built yet\`);
    return;
  }

  if (!MARKER_RE.test(publicHtml)) {
    console.warn(\`render-content: skip \${page} — no @render:sections marker in public/\${page}.html\`);
    return;
  }

  // Replacement *function*, not a string: a literal "$&" or "$1" inside
  // rendered content would otherwise be interpreted as a replace() token.
  const merged = publicHtml.replace(MARKER_RE, () => html);
  await writeFile(publicPath, merged);
  const count = rendered.length;
  const draftCount = sections.length - count;
  const draftNote = draftCount ? \`, \${draftCount} draft skipped\` : '';
  console.log(\`render-content: \${page}.html (\${count} section\${count === 1 ? '' : 's'}\${draftNote})\`);
}

async function main() {
  let files;
  try {
    files = (await readdir(CONTENT_DIR)).filter((name) => name.endsWith('.yml'));
  } catch {
    console.warn(\`render-content: no \${CONTENT_DIR}/ directory — nothing to render\`);
    return;
  }
  for (const file of files) {
    await renderPage(file);
  }
}

await main();
`;
}

// ---------------------------------------------------------------------------
// package.json wiring
// ---------------------------------------------------------------------------

// Caret-pinned to the current majors at implement time (`npm view yaml
// version` / `npm view marked version`), same convention as every other
// devDependency in lib/templates.mjs's packageJson().
const YAML_DEV_VERSION = '^2.9.0';
const MARKED_DEV_VERSION = '^18.0.7';

/**
 * Mutate-if-absent, return-what-changed — the `applyFormsConfigToFirebaseJson`
 * pattern (lib/forms.mjs), adapted to return a value instead of mutating in
 * place, since `package.json` (unlike `firebase.json`) is read fresh from
 * disk by both the standalone `cms` command and the `init` pipeline, and
 * the caller needs to know whether a write is even necessary.
 *
 * - `scripts['build:html']` — `&& node scripts/render-content.mjs` appended
 *   (reference-implementation shape: the render step is part of producing
 *   the HTML, not a sibling `build:content` script). If `build:html` was
 *   removed entirely, scripts are left untouched — the caller logs a `!`
 *   line with the manual-append instruction.
 * - `devDependencies.yaml` / `.marked` — added if absent.
 *
 * Pure function, no fs access — the caller reads `package.json`, calls
 * this, and writes back only when `changed` is true.
 *
 * @param {object} pkg - parsed package.json.
 * @returns {{ pkg: object, changed: boolean }}
 */
export function applyCmsToPackageJson(pkg) {
  let changed = false;
  const next = {
    ...pkg,
    scripts: { ...(pkg.scripts || {}) },
    devDependencies: { ...(pkg.devDependencies || {}) },
  };

  // The renderer runs INSIDE build:html, right after posthtml — the shape
  // the maerchenforum-hamburg.de reference settled on (no separate
  // build:content script; the render step is part of producing the HTML,
  // not a sibling concern).
  const buildHtml = next.scripts['build:html'] || '';
  if (buildHtml && !buildHtml.includes('render-content.mjs')) {
    next.scripts['build:html'] = `${buildHtml} && node scripts/render-content.mjs`;
    changed = true;
  }
  // else: no build:html script at all (hand-restructured package.json) —
  // leave scripts alone; the caller logs the manual-insert instruction.

  if (!next.devDependencies.yaml) {
    next.devDependencies.yaml = YAML_DEV_VERSION;
    changed = true;
  }
  if (!next.devDependencies.marked) {
    next.devDependencies.marked = MARKED_DEV_VERSION;
    changed = true;
  }

  return { pkg: next, changed };
}

// ---------------------------------------------------------------------------
// docs/cms.md — the one shared, user-editable doc for the whole feature
// ---------------------------------------------------------------------------

/**
 * `docs/cms.md` in the scaffolded project. `writeIfMissing` only — this is
 * prose the user is expected to edit (fill in the chosen auth relay, adjust
 * for their own workflow), never regenerated once it exists. One shared doc
 * rather than per-file `@docs` siblings (unlike scaffold-modules.mjs's three
 * independent opt-in modules): the CMS layer is one cohesive feature, and
 * every generated file's header points back at this single doc.
 */
export function cmsDocsMd() {
  return `# Sveltia CMS

This project's content — the text and images ported from Weebly — is
editable through a small admin panel at \`/admin\`, backed by
[Sveltia CMS](https://github.com/sveltia/sveltia-cms)
(docs: [sveltiacms.app](https://sveltiacms.app/)). No server, no database:
edits are git commits, and the built site reads its content from the same
YAML files that live in this repo.

## What's live

- **\`public/admin/index.html\`** — the entire admin app, loaded from a
  pinned unpkg URL. No build step for it; edit the version pin directly in
  the file if you ever want to bump it (check the
  [Sveltia release notes](https://github.com/sveltia/sveltia-cms/releases)
  before bumping — it ships fast and has no LTS channel).
- **\`public/admin/config.yml\`** — the content model. One collection,
  \`pages\`, with one file per ported page. Each page is a list of
  \`sections\` (heading, body, optional image, draft toggle) — that's the
  same section split \`w2f cms\` made when it lifted the content out of your
  HTML.
- **\`src/content/<page>.yml\`** — the actual content, one file per page.
  This is what both the admin panel and the build read and write.
- **\`scripts/render-content.mjs\`** — runs inside \`npm run build:html\`,
  right after posthtml. It reads every \`src/content/*.yml\`, turns the
  markdown bodies into HTML, and drops the result into
  \`public/<page>.html\` wherever that page's
  \`<!-- @render:sections -->\` marker is.

## Auth: the one thing not wired up yet

Sveltia CMS talks to your GitHub repo directly, but GitHub's OAuth flow
needs something server-side to complete the handshake (a plain static site
can't hold a client secret). \`w2f cms\` intentionally does **not** scaffold
that piece — you need one of the following before \`/admin\` can save
anything:

1. **[sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth)** — a
   small, official Cloudflare Worker built for exactly this. One-click
   deploy, then register it as a GitHub OAuth app and point \`base_url\` in
   \`config.yml\` at the worker's URL. Straightforward if you're fine adding
   a (free-tier) Cloudflare account to the mix.

2. **A Firebase Function OAuth relay** — if you'd rather keep everything on
   the Firebase project this site already deploys to, write a small
   \`functions/\` HTTPS function that mirrors what sveltia-cms-auth does:
   receive the OAuth \`code\` GitHub redirects with, exchange it
   server-side for an access token (using a GitHub OAuth app's client
   secret, stored as a Firebase Functions secret — see
   \`firebase functions:secrets:set\`), and post the result back to the
   Sveltia popup window the way sveltia-cms-auth's
   [\`callback\` handler](https://github.com/sveltia/sveltia-cms-auth) does.
   More setup than option 1, but one less external account.

**If you're the only editor (or the only non-technical one)**, you may not
need a relay at all — Sveltia supports GitHub's
[personal access token method](https://sveltiacms.app/en/docs/backends/github#access-token)
directly, no backend required. Worth trying first if that describes your
situation; switch to a relay later if you add editors who shouldn't hold
their own GitHub tokens.

Either way, set \`base_url\` (and \`repo\`, if \`w2f\` didn't already fill it
in) in \`public/admin/config.yml\` once you've picked one.

## Saving is publishing

There's no separate "staging" step. When someone saves an edit in
\`/admin\`, Sveltia commits the change straight to \`src/content/<page>.yml\`
on the configured branch. From there it's whatever your normal deploy path
already does — if you're using the GitHub Actions workflow this project
scaffolds with, that commit triggers \`npm run build\` and a Firebase
Hosting deploy, same as any other push. The edit is live after that build
finishes; there's no manual "publish" button beyond the CMS's own "Save".

## Adding a page

The renderer discovers pages by scanning \`src/content/*.yml\` — it never
needs to be told about a new page by name. Adding one is:

1. Add an entry under the \`# w2f:pages\` marker in
   \`public/admin/config.yml\` (or re-run \`w2f cms\` against the new
   \`src/html/<page>.html\` — it appends the entry for you).
2. Make sure the new page's \`<main>\` contains a
   \`<!-- @render:sections -->\` marker somewhere in it (again, \`w2f cms\`
   does this automatically when it lifts a page's content).
3. Create \`src/content/<page>.yml\` with a \`sections:\` list (or let
   \`w2f cms\` write the first draft from the existing HTML).

That's it — no code change, nothing to register in
\`scripts/render-content.mjs\`.

## Drafts

Any section with \`draft: true\` is skipped by the renderer entirely — it
never reaches the built HTML. Useful for staging a section before it's
ready, without deleting it or taking the page live with a half-written
paragraph.

## Media

Images uploaded through the admin panel land in \`public/assets/files/\`
(the CMS's \`media_folder\`) and are referenced as \`/assets/files/<name>\`
(\`public_folder\`) — a separate space from \`public/assets/gfx/\`, which
holds the images \`w2f port\` pulled from the original Weebly site. Keeping
them apart means client-uploaded media never collides with, or gets
mistaken for, assets that came from the migration.
`;
}
