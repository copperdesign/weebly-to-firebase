/**
 * Scaffold-time content for the reusable front-end modules a Weebly
 * migration tends to need. Two ship by default; one is opt-in behind a flag.
 *
 * The modules land unused — they're not imported by `app.js` or `main.less`
 * out of the gate. The user wires each one in when they need it. Zero cost
 * when unused (the build glob doesn't drag in standalone files), high payoff
 * when needed.
 *
 * What ships by default:
 *   - cookie-consent: a doc pointer, not code. Third-party embed consent
 *     (YouTube / SoundCloud / Google Maps) is handled by the standalone
 *     `@copperdesign/easy-cookie-consent` package — a click-to-load gate
 *     required under the German reading of § 25 TTDSG, and a good default
 *     elsewhere. We promote the package rather than ship a homegrown copy:
 *     it's a superset (i18n EN/DE, optional global modal, `gate()` /
 *     `adopt()`), MIT, ~6 KB, zero-dep. `cookie-consent.md` carries the
 *     install + wiring recipe.
 *   - lightbox: Fancybox + jQuery is what the Weebly theme used for image
 *     galleries. The chrome deny-list strips the Fancybox sprites + skin;
 *     this dependency-free module fills the gap on the *same*
 *     `rel="lightbox[group]"` HTML hook, so existing gallery markup works
 *     untouched once it's wired up.
 *
 * Opt-in only (behind `init --with-email-hider`):
 *   - email-hider: runtime `mailto:` obfuscation. Demoted on purpose —
 *     spam resistance belongs at the MX layer, not in on-page obscurity, so
 *     we no longer scaffold plain, visible email addresses behind a decoder
 *     by default. Kept available for one narrow case: a crawl of a
 *     Cloudflare-fronted Weebly site ships `data-cfemail`-obfuscated links
 *     that render broken on Firebase, and this is the quickest recovery.
 *     See `emailHiderMd()` for the caveat.
 *
 * Strings ship in English. Each module is small enough to localize in
 * place if the migrated site is German / French / etc.
 */

export function emailHiderJs() {
  return `// email-hider.js — Obfuscated mailto links, decoded at runtime.
//
// @docs src/js/email-hider.md
//
// DEMOTED / opt-in. Not scaffolded by default — you asked for it with
// \`w2f init --with-email-hider\`, or copied it in by hand. On-page email
// obscurity is no longer a default: spam resistance belongs at the MX
// layer, not the markup. The one case this still earns its place is
// recovering \`data-cfemail\` links a Cloudflare-fronted crawl left broken.
// See email-hider.md.
//
// Scraper-resistant pattern: the address is split into \`data-u\` (local
// part) and \`data-d\` (domain) attributes and never joined in source HTML.
// On load, every \`.email-hide\` element becomes a real anchor:
//
//   <a class="email-hide"
//      data-u="hello"
//      data-d="example.com"
//      data-subject="Inquiry">[enable JavaScript]</a>
//
// becomes:
//
//   <a class="email-hide" href="mailto:hello@example.com?subject=Inquiry">
//     hello@example.com
//   </a>
//
// Anything inside the element before upgrade is the no-JS fallback — keep
// it human-readable so the page still degrades gracefully.
//
// Optional attributes:
//   data-subject — prefilled subject line, URL-encoded automatically
//   data-label   — override visible text (defaults to the address itself)
//
// Replaces Weebly's Cloudflare \`__cf_email__\` decoding, which isn't
// present on a static Firebase deployment.

"use strict";

function upgrade(el) {
  const user = el.getAttribute("data-u");
  const domain = el.getAttribute("data-d");
  if (!user || !domain) return;

  const address = user + "@" + domain;
  const subject = el.getAttribute("data-subject");
  const href = subject
    ? "mailto:" + address + "?subject=" + encodeURIComponent(subject)
    : "mailto:" + address;

  el.setAttribute("href", href);
  el.textContent = el.getAttribute("data-label") || address;
}

function init() {
  document.querySelectorAll(".email-hide").forEach(upgrade);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
`;
}

