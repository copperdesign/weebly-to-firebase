// w2f cms test suite — written test-first from dev/plans/cms.md (Stage 2.5).
// Guard: touches only test/**; source modules are expected to not exist until Stage 3.
//
// Unit tests for lib/extract.mjs — the four extraction primitives moved
// verbatim out of commands/port.mjs (plan Step 1: extractTag,
// extractByIdOrClass, extractElement, tryEach), the isSkeleton predicate
// (also moved, plan Step 4 note), and the two new exports commands/cms.mjs
// is built on: splitAtHeadings() and textContent().
//
// Static top-level import is intentional here — this is one of the two
// "pure unit" files called out in the test-writer brief. Right now the
// import throws ERR_MODULE_NOT_FOUND (lib/extract.mjs doesn't exist until
// Stage 3), which fails this whole file cleanly rather than per-test; that
// is the expected test-first state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAtHeadings,
  textContent,
  extractTag,
  extractByIdOrClass,
  extractElement,
  tryEach,
  isSkeleton,
} from '../lib/extract.mjs';

test('splitAtHeadings — h1+h2 page: correct lead/sections/headingText', () => {
  const html = `
    <p>Lead paragraph before any heading.</p>
    <h1>Welcome</h1>
    <p>Section one body.</p>
    <h2>Details</h2>
    <p>Section two body.</p>
  `;
  const { lead, sections } = splitAtHeadings(html);
  assert.match(lead, /Lead paragraph before any heading\./);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].level, 1);
  assert.equal(sections[0].headingText, 'Welcome');
  assert.match(sections[0].body, /Section one body\./);
  assert.equal(sections[1].level, 2);
  assert.equal(sections[1].headingText, 'Details');
  assert.match(sections[1].body, /Section two body\./);
});

test('splitAtHeadings — heading with attributes + nested <span>', () => {
  const html = '<h2 id="about" class="big"><span>Our</span> Story</h2><p>Body text.</p>';
  const { sections } = splitAtHeadings(html);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].level, 2);
  assert.equal(sections[0].headingText, 'Our Story');
  assert.match(sections[0].headingHtml, /<span>Our<\/span> Story/);
  assert.match(sections[0].body, /Body text\./);
});

test('splitAtHeadings — no headings → { lead: all, sections: [] }', () => {
  const html = '<p>Just a paragraph, nothing else.</p>';
  const { lead, sections } = splitAtHeadings(html);
  assert.equal(lead, html);
  assert.deepEqual(sections, []);
});

test('splitAtHeadings — adjacent headings produce an empty-body section', () => {
  const html = '<h2>First</h2><h2>Second</h2><p>Only under second.</p>';
  const { sections } = splitAtHeadings(html);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].headingText, 'First');
  assert.equal(sections[0].body.trim(), '');
  assert.equal(sections[1].headingText, 'Second');
  assert.match(sections[1].body, /Only under second\./);
});

test('textContent — strips tags, decodes common entities, collapses whitespace', () => {
  const out = textContent('  <span>Tom &amp; Jerry</span>\n  say &quot;hi&quot;  ');
  assert.equal(out, 'Tom & Jerry say "hi"');
});

test('textContent — decodes &nbsp; and &#39; / &lt; / &gt;', () => {
  const out = textContent("It&#39;s&nbsp;&lt;fun&gt;");
  assert.equal(out, "It's <fun>");
});

// Smoke-import: pins the module's public surface (plan Step 1) so a future
// refactor that accidentally drops an export fails loudly here, rather than
// deep inside port.mjs's or cms.mjs's own call sites.
test('extract.mjs exports the full primitive register, each still working', () => {
  for (const fn of [extractTag, extractByIdOrClass, extractElement, tryEach, isSkeleton]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(extractTag('<main>hi</main>', 'main'), 'hi');
  assert.equal(extractByIdOrClass('<div id="x">y</div>', 'x'), 'y');
  assert.equal(extractElement('<div id="x">y</div>', 'x'), '<div id="x">y</div>');
  assert.equal(tryEach('<main>hi</main>', [h => extractTag(h, 'main')]), 'hi');
  assert.equal(isSkeleton('<!-- TODO: port content from foo -->'), true);
  assert.equal(isSkeleton('<p>real content</p>'), false);
});

// — Review-fix regressions (Stage 3.5) —

test('splitAtHeadings — nested headings are NOT boundaries (fragments stay balanced)', () => {
  const html = '<div class="wsite-section"><h2>Services</h2><p>Body</p></div>';
  const { lead, sections } = splitAtHeadings(html);
  assert.equal(sections.length, 0);
  assert.equal(lead, html);
});

test('splitAtHeadings — top-level headings still split; commented-out headings ignored', () => {
  const html = '<!-- <h2>ghost</h2> --><p>lead</p><h2>Real</h2><p>body</p>';
  const { lead, sections } = splitAtHeadings(html);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].headingText, 'Real');
  assert.match(lead, /lead/);
  assert.doesNotMatch(lead, /Real/);
});

test('splitAtHeadings — keeps heading level (h1 vs h2)', () => {
  const { sections } = splitAtHeadings('<h1>One</h1><p>a</p><h2>Two</h2><p>b</p>');
  assert.equal(sections[0].level, 1);
  assert.equal(sections[1].level, 2);
});

test('topLevelElements — enumerates only depth-0 elements, comment-safe', async () => {
  const { topLevelElements } = await import('../lib/extract.mjs');
  const html = '<div class="a"><h2>X</h2><div>nested</div></div><!-- <div>ghost</div> --><p>sibling</p>';
  const els = topLevelElements(html);
  assert.equal(els.length, 2);
  assert.equal(els[0].tag, 'div');
  assert.equal(els[1].tag, 'p');
  assert.match(html.slice(els[0].innerStart, els[0].innerEnd), /nested/);
});

test('decodeEntities — numeric decimal and hex references decode', async () => {
  const { decodeEntities } = await import('../lib/extract.mjs');
  assert.equal(decodeEntities('It&#8217;s &#x2014; fine &amp; good'), 'It’s — fine & good');
});
