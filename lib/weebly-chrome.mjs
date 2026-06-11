/**
 * Weebly chrome deny-list — Weebly-shipped UI sprites and chrome stylesheets
 * that no migrated site uses. Centralized so `port`'s download paths and
 * stylesheet-dump loop can both short-circuit on a single source of truth.
 *
 * Why this exists: post-port cleanup of a real migration (nele-quaas)
 * deleted ~70 unreferenced PNG/GIF files from `public/assets/gfx/`,
 * basically all of them Weebly sprite chrome dragged in by `url(…)`
 * references inside the dumped CSS. The CSS rules themselves get stripped
 * the moment the user retires the `_w2f-*.less` compat layer; the files
 * just sit there orphaned. Cheaper to never download them.
 *
 * Categories (image patterns):
 *   - Fancybox modal sprites
 *   - Social share sprites
 *   - Commerce / cart / payment sprites
 *   - Form / search / select / checkbox sprites
 *   - Blog comment chrome
 *   - Generic loaders + spinners
 *   - Media-player chrome (volume, play, print)
 *   - Decorative bars / triangles / gradients
 *   - Weebly fallbacks (blank, error, sad-face, next/prev labels)
 *   - Anonymous `@2x-s<hash>.png` retina sprites
 *
 * Categories (stylesheet URL patterns): Fancybox skin, social-icons skin,
 * commerce skin, VideoJS skin, Select2 skin. These are whole CDN
 * stylesheets Weebly ships; skipping them avoids writing `_w2f-fancybox.less`
 * et al. that only exist to be deleted.
 *
 * Match scope: filenames are matched against the *basename* derived by
 * `basenameFromUrl` (decoded, cache-buster stripped). Stylesheet patterns
 * test the full URL.
 *
 * Conservative on purpose: each pattern targets a specific Weebly naming
 * convention. A user content image called `loading.gif` is in principle
 * possible but in practice vanishingly unlikely; the cost of one false
 * positive (re-download by hand) is much smaller than the cost of 70+
 * false negatives (manual deletion per migration).
 */

export const CHROME_IMAGE_PATTERNS = [
  // Fancybox modal sprites
  /^fancybox_/i,

  // Social share sprites
  /^social[-_]icons?(?:-s[0-9a-f]+)?\.png$/i,

  // Commerce / cart / payment
  /^commerce-s[0-9a-f]+\.png$/i,
  /^mini-cart-s[0-9a-f]+\.png$/i,
  /^paypal\.png$/i,
  /^credit-cards\.png$/i,

  // Form / search / select / checkbox sprites
  /^forms-s[0-9a-f]+\.png$/i,
  /^select-dropdown\.png$/i,
  /^select2(?:x2)?\.png$/i,
  /^select2-spinner\.gif$/i,
  /^checkmarkBox-s[0-9a-f]+\.png$/i,
  /^checkmark-mini\.png$/i,
  /^magnifying-glass\.png$/i,
  /^search-(?:input-bg|light|pagination-bg)\.(?:png|jpe?g)$/i,
  /^videojs-s[0-9a-f]+\.png$/i,

  // Blog comment chrome (light + dark variants)
  /^(?:dark-)?blog-comment-/i,

  // Generic loaders + spinners
  /^loading(?:[-_.]|$)/i,
  /^loader\.gif$/i,
  /^spinner-(?:dark|light)\.png$/i,

  // Media-player chrome
  /^volume-(?:filled|mute)\.png$/i,
  /^play-icon\.png$/i,
  /^print(?:@2x)?\.png$/i,

  // Decorative bars / triangles / gradients
  /^blue-bar\.png$/i,
  /^white-bar\.png$/i,
  /^gradient\.png$/i,
  /^top-triangle-[0-9a-f]+(?:@2x)?\.png$/i,
  /^bottom-triangle-[0-9a-f]+(?:@2x)?\.png$/i,
  /^maximize-icon\.png$/i,
  /^minimize-icon\.png$/i,
  /^loading-icon\.png$/i,

  // Default chrome backgrounds + sizing variants
  /^default-bg\.(?:jpe?g|png)$/i,
  /^(?:large|small)_(?:blue|grey)\.png$/i,
  /^icons(?:@2x)?\.png$/i,
  /^form_input_bg\.gif$/i,

  // Weebly UI fallbacks
  /^blank\.gif$/i,
  /^error\.gif$/i,
  /^nextlabel\.gif$/i,
  /^prevlabel\.gif$/i,
  /^sad-face\.png$/i,

  // Anonymous retina sprite hash (e.g. `@2x-s47607b315a.png`)
  /^@2x-s[0-9a-f]+\.png$/i,
];

export const CHROME_STYLESHEET_PATTERNS = [
  // Whole CDN stylesheets Weebly ships for features no migrated site uses.
  // Each pattern is loose-ish on slash boundaries so cache-buster suffixes
  // and per-build basenames (`fancybox.css`, `fancybox-v3.css`, …) all match.
  /\/fancybox(?:[.\-_/]|$)/i,
  /\/social[-_]icons(?:[.\-_/]|$)/i,
  /\/commerce(?:[.\-_/]|$)/i,
  /\/videojs(?:[.\-_/]|$)/i,
  /\/select2(?:[.\-_/]|$)/i,
];

/** True when `filename` (already-decoded basename) matches a chrome pattern. */
export function isChromeImage(filename) {
  if (!filename) return false;
  return CHROME_IMAGE_PATTERNS.some(re => re.test(filename));
}

/** True when `url` (full absolute URL) matches a chrome-stylesheet pattern. */
export function isChromeStylesheet(url) {
  if (!url) return false;
  return CHROME_STYLESHEET_PATTERNS.some(re => re.test(url));
}