export function emailHiderMd() {
  return `# email-hider

> **Demoted — opt-in only.** This module is *not* scaffolded by default.
> It ships only when you run \`w2f init --with-email-hider\` (or copy it in
> by hand). On-page email obscurity is no longer a default: spam
> resistance belongs at the MX layer (SPF/DKIM/DMARC, greylisting,
> provider filtering), not in markup tricks that also hurt legibility,
> accessibility, and copy/paste. Prefer a plain, visible \`mailto:\`.

Tiny runtime decoder for \`mailto:\` links so the address never appears as a
joined string in the static HTML — keeps trivial scrapers from harvesting
it without forcing the visitor through a contact form.

## The one reason to still reach for it

Weebly sites fronted by Cloudflare serve their email links through
Cloudflare's \`__cf_email__\` / \`data-cfemail\` obfuscation. That decoding
happens in a Cloudflare edge script that isn't present on the new static
Firebase deployment, so a crawl carries those links over as
\`[email protected]\` and they don't work.

If your ported pages have that breakage, this module is the quickest
recovery: it restores the same split-in-source/joined-at-the-client
property without the Cloudflare runtime. But the cleaner fix — and the one
that matches "visible emails, spam-handled at the MX" — is to decode the
\`data-cfemail\` back to a plain address at port time and drop the module
entirely. Reach for email-hider only when you specifically *want* the
obscurity kept.

It is not a defense against a determined scraper that runs JS. Anyone
willing to render the page can still read the address. The goal is
"don't be the lowest-hanging fruit," not "unbreakable."

## HTML contract

\`\`\`html
<a class="email-hide"
   data-u="hello"
   data-d="example.com"
   data-subject="Inquiry">[enable JavaScript]</a>
\`\`\`

| Attribute      | Required | Purpose                                          |
| -------------- | -------- | ------------------------------------------------ |
| \`data-u\`       | yes      | Local part of the address (before the \`@\`)       |
| \`data-d\`       | yes      | Domain (after the \`@\`)                           |
| \`data-subject\` | no       | Prefilled subject line, URL-encoded by the JS    |
| \`data-label\`   | no       | Override visible text — defaults to the address  |

The element's existing text content is the **no-JS fallback** — keep it
human-readable. After upgrade the JS replaces that text with either
\`data-label\` or the reconstructed address.

## Wiring it up

Import it from \`src/js/app.js\`:

\`\`\`js
import "./email-hider.js";
\`\`\`

## Why not \`unicode-bidi: bidi-override\`?

The reversed-string CSS trick displays the address correctly to humans
without JS, but it produces a non-functional \`mailto:\` and breaks
copy/paste. The split-attribute approach degrades less weirdly: without
JS the visitor sees a clear cue to enable it; with JS they get a real,
copyable, clickable link.
`;
}

