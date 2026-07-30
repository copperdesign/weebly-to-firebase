// w2f cms test suite — written test-first from dev/plans/cms.md (Stage 2.5).
// Guard: touches only test/**; source modules are expected to not exist until Stage 3.
//
// Unit tests for lib/html-markdown.mjs's htmlToMarkdown() (plan Step 2):
// `{ markdown, unconvertible }` for the common cases, raw-passthrough +
// unconvertible:true for anything it can't safely convert, and a
// never-throws guarantee (the converter is called on messy, real-world
// Weebly markup — it must degrade, never crash the cms command).
//
// Static top-level import is intentional — see extract.test.mjs's header
// for why (this is the second of the two "pure unit" files).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../lib/html-markdown.mjs';

test('p/a/strong/em happy path', () => {
  const { markdown, unconvertible } = htmlToMarkdown(
    '<p>Visit <a href="/about">our page</a> for <strong>bold</strong> and <em>italic</em> text.</p>',
  );
  assert.match(markdown, /Visit \[our page\]\(\/about\) for \*\*bold\*\* and \*italic\* text\./);
  assert.equal(unconvertible, false);
});

test('b/i are treated as strong/em synonyms', () => {
  const { markdown, unconvertible } = htmlToMarkdown('<p><b>bold</b> and <i>italic</i>.</p>');
  assert.match(markdown, /\*\*bold\*\* and \*italic\*\./);
  assert.equal(unconvertible, false);
});

test('ul happy path', () => {
  const { markdown, unconvertible } = htmlToMarkdown('<ul><li>One</li><li>Two</li></ul>');
  assert.match(markdown, /-\s+One/);
  assert.match(markdown, /-\s+Two/);
  assert.equal(unconvertible, false);
});

test('ol happy path', () => {
  const { markdown, unconvertible } = htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>');
  assert.match(markdown, /1\.\s+First/);
  assert.match(markdown, /\d+\.\s+Second/);
  assert.equal(unconvertible, false);
});

test('br → newline (marked breaks:true re-renders \\n as <br>)', () => {
  const { markdown } = htmlToMarkdown('<p>Line one<br>Line two</p>');
  assert.match(markdown, /Line one\nLine two/);
});

test('entity decoding in text runs', () => {
  const { markdown } = htmlToMarkdown('<p>Tom &amp; Jerry say &quot;hi&quot;.</p>');
  assert.match(markdown, /Tom & Jerry say "hi"\./);
});

test('nested inline markup resolves innermost-first', () => {
  const { markdown } = htmlToMarkdown('<p><strong>Bold <em>and italic</em> text</strong>.</p>');
  assert.match(markdown, /\*\*Bold \*and italic\* text\*\*\./);
});

test('img → inline markdown image', () => {
  const { markdown, unconvertible } = htmlToMarkdown('<p><img src="/assets/gfx/pixel.png" alt="Pixel"></p>');
  assert.match(markdown, /!\[Pixel\]\(\/assets\/gfx\/pixel\.png\)/);
  assert.equal(unconvertible, false);
});

test('table passes through raw and flips unconvertible', () => {
  const html = '<table><tr><td>A</td><td>B</td></tr></table>';
  const { markdown, unconvertible } = htmlToMarkdown(html);
  assert.match(markdown, /<table>/);
  assert.equal(unconvertible, true);
});

test('iframe passes through raw and flips unconvertible', () => {
  const html = '<iframe src="https://example.com/embed"></iframe>';
  const { markdown, unconvertible } = htmlToMarkdown(html);
  assert.match(markdown, /<iframe/);
  assert.equal(unconvertible, true);
});

test('nested list passes through raw and flips unconvertible', () => {
  const html = '<ul><li>Top<ul><li>Nested</li></ul></li></ul>';
  const { unconvertible } = htmlToMarkdown(html);
  assert.equal(unconvertible, true);
});

test('never throws: unclosed tags, stray <, and $-token content', () => {
  const cases = [
    '<p>Unclosed paragraph',
    '<p>5 < 10 and a stray <</p>',
    "<p>Deal: $&amp;5, or $& raw, or $'quote$`.</p>",
    '<div><p>Half-open<div>',
    '',
    '<p></p>',
  ];
  for (const html of cases) {
    assert.doesNotThrow(() => htmlToMarkdown(html));
    const result = htmlToMarkdown(html);
    assert.equal(typeof result.markdown, 'string');
    assert.equal(typeof result.unconvertible, 'boolean');
  }
});

// — Review-fix regressions (Stage 3.5) —

test('literal markdown metacharacters in text are escaped, not reinterpreted', () => {
  const { markdown, unconvertible } = htmlToMarkdown('<p>Rated ***** by clients — use *args and _refs_ here.</p>');
  assert.equal(unconvertible, false);
  assert.match(markdown, /\\\*\\\*\\\*\\\*\\\*/);
  assert.match(markdown, /\\\*args/);
  assert.match(markdown, /\\_refs\\_/);
});

test('line-leading list/heading markers in literal text are escaped', () => {
  const { markdown } = htmlToMarkdown('<p>1. not a list<br># not a heading<br>- not a bullet</p>');
  assert.match(markdown, /1\\\. not a list/);
  assert.match(markdown, /\\# not a heading/);
  assert.match(markdown, /\\- not a bullet/);
});

test('entity-like and HTML-like literal text survives via entity escapes', () => {
  const { markdown } = htmlToMarkdown('<p>Say &amp;copy; and 5 &lt;b&gt; 3</p>');
  // decoded "&copy;" must re-encode its & so marked doesn't render ©
  assert.match(markdown, /&amp;copy;/);
  // decoded "<b>" must not survive as a bare tag opener
  assert.match(markdown, /&lt;b/);
});

test('numeric entities decode in text and headings', () => {
  const { markdown } = htmlToMarkdown('<p>It&#8217;s here &#8212; finally</p>');
  assert.match(markdown, /It’s here — finally/);
});

test('parens in image/link URLs are percent-encoded so markdown stays parseable', () => {
  const { markdown } = htmlToMarkdown('<p><img src="/assets/gfx/team(1).jpg" alt="Team"><a href="/files/doc(final).pdf">doc</a></p>');
  assert.match(markdown, /!\[Team\]\(\/assets\/gfx\/team%281%29\.jpg\)/);
  assert.match(markdown, /\[doc\]\(\/files\/doc%28final%29\.pdf\)/);
});

test('stray close tag in a text run passes through raw instead of being stripped', () => {
  const { markdown, unconvertible } = htmlToMarkdown('orphaned text</div> more');
  assert.equal(unconvertible, true);
  assert.match(markdown, /<\/div>/);
});
