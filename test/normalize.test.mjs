// w2f cms test suite — written test-first from dev/plans/cms.md (Stage 2.5).
// Guard: touches only test/**; source modules are expected to not exist until Stage 3.
//
// Self-tests for test/helpers/normalize.mjs — this is test infrastructure
// the round-trip suite depends on, so it's verified green on its own,
// independent of any cms/lib module that doesn't exist yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHtml } from './helpers/normalize.mjs';

test('normalizeHtml — whitespace collapse + attribute ordering + entity decoding', () => {
  const a = normalizeHtml(`
    <p   class="lead"   id="x">Tom &amp; Jerry</p>
  `);
  const b = normalizeHtml('<p id="x" class="lead">Tom & Jerry</p>');
  assert.equal(a, b);
});

test('normalizeHtml — b/i fold to strong/em, self-closing tags normalize', () => {
  const a = normalizeHtml('<p><b>bold</b> and <i>italic</i></p><img src="/x.png"/>');
  const b = normalizeHtml('<p><strong>bold</strong> and <em>italic</em></p><img src="/x.png">');
  assert.equal(a, b);
});

test('normalizeHtml — h1 does NOT fold to h2 (levels are part of the round-trip contract)', () => {
  const a = normalizeHtml('<h1>Welcome</h1><p>Body</p>');
  const b = normalizeHtml('<h2>Welcome</h2><p>Body</p>');
  assert.notEqual(a, b);
});

test('normalizeHtml — bare figure wrapper around an image unwraps', () => {
  const wrapped = normalizeHtml('<figure><img src="/x.png"></figure>');
  const bare = normalizeHtml('<img src="/x.png">');
  assert.equal(wrapped, bare);
});

test('normalizeHtml — strips w2f-section wrappers around the same content', () => {
  const wrapped = normalizeHtml('<section class="w2f-section"><h2>Hi</h2><p>Body</p></section>');
  const bare = normalizeHtml('<h2>Hi</h2><p>Body</p>');
  assert.equal(wrapped, bare);
});

test('normalizeHtml — asset-path mapping rewrites built refs back to originals', () => {
  const built = normalizeHtml('<img src="/assets/files/pixel.png" alt="x">', {
    assetMap: { '/assets/files/pixel.png': '/assets/gfx/pixel.png' },
  });
  const original = normalizeHtml('<img src="/assets/gfx/pixel.png" alt="x">');
  assert.equal(built, original);
});

test('normalizeHtml — compact and pretty-printed tag adjacency compare equal', () => {
  const compact = normalizeHtml('<h2>Hi</h2><p>Body</p>');
  const spaced = normalizeHtml('<h2>Hi</h2>\n  <p>Body</p>');
  assert.equal(compact, spaced);
});
