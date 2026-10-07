// Regression (kalabalindy.com, 2026-10-07): port fetched wget's on-disk
// names as if they were live URLs. Relative <img> srcs were never fetched
// at all, and the theme stylesheet `files/main_style.css%3F…css` 404'd, so
// the scaffold shipped with no theme CSS and every content image remote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveUrlFromMirrorRef } from '../commands/port.mjs';

const BASE = 'https://www.kalabalindy.com/';

test('relative image ref resolves against the live host with its cache-buster restored', () => {
  assert.equal(
    liveUrlFromMirrorRef('uploads/7/7/5/1/77517302/published/konferdans.jpg%3F1773743280', BASE),
    'https://www.kalabalindy.com/uploads/7/7/5/1/77517302/published/konferdans.jpg?1773743280',
  );
});

test('wget --adjust-extension suffix after the query is dropped', () => {
  assert.equal(
    liveUrlFromMirrorRef('files/main_style.css%3F1791190467.css', BASE),
    'https://www.kalabalindy.com/files/main_style.css?1791190467',
  );
});

test('absolute CDN URLs and plain paths pass through unchanged', () => {
  const cdn = 'https://cdn11.editmysite.com/css/sites.css?buildtime=1790976150';
  assert.equal(liveUrlFromMirrorRef(cdn, BASE), cdn);
  assert.equal(liveUrlFromMirrorRef('files/theme/plugins.css', BASE), 'https://www.kalabalindy.com/files/theme/plugins.css');
});
