/**
 * Regex-based HTML extraction toolkit — shared by `port` (live-mirror →
 * src/html skeletons) and `cms` (src/html → section YAML). Not a DOM parser:
 * everything here is tag-depth-balancing regex, tuned against the markup
 * shapes Weebly and w2f's own porter produce. Good enough for both callers;
 * neither wants an actual HTML parser dependency for this.
 */

/** Inner HTML of the first `<tag …>…</tag>` block. */
export function extractTag(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * Inner HTML of the first element matching `id="<name>"` or
 * `class="… <name> …"`. Walks tag depth to find the balancing close — naive
 * but handles nested same-tag siblings well enough for the markup we see.
 */
export function extractByIdOrClass(html, name) {
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

/**
 * Like extractByIdOrClass, but returns the full `<tag class="name">…</tag>`
 * including the wrapping element. Necessary when the surrounding stylesheet
 * scopes rules to that class — e.g. Weebly's theme defines
 * `.banner-wrap .container { max-width: 1366px; padding: 60px 40px; }`,
 * so capturing the *inner* HTML of `.banner-wrap` and dropping it raw into
 * `<main>` loses the `.container` constraint entirely.
 */
export function extractElement(html, name) {
  const inner = extractByIdOrClass(html, name);
  if (inner === null) return null;
  const openRe = new RegExp(
    `<(\\w+)\\b[^>]*(?:id=["']${name}["']|class=["'][^"']*\\b${name}\\b[^"']*["'])[^>]*>`,
    'i',
  );
  const m = html.match(openRe);
  if (!m) return null;
  return `${m[0]}${inner}</${m[1]}>`;
}

/** Try several selectors in order; first hit wins. */
export function tryEach(html, attempts) {
  for (const fn of attempts) {
    const out = fn(html);
    if (out && out.trim()) return out;
  }
  return null;
}

/**
 * A skeleton is detected by the TODO marker the converter writes. Shared by
 * `port` (page main slot) and `cms` (whether a page's main is still the
 * unported placeholder, vs. real content, vs. already lifted to YAML).
 */
export function isSkeleton(content) {
  return /<!--\s*TODO:\s*port (?:from|content from)/i.test(content);
}

/**
 * The `cms` lift marker — where `scripts/render-content.mjs` injects the
 * rendered sections in the *scaffolded* project. Lives here (not in
 * cms-templates.mjs) because `port` needs the predicate too: a page carrying
 * this marker has had its content moved to `src/content/<page>.yml`, and
 * re-porting it — even with `--force` — would orphan that YAML silently.
 * The regex literal is duplicated inside the generated render-content.mjs
 * by design: that script ships into the target project with zero w2f
 * imports.
 */
export const RENDER_MARKER = '<!-- @render:sections -->';
export const RENDER_MARKER_RE = /<!--\s*@render:sections\s*-->/;

/** Has this page's content already been lifted to YAML by `w2f cms`? */
export function isRendered(html) {
  return RENDER_MARKER_RE.test(html);
}

/**
 * Common HTML entities that show up in Weebly-sourced markup. Shared by
 * `textContent` (strip-tags-and-decode) and `html-markdown.mjs` (decode the
 * text that survives inline-tag conversion) so there's exactly one entity
 * table in the codebase.
 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
};

/**
 * Decode the named entities in ENTITIES plus all numeric character
 * references (`&#8217;`, `&#x2019;`, …) — Weebly-exported markup leans on
 * numeric references for every typographic character (curly quotes,
 * dashes, NBSP), so a named-only table leaves raw `&#8217;` strings in
 * headings that then get double-escaped at render time. Unknown *named*
 * entities still pass through untouched; numeric references outside the
 * valid code-point range stay literal rather than throwing.
 */
export function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (m, dec) => {
      const code = Number(dec);
      try { return String.fromCodePoint(code); } catch { return m; }
    })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return m; }
    })
    .replace(/&(#39|apos|amp|lt|gt|quot|nbsp);/g, (_, name) => ENTITIES[name]);
}

/**
 * Strip all tags, decode entities, collapse whitespace. Used for heading
 * text (splitAtHeadings), `<title>` fallbacks, and as the tail step of the
 * markdown converter's inline-text handling.
 *
 * Comments go first: they are not text content, and stripping tags before
 * comments would leave comment *bodies* behind (a commented-out `<title>`
 * earlier in the document otherwise bleeds `--> …` into the result).
 */
export function textContent(html) {
  return decodeEntities(stripComments(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Remove HTML comments. Callers that regex-match for a tag (extractTag and
 * friends) should strip comments first when the document may contain the
 * same tag name inside a comment — otherwise the match anchors inside the
 * comment and the capture bleeds `--> …` noise into the result.
 */
export function stripComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Void elements — no close tag, never affect nesting depth. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// One scanner for both depth-walkers below: comments as a unit (so a tag
// inside a comment never counts), else an open/close tag whose attribute
// values may contain `>` inside quotes.
const TAG_SCANNER_SRC = `<!--[\\s\\S]*?-->|<(\\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>`;

/**
 * Split an HTML fragment at **top-level** h1/h2 boundaries. Returns the
 * content before the first heading (lead) and one entry per heading with the
 * content that follows it, up to the next top-level h1/h2 or the end of the
 * fragment.
 *
 * Top-level only — a heading nested inside a wrapper (`<div><h2>…`) is NOT
 * a boundary. Splitting at nested headings would cut through the wrapper
 * and produce unbalanced fragments (an unclosed `<div>` in one section, its
 * stray `</div>` in the next) that silently break page layout after render.
 * The caller (`cms`) descends into a sole wrapper element first when the
 * headings all live one level down — see commands/cms.mjs. By construction,
 * every fragment this returns is balanced.
 *
 * Used by `cms` to turn a ported page's pre-form `<main>` region into
 * discrete sections: whatever sits before the first heading becomes section
 * 0 (empty heading), each subsequent h1/h2 starts a new section carrying its
 * own heading level and text.
 */
export function splitAtHeadings(html) {
  const src = String(html);
  const scanner = new RegExp(TAG_SCANNER_SRC, 'g');
  const hits = [];
  let depth = 0;
  let m;
  while ((m = scanner.exec(src))) {
    if (m[0].startsWith('<!--')) continue;
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (isClose) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const selfClosed = m[3].trimEnd().endsWith('/') || VOID_TAGS.has(tag);
    if (depth === 0 && (tag === 'h1' || tag === 'h2')) {
      // Headings never nest another heading of the same tag, so the first
      // close is the real one. An unclosed heading falls through and is
      // treated as an ordinary open tag (degrades, never throws).
      const closeM = src.slice(scanner.lastIndex).match(new RegExp(`<\\/${tag}\\s*>`, 'i'));
      if (closeM) {
        const innerStart = scanner.lastIndex;
        const innerEnd = innerStart + closeM.index;
        hits.push({
          level: Number(tag[1]),
          start: m.index,
          innerStart,
          innerEnd,
          end: innerEnd + closeM[0].length,
        });
        scanner.lastIndex = innerEnd + closeM[0].length;
        continue;
      }
    }
    if (!selfClosed) depth++;
  }
  if (hits.length === 0) return { lead: src, sections: [] };
  const lead = src.slice(0, hits[0].start);
  const sections = hits.map((h, i) => ({
    level: h.level,
    headingHtml: src.slice(h.innerStart, h.innerEnd),
    headingText: textContent(src.slice(h.innerStart, h.innerEnd)),
    body: src.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : src.length),
  }));
  return { lead, sections };
}

/**
 * Enumerate the top-level elements of a fragment: `{ tag, start, innerStart,
 * innerEnd, end }` per element, in document order. Void/self-closing
 * elements have `innerStart === innerEnd`. An element whose close tag never
 * appears swallows the rest of the fragment (matching the degrade-don't-throw
 * behavior of the other walkers here).
 *
 * `cms` uses this to descend into a sole wrapper element when a page's
 * headings all sit one level down (Weebly wraps everything in
 * `.banner-wrap`/`.main-wrap` divs), keeping the wrapper itself hand-authored
 * in the page while only the wrapper's *content* is lifted.
 */
export function topLevelElements(html) {
  const src = String(html);
  const scanner = new RegExp(TAG_SCANNER_SRC, 'g');
  const elements = [];
  let current = null; // { tag, start, innerStart, depth }
  let m;
  while ((m = scanner.exec(src))) {
    if (m[0].startsWith('<!--')) continue;
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (isClose) {
      if (!current) continue;
      current.depth--;
      if (current.depth === 0) {
        elements.push({
          tag: current.tag,
          start: current.start,
          innerStart: current.innerStart,
          innerEnd: m.index,
          end: scanner.lastIndex,
        });
        current = null;
      }
      continue;
    }
    const selfClosed = m[3].trimEnd().endsWith('/') || VOID_TAGS.has(tag);
    if (current) {
      if (!selfClosed) current.depth++;
      continue;
    }
    if (selfClosed) {
      elements.push({ tag, start: m.index, innerStart: scanner.lastIndex, innerEnd: scanner.lastIndex, end: scanner.lastIndex });
      continue;
    }
    current = { tag, start: m.index, innerStart: scanner.lastIndex, depth: 1 };
  }
  if (current) {
    elements.push({ tag: current.tag, start: current.start, innerStart: current.innerStart, innerEnd: src.length, end: src.length });
  }
  return elements;
}