export function cookieConsentMd() {
  return `# cookie-consent

Third-party embed consent (YouTube, SoundCloud, Google Maps, …) is handled
by the standalone **[\`@copperdesign/easy-cookie-consent\`](https://github.com/copperdesign/easy-cookie-consent)**
package. This project scaffolds *this doc*, not the code — the code lives in
the package so it stays maintained in one place.

There is no \`cookie-consent.js\` in \`src/js/\`. Install the package and wire
it up as below.

## Why a consent gate at all

A traditional cookie banner — one global "OK" — does **not** make a YouTube
or Google Maps embed GDPR-conformant. By the time the user clicks "OK", the
iframe has already loaded, Google has already set cookies, and the IP
address has already been transmitted. The German reading of § 25 TTDSG
requires the third-party connection to be *withheld until* informed
consent, per provider — not retroactively justified after the fact.

\`easy-cookie-consent\` satisfies that by keeping the iframe **out of the
DOM** until the user clicks the placeholder. The browser can't fetch an
iframe that doesn't exist yet.

## Why the package instead of a homegrown module

Earlier scaffolds shipped a small in-repo \`embed-consent.js\`. It's been
retired in favour of the package, which is a superset:

- Same click-to-load gate, iframe withheld until consent
- Built-in **i18n (EN + DE)** — matches the German-client reality
- Optional **global modal** with temporary vs. permanent opt-out, or
  embed-only mode (\`showModal: false\`)
- Per-provider \`localStorage\` persistence (opting in to YouTube ≠ opting
  in to SoundCloud)
- Imperative \`gate()\` for rich integrations and \`adopt()\` to rewrite raw
  CMS-pasted embed markup into gated placeholders
- MIT, ~6 KB minified, zero dependencies, no build step required

## Install

\`\`\`bash
npm install @copperdesign/easy-cookie-consent
\`\`\`

Or vendor the single \`index.js\` — it has no dependencies and no build step.

## Wire it up

In \`src/js/app.js\`:

\`\`\`js
import easyCookieConsent from "@copperdesign/easy-cookie-consent";

easyCookieConsent({
  privacyHref: "/privacy.html",
  language: "de",        // or "en"; omit to auto-detect
  showModal: false,      // embed-only gate; set true for a global modal too
});
\`\`\`

## Author the embeds

Mark each embed in your HTML source with the provider and the real iframe
URL — the URL stays out of the document until consent (the class is
\`consent-embed\`; \`data-title\` is optional but becomes the iframe's
accessible name):

\`\`\`html
<div class="consent-embed"
     data-provider="youtube"
     data-embed="https://www.youtube.com/embed/<ID>?rel=0"
     data-title="Intro video"></div>
\`\`\`

Or paste an ordinary provider iframe and let \`adopt()\` gate it for you.
See the package README for the full provider registry, \`gate()\`, \`adopt()\`,
custom \`colors\` / \`strings\`, and the deferred-loading callbacks.

## Note on the old \`_embed-consent.less\`

The retired in-repo module shipped a companion \`_embed-consent.less\`
partial. The package styles its own placeholder (configurable via the
\`colors\` option), so no LESS partial is scaffolded here. If you're
migrating a project that still imports \`_embed-consent.less\`, drop that
\`@import\` from \`main.less\` and delete the partial.
`;
}

