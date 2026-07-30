/**
 * htmlToMarkdown(html) -> { markdown, unconvertible }
 *
 * Zero-dep HTML→markdown converter for `cms`'s content-lift step. Converts
 * the common cases a ported Weebly section actually contains — p, a,
 * strong/b, em/i, ul/ol/li (single level), br, img, h3–h6 — and leaves
 * anything it doesn't understand as raw HTML in the output (markdown
 * tolerates embedded HTML) while flipping `unconvertible` so the caller can
 * TODO-flag the generated YAML rather than silently mangling content.
 *
 * Not a DOM parser — same tag-depth-balancing regex register as
 * lib/extract.mjs, walked block-by-block. Every `.replace()` here uses a
 * replacement *function*, never a string with the matched groups spliced
 * in — content lifted from a decade-old Weebly export routinely contains
 * literal `$`, and String.replace's `$&`/`$1` token expansion only fires on
 * string replacements, so this sidesteps that bug class entirely (same rule
 * commands/port.mjs's writePageMain follows).
 */

import { decodeEntities } from './extract.mjs';

// Tags this converter treats as block-level boundaries when walking a
// fragment. `img` is void (self-closing); everything else needs a matching
// close tag, found via depth-balancing (see splitTopLevelBlocks).
const BLOCK_OPEN_RE = /<(p|ul|ol|div|figure|blockquote|form|table|iframe|img|h[3-6])\b[^>]*>/gi;

// Any of these appearing *inside* a block we're about to convert means the
// block isn't "just inline content" — bail to raw passthrough rather than
// silently flattening structure the inline converter doesn't understand.
const NESTED_BLOCK_TEST_RE = /<(table|iframe|ul|ol|div|form|figure|blockquote|h[1-6])\b/i;

/**
 * Walk `html` at the top level, splitting it into a sequence of blocks:
 * `{ type: 'text', html }` for bare runs between recognized block tags,
 * `{ type: 'img', outer }` for void image tags, and
 * `{ type: <tagName>, outer, inner }` for everything else — `outer` is the
 * full `<tag>…</tag>` (for raw passthrough), `inner` is the content between.
 *
 * Self-closing tags (`<div … />`, stray `<iframe/>`) are treated as void
 * regardless of tag name — otherwise an unclosed container would send the
 * depth-balancer hunting for a `</tag>` that will never appear, swallowing
 * the rest of the fragment into one raw block.
 *
 * Malformed markup (an opening tag with no matching close anywhere in the
 * fragment) degrades to a single raw block covering the remainder — never
 * throws, worst case is full passthrough.
 */
function splitTopLevelBlocks(html) {
  const blocks = [];
  let cursor = 0;
  while (cursor < html.length) {
    BLOCK_OPEN_RE.lastIndex = cursor;
    const m = BLOCK_OPEN_RE.exec(html);
    if (!m) {
      const text = html.slice(cursor);
      if (text.trim()) blocks.push({ type: 'text', html: text });
      break;
    }
    if (m.index > cursor) {
      const text = html.slice(cursor, m.index);
      if (text.trim()) blocks.push({ type: 'text', html: text });
    }
    const tag = m[1].toLowerCase();
    if (tag === 'img' || m[0].trimEnd().endsWith('/>')) {
      blocks.push({ type: tag === 'img' ? 'img' : tag, outer: m[0], inner: '' });
      cursor = m.index + m[0].length;
      continue;
    }
    const openAllRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    const closeAllRe = new RegExp(`<\\/${tag}>`, 'gi');
    let depth = 1;
    let scan = m.index + m[0].length;
    let closeIdx = -1;
    while (depth > 0) {
      openAllRe.lastIndex = scan;
      closeAllRe.lastIndex = scan;
      const nextOpen = openAllRe.exec(html);
      const nextClose = closeAllRe.exec(html);
      if (!nextClose) { closeIdx = -1; break; }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        scan = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        scan = nextClose.index + nextClose[0].length;
        if (depth === 0) closeIdx = nextClose.index;
      }
    }
    if (closeIdx === -1) {
      blocks.push({ type: 'raw', outer: html.slice(m.index) });
      cursor = html.length;
      break;
    }
    blocks.push({
      type: tag,
      outer: html.slice(m.index, scan),
      inner: html.slice(m.index + m[0].length, closeIdx),
    });
    cursor = scan;
  }
  return blocks;
}

/**
 * Backslash-escape markdown-active characters in a run of literal text so
 * genuine content (`*args`, "Rated ***** by clients", `5 < 6 & more`)
 * survives the later `marked` parse as the characters the page actually
 * showed. Two passes:
 *   - anywhere: `\` (first, so it doesn't re-escape our own escapes), then
 *     backtick, *, _, [, ], ~, <, & — the inline-syntax openers marked
 *     recognizes under gfm.
 *   - line-leading: #, >, and the list markers (-, +, digits+.) become
 *     escaped so a text line starting with "1. " doesn't turn into a list.
 * CommonMark defines backslash-before-punctuation as the literal character,
 * so every escape here round-trips exactly.
 */
