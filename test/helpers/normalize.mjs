// w2f cms test suite — written test-first from dev/plans/cms.md (Stage 2.5).
// Guard: touches only test/**; source modules are expected to not exist until Stage 3.
//
// normalizeHtml(html, { assetMap }) — real, hand-rolled normalizer used only
// by test/cms-roundtrip.test.mjs to diff a pre-lift ported page's <main>
// against the same page after a full lift → npm i → build → render-content
// round trip. The two strings are never going to be byte-identical (the
// pipeline legitimately changes surface details: attribute order, entity
// encoding, b/i vs strong/em, self-closing slashes, whitespace) — this
// collapses those differences down to the spec's acceptance-criterion list
// (dev/specs/cms.md, "Round-trip" bullet):
//
//   whitespace collapse · attribute ordering · entity decoding ·
//   tag-synonym folding (b→strong, i→em) · breaks:true newline↔<br>
//   equivalence · rewritten asset paths mapped back to originals
//
// Plus the approved renderer wrappers, which aren't optional for this diff
// to ever pass:
//   - unwrap `<section class="w2f-section">…</section>` — renderContentMjs's
//     own wrapper, absent from the pre-lift source.
//   - unwrap bare `<figure><img></figure>` — the renderer's mandated wrap
//     for a section image / standalone image paragraph.
// Heading LEVELS are deliberately NOT normalized: sections carry `level: 1`
// in their YAML and the renderer emits a real <h1>, so a flattened h1 must
// fail the diff. Heading *attributes* are still dropped by extraction
// (splitAtHeadings keeps only headingText), so the fixtures keep headings
// attribute-free to avoid conflating that expected loss with a regression.

const ENTITY_NAMES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(str) {
  return str
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ENTITY_NAMES[name])
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Unwrap `<section class="w2f-section">…</section>`, keeping the inner content. */
function stripSectionWrappers(html) {
  return html.replace(
    /<section\s+class=["']w2f-section["']\s*>([\s\S]*?)<\/section>/gi,
    (_, inner) => inner,
  );
}

/**
 * Unwrap bare `<figure><img …></figure>` down to the `<img>` alone. The
 * renderer deliberately wraps a section image / standalone image paragraph in
 * `<figure>` (spec: "standalone image → figure") — an approved presentational
 * transformation, same class as the w2f-section wrapper, so the round-trip
 * diff must fold it. Figures carrying anything besides the one image (e.g. a
 * `<figcaption>`) are real content differences and are left alone.
 */
function stripBareFigureWrappers(html) {
  return html.replace(
    /<figure\s*>\s*(<img[^>]*>)\s*<\/figure>/gi,
    (_, img) => img,
  );
}

/**
 * b→strong, i→em (attribute-preserving). No h1→h2 folding: sections carry
 * `level: 1` in their YAML and the renderer emits a real <h1>, so heading
 * levels are part of the round-trip contract now — a flattened h1 must FAIL
 * the diff, not be normalized away.
 */
function foldTagSynonyms(html) {
  return html
    .replace(/<b(\s[^>]*)?>/gi, (_, attrs) => `<strong${attrs || ''}>`)
    .replace(/<\/b>/gi, '</strong>')
    .replace(/<i(\s[^>]*)?>/gi, (_, attrs) => `<em${attrs || ''}>`)
    .replace(/<\/i>/gi, '</em>');
}

/** Attribute list → `name="value"` pairs sorted by name; boolean attrs keep no value. */
function rebuildAttrs(attrsStr) {
  const attrs = [...attrsStr.matchAll(/([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
    .map(m => ({ name: m[1], value: m[2] }));
  attrs.sort((a, b) => a.name.localeCompare(b.name));
  return attrs
    .map(a => {
      if (a.value === undefined) return a.name;
      const raw = a.value.replace(/^["']|["']$/g, '');
      return `${a.name}="${raw}"`;
    })
    .join(' ');
}

/**
 * Sort attributes within every tag and drop the self-closing `/` — folds
 * `<img src="x">` / `<img src="x" />` / `<img src="x"/>` to one canonical
 * form (the "self-closing tag normalization" bullet).
 */
function normalizeTags(html) {
  return html.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g,
    (_, closing, name, attrsStr) => {
      if (closing) return `</${name.toLowerCase()}>`;
      const attrs = rebuildAttrs(attrsStr);
      return `<${name.toLowerCase()}${attrs ? ' ' + attrs : ''}>`;
    },
  );
}

/**
 * Whitespace collapse per actual browser rendering rules: any run of
 * whitespace (anywhere, tag-adjacent or not) is one space. Additionally,
 * two tags with NO whitespace between them (`><`) and two tags separated
 * by collapsed whitespace both need to compare equal — marked()'s compact
 * output and a pretty-printed source page disagree on which they use for
 * the same rendered result, so both converge on exactly one space here.
 */
function collapseWhitespace(html) {
  return html
    .replace(/\s+/g, ' ')
    .replace(/></g, '> <')
    .trim();
}

export function normalizeHtml(html, { assetMap = {} } = {}) {
  let out = html;
  for (const [from, to] of Object.entries(assetMap)) out = out.split(from).join(to);
  out = decodeEntities(out);
  out = stripSectionWrappers(out);
  out = stripBareFigureWrappers(out);
  out = foldTagSynonyms(out);
  out = normalizeTags(out);
  out = collapseWhitespace(out);
  return out;
}