export function lightboxJs() {
  return `// lightbox.js — modal slideshow for image galleries.
//
// @docs src/js/lightbox.md
//
// Drop-in replacement for the legacy Fancybox setup the Weebly export
// depended on (Fancybox + jQuery are no longer bundled — the chrome
// deny-list also strips the Fancybox sprite assets at port time).
// Intercepts clicks on links marked with \`rel="lightbox[group-key]"\` —
// the same HTML hook the original theme used, so existing gallery markup
// works untouched.
//
// Group membership: every link sharing the same \`[group-key]\` forms one
// slideshow; bare \`rel="lightbox"\` becomes a single-image lightbox.
//
// Interaction surface:
//   - Click thumbnail → open at that index
//   - ← / → arrow keys → previous / next
//   - Esc → close
//   - Click backdrop (outside the image) → close
//   - On touch devices, horizontal swipe → previous / next, when Hammer
//     is loaded (the binding is guarded so the bundle still works if
//     Hammer was ever dropped)
//
// One overlay element is built lazily on first open and reused for the
// lifetime of the page — no DOM churn per slide.

"use strict";

const SELECTOR = 'a[rel^="lightbox"]';

// rel="lightbox[group-key]" → "group-key"; bare rel="lightbox" → ""
function groupKey(a) {
  const rel = a.getAttribute("rel") || "";
  const m = rel.match(/^lightbox\\[(.*)\\]$/);
  return m ? m[1] : "";
}

let overlay, imgEl, prevBtn, nextBtn, closeBtn;
let group = [];
let index = 0;

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML =
    '<button type="button" class="lightbox__close" aria-label="Close"></button>' +
    '<button type="button" class="lightbox__prev" aria-label="Previous image"></button>' +
    '<button type="button" class="lightbox__next" aria-label="Next image"></button>' +
    '<figure class="lightbox__stage"><img alt=""></figure>';
  document.body.append(overlay);

  imgEl    = overlay.querySelector("img");
  closeBtn = overlay.querySelector(".lightbox__close");
  prevBtn  = overlay.querySelector(".lightbox__prev");
  nextBtn  = overlay.querySelector(".lightbox__next");

  closeBtn.addEventListener("click", close);
  prevBtn .addEventListener("click", () => step(-1));
  nextBtn .addEventListener("click", () => step(1));

  // Backdrop click closes — but only when the click really landed on the
  // backdrop, not bubbled up from the image or a button.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Touch swipe via Hammer, when present. Guarded so desktop builds
  // don't fail if Hammer was ever dropped from the bundle.
  if ("ontouchstart" in window && typeof window.Hammer === "function") {
    const mc = new window.Hammer(overlay);
    mc.on("panleft",  () => step(1));
    mc.on("panright", () => step(-1));
  }
}

function open(links, startIndex) {
  ensureOverlay();
  group = links;
  index = startIndex;
  show();
  overlay.classList.add("is-open");
  // Lock background scroll while the overlay is up.
  document.documentElement.classList.add("lightbox-open");
  document.addEventListener("keydown", onKey);
}

function close() {
  if (!overlay) return;
  overlay.classList.remove("is-open");
  document.documentElement.classList.remove("lightbox-open");
  document.removeEventListener("keydown", onKey);
}

function step(delta) {
  if (!group.length) return;
  index = (index + delta + group.length) % group.length;
  show();
}

function show() {
  const a = group[index];
  imgEl.src = a.href;
  const thumb = a.querySelector("img");
  imgEl.alt = (thumb && thumb.alt) || "";
  // Hide nav arrows when there's only one image in the group.
  const showNav = group.length > 1;
  prevBtn.hidden = !showNav;
  nextBtn.hidden = !showNav;
}

function onKey(e) {
  if (e.key === "Escape")          close();
  else if (e.key === "ArrowLeft")  step(-1);
  else if (e.key === "ArrowRight") step(1);
}

// Single delegated click listener — catches links injected after page
// load too (e.g. if a future template hydrates a gallery client-side).
document.addEventListener("click", (e) => {
  const a = e.target.closest(SELECTOR);
  if (!a) return;
  e.preventDefault();
  const key = groupKey(a);
  const all = Array.from(document.querySelectorAll(SELECTOR))
                   .filter((el) => groupKey(el) === key);
  const start = Math.max(0, all.indexOf(a));
  open(all, start);
});
`;
}

export function lightboxMd() {
  return `# lightbox.js

Dependency-free modal-slideshow overlay for image galleries. Drop-in
replacement for the Weebly-era Fancybox setup the original theme shipped:
keeps the same \`rel="lightbox[group-key]"\` HTML hook so existing markup
works untouched.

## HTML contract

\`\`\`html
<a href="/assets/gfx/full-1.jpg" rel="lightbox[gallery]">
  <img src="/assets/gfx/thumb-1.jpg" alt="">
</a>
<a href="/assets/gfx/full-2.jpg" rel="lightbox[gallery]">
  <img src="/assets/gfx/thumb-2.jpg" alt="">
</a>
\`\`\`

All links sharing the same \`[group-key]\` form one slideshow. A bare
\`rel="lightbox"\` works too, but renders a single-image lightbox (the
prev/next arrows hide themselves when the group only has one entry).

## Interaction

| Surface          | Action                              |
| ---------------- | ----------------------------------- |
| Thumbnail click  | Open slideshow at that index        |
| \`← / →\`          | Previous / next                     |
| \`Esc\`            | Close                               |
| Backdrop click   | Close (image / button clicks don't) |
| Swipe (touch)    | Previous / next, via Hammer         |

Hammer is optional; the binding is guarded so the bundle still works
without it.

## Wiring it up

1. Import the JS from \`src/js/app.js\`:

   \`\`\`js
   import "./lightbox.js";
   \`\`\`

2. Import the LESS from \`src/less/main.less\`:

   \`\`\`less
   @import "_lightbox.less";
   \`\`\`

## Styling

CSS hooks:

- \`.lightbox\` — the overlay element (only visible when \`.is-open\`)
- \`.lightbox__stage\` — \`<figure>\` wrapping the active \`<img>\`
- \`.lightbox__close\`, \`.lightbox__prev\`, \`.lightbox__next\` — typographic
  buttons positioned absolutely over the stage
- \`html.lightbox-open\` — applied to \`<html>\` while the overlay is open,
  used to lock background scroll

The visual register mirrors the old Fancybox skin — near-white veil,
typographic chevrons (\`〈\` / \`〉\`) and \`×\` — so the migration is
visually invisible to anyone who used the original Weebly site.

## Why no library?

A typical lightbox library is 30–50 KB minified for features most
migrated sites don't use (deep linking, captions plugin, video support,
image rotation). This module is ~120 lines, no transitive deps, optional
Hammer for swipe.
`;
}