function escapeMarkdownText(text) {
  return text
    .replace(/[\\`*_[\]~]/g, ch => `\\${ch}`)
    // & and < use entity form, not backslashes — a literal `\<` would put a
    // bare `<` back into the working string and derail the later tag-strip
    // pass. Escaped only where marked would actually interpret them: `&`
    // when it looks like the start of an entity reference, `<` when it
    // could open inline HTML, `>` only at line starts (blockquote).
    .replace(/&(?=[a-zA-Z][a-zA-Z0-9]*;|#\d|#[xX])/g, '&amp;')
    .replace(/<(?=[a-zA-Z/!?])/g, '&lt;')
    .replace(/^([ \t]*)>/gm, (_, ws) => `${ws}&gt;`)
    .replace(/^([ \t]*)(#{1,6}[ \t]|[-+][ \t])/gm, (_, ws, marker) => `${ws}\\${marker}`)
    .replace(/^([ \t]*)(\d+)([.)][ \t])/gm, (_, ws, num, rest) => `${ws}${num}\\${rest}`);
}

/**
 * Percent-encode the characters that break a markdown `(url)` destination —
 * parens themselves (Weebly's duplicate-upload names: `photo(1).jpg`) and
 * spaces. Deliberately narrow: a broad encodeURI would double-encode any
 * already-encoded source. `decodeMarkdownUrl` is the inverse, used by `cms`
 * when it needs the on-disk path back.
 */
export function encodeMarkdownUrl(url) {
  return String(url).replace(/[() ]/g, ch => ch === '(' ? '%28' : ch === ')' ? '%29' : '%20');
}

/** Inverse of encodeMarkdownUrl (full percent-decode; identity on bad input). */
export function decodeMarkdownUrl(url) {
  try { return decodeURIComponent(String(url)); } catch { return String(url); }
}

/** Extract `src`/`alt` from a single `<img …>` tag and emit `![alt](src)`. */
function imgToMarkdown(imgTag) {
  const src = imgTag.match(/\ssrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  const alt = imgTag.match(/\salt\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  // Alt is literal text inside […] — escape the closers; src goes through
  // the url encoder so parens in filenames don't truncate the destination.
  const altSafe = decodeEntities(alt).replace(/[\\[\]]/g, ch => `\\${ch}`);
  return `![${altSafe}](${encodeMarkdownUrl(decodeEntities(src))})`;
}

/**
 * Convert inline markup inside a single block's content to markdown: bold,
 * italic, links, images, line breaks, then strip whatever tags are left
 * (unknown inline elements like `<span>` — keep the text, drop the wrapper)
 * and decode entities last so `&amp;` inside a converted link's visible
 * text doesn't get double-processed by an earlier pass.
 *
 * strong/b and em/i each run in their own stabilizing loop (replace until
 * the string stops changing) so nested same-family tags — rare, but Weebly
 * exports aren't hand-written — resolve correctly: the innermost pair
 * converts first, then the loop's next pass sees plain `**`/`*` delimiters
 * and the outer tag with nothing left to match, so it's a no-op on the next
 * iteration rather than double-wrapping.
 */
function inlineConvert(html) {
  let s = html;
  // Text runs first: decode entities, then backslash-escape markdown-active
  // characters — BEFORE any conversion below injects markdown syntax of its
  // own (`**`, `[…](…)`) that must NOT be escaped. Runs on the segments
  // between tags only, so attribute values (hrefs, alts) are untouched here
  // and handled per-conversion below. Decoding happens exactly once, in
  // this pass — no trailing decode, which would double-decode `&amp;lt;`.
  s = s.replace(/(^|>)([^<]+)(?=<|$)/g, (_, pre, text) => pre + escapeMarkdownText(decodeEntities(text)));
  let prev;
  do {
    prev = s;
    s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => `**${inner}**`);
  } while (s !== prev);
  do {
    prev = s;
    s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => `*${inner}*`);
  } while (s !== prev);
  s = s.replace(/<img\b[^>]*?>/gi, m => imgToMarkdown(m));
  s = s.replace(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `[${text.trim()}](${encodeMarkdownUrl(decodeEntities(href))})`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

/**
 * Split a `<ul>`/`<ol>`'s inner HTML into top-level `<li>` bodies. Returns
 * `null` on malformed markup (an `<li>` with no matching close) so the
 * caller falls back to raw passthrough instead of dropping content.
 */
function extractListItems(html) {
  const items = [];
  const openRe = /<li\b[^>]*>/gi;
  let cursor = 0;
  while (cursor < html.length) {
    openRe.lastIndex = cursor;
    const m = openRe.exec(html);
    if (!m) break;
    const openAllRe = /<li\b[^>]*>/gi;
    const closeAllRe = /<\/li>/gi;
    let depth = 1;
    let scan = m.index + m[0].length;
    let closeIdx = -1;
    while (depth > 0) {
      openAllRe.lastIndex = scan;
      closeAllRe.lastIndex = scan;
      const nextOpen = openAllRe.exec(html);
      const nextClose = closeAllRe.exec(html);
      if (!nextClose) { closeIdx = -1; break; }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        scan = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        scan = nextClose.index + nextClose[0].length;
        if (depth === 0) closeIdx = nextClose.index;
      }
    }
    if (closeIdx === -1) return null;
    items.push(html.slice(m.index + m[0].length, closeIdx));
    cursor = scan;
  }
  return items;
}

/** `<ul>`/`<ol>` → `- `/`1. ` lines. Nested lists are unconvertible passthrough. */
function renderList(block) {
  if (/<(ul|ol)\b/i.test(block.inner)) return { markdown: block.outer, unconvertible: true };
  const items = extractListItems(block.inner);
  if (items === null) return { markdown: block.outer, unconvertible: true };
  let unconvertible = false;
  const lines = items.map((itemHtml, idx) => {
    if (NESTED_BLOCK_TEST_RE.test(itemHtml)) {
      unconvertible = true;
      return itemHtml.trim();
    }
    const prefix = block.type === 'ol' ? `${idx + 1}. ` : '- ';
    return prefix + inlineConvert(itemHtml).replace(/\n+/g, ' ').trim();
  });
  return { markdown: lines.join('\n'), unconvertible };
}

/**
 * `div`/`figure`/`blockquote` aren't markdown concepts — Weebly wraps
 * everything in divs, so rather than hand-picking which wrapper classes are
 * "meaningful," recurse into the wrapper's own content and re-run the block
 * splitter/renderer on it. A div containing only paragraphs converts
 * cleanly; a div containing a table or nested list still bails to raw
 * passthrough, because that flag comes from the nested block's own render,
 * not a guess about the wrapper's class name.
 */
function renderContainer(block) {
  const subBlocks = splitTopLevelBlocks(block.inner);
  const rendered = [];
  let unconvertible = false;
  for (const sub of subBlocks) {
    const r = renderBlock(sub);
    if (r.unconvertible) unconvertible = true;
    if (r.markdown && r.markdown.trim()) rendered.push(r.markdown.trim());
  }
  return { markdown: rendered.join('\n\n'), unconvertible };
}

function renderBlock(block) {
  switch (block.type) {
    case 'text':
      if (NESTED_BLOCK_TEST_RE.test(block.html)) return { markdown: block.html, unconvertible: true };
      // A stray *close* tag in a bare text run means the fragment is
      // unbalanced (splitAtHeadings guarantees it isn't, but this converter
      // is also called on arbitrary sub-fragments) — pass through raw
      // rather than letting the tag-strip below swallow it silently.
      if (/<\/(div|ul|ol|table|form|figure|blockquote|section|article|h[1-6])\b/i.test(block.html)) {
        return { markdown: block.html, unconvertible: true };
      }
      return { markdown: inlineConvert(block.html), unconvertible: false };
    case 'p':
      if (NESTED_BLOCK_TEST_RE.test(block.inner)) return { markdown: block.outer, unconvertible: true };
      return { markdown: inlineConvert(block.inner), unconvertible: false };
    case 'h3': case 'h4': case 'h5': case 'h6': {
      if (NESTED_BLOCK_TEST_RE.test(block.inner)) return { markdown: block.outer, unconvertible: true };
      const level = Number(block.type[1]);
      return { markdown: `${'#'.repeat(level)} ${inlineConvert(block.inner)}`, unconvertible: false };
    }
    case 'img':
      return { markdown: imgToMarkdown(block.outer), unconvertible: false };
    case 'ul': case 'ol':
      return renderList(block);
    case 'div': case 'figure': case 'blockquote':
      return renderContainer(block);
    // form/table/iframe: no markdown equivalent worth inventing — table
    // structure and iframe embeds pass through verbatim, flagged for review.
    // (`cms` never actually feeds form markup here — it stops lifting at the
    // first `<form>` — this branch exists for defense-in-depth only.)
    case 'form': case 'table': case 'iframe': case 'raw':
    default:
      return { markdown: block.outer, unconvertible: true };
  }
}

/**
 * Convert a fragment of ported HTML to markdown. See file header for the
 * conversion rules and the `$`-token safety note. Blocks are separated by a
 * single blank line; trailing whitespace is trimmed. Never throws — a
 * fragment that can't be parsed at all degrades to raw passthrough with
 * `unconvertible: true`.
 */
export function htmlToMarkdown(html) {
  try {
    const input = html == null ? '' : String(html);
    const blocks = splitTopLevelBlocks(input);
    const rendered = [];
    let unconvertible = false;
    for (const block of blocks) {
      const r = renderBlock(block);
      if (r.unconvertible) unconvertible = true;
      if (r.markdown && r.markdown.trim()) rendered.push(r.markdown.trim());
    }
    return { markdown: rendered.join('\n\n').trim(), unconvertible };
  } catch {
    return { markdown: html == null ? '' : String(html), unconvertible: true };
  }
}