export function lightboxLess() {
  return `// _lightbox.less — overlay skin for the modal slideshow.
//
// @docs src/js/lightbox.md
//
// Replaces the old Fancybox skin. Visual register is intentionally close
// to the original — near-white veil, black typographic chevrons — so the
// migration is invisible to anyone who used the original Weebly site.
//
// Colors are baked in here (rather than referencing project LESS
// variables) so the partial drops in without a particular variable
// scheme. Swap to your tokens once the file is wired up.

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.95);

  &.is-open { display: flex; }
}

// Lock background scroll while the overlay is open. Applied by JS to
// \`<html>\` (not body) so iOS' rubber-band scroll is also pinned.
html.lightbox-open,
html.lightbox-open body {
  overflow: hidden;
}

.lightbox__stage {
  margin: 0;
  max-width: 90vw;
  max-height: 90vh;

  img {
    display: block;
    max-width: 90vw;
    max-height: 90vh;
    width: auto;
    height: auto;
    object-fit: contain;
  }
}

// Typographic buttons — chevrons and × set in the body face, matching
// the old Fancybox skin so the visual feel is preserved.
.lightbox__close,
.lightbox__prev,
.lightbox__next {
  position: absolute;
  border: 0;
  background: transparent;
  color: #000;
  font-family: inherit;
  font-size: 45px;
  font-weight: 400;
  line-height: 0.75em;
  cursor: pointer;
  padding: 10px;
  transition: opacity 200ms ease;

  &:hover { opacity: 0.6; }
  &[hidden] { display: none; }
}

.lightbox__close {
  top: 20px;
  right: 20px;
  &:before { content: '\\00D7'; } // ×
}

.lightbox__prev {
  left: 20px;
  top: 50%;
  transform: translateY(-50%);
  &:before { content: '\\3008'; position: relative; left: -10px; } // 〈
}

.lightbox__next {
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  &:before { content: '\\3009'; position: relative; right: -10px; } // 〉
}
`;
}

/**
 * The scaffolded reusable modules, keyed by destination path relative to
 * the project root. Driven by `init.mjs` after directory creation.
 *
 * Two ship by default: the `cookie-consent.md` pointer (the code lives in
 * the `@copperdesign/easy-cookie-consent` package, not here) and the
 * dependency-free lightbox. The user opts the lightbox *in* by importing
 * it from `src/js/app.js` and `src/less/main.less`; the files land unused
 * until then. The build glob does not pick up standalone files in src/js/,
 * and `main.less` does not auto-include `_*.less` siblings.
 *
 * `email-hider` is demoted and off by default — pass `{ emailHider: true }`
 * (from `init --with-email-hider`) to scaffold it. See the file header.
 */
export function reusableModuleFiles({ emailHider = false } = {}) {
  const files = {
    'src/js/cookie-consent.md':    cookieConsentMd(),
    'src/js/lightbox.js':          lightboxJs(),
    'src/js/lightbox.md':          lightboxMd(),
    'src/less/_lightbox.less':     lightboxLess(),
  };
  if (emailHider) {
    files['src/js/email-hider.js'] = emailHiderJs();
    files['src/js/email-hider.md'] = emailHiderMd();
  }
  return files;
}
