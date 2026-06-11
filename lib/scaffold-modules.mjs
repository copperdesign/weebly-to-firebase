/**
 * Scaffold-time content for the reusable JS modules every Weebly migration
 * tends to need: email obfuscation, third-party embed consent, and a
 * Fancybox-replacement lightbox.
 *
 * The modules land unused — they're not imported by `app.js` or `main.less`
 * out of the gate. The user wires each one in when they need it. Zero cost
 * when unused (the build glob doesn't drag in standalone files), high payoff
 * when needed (every Weebly migration we've done so far has wanted at least
 * one of these).
 *
 * Why they ship by default:
 *   - email-hider: Weebly relied on Cloudflare `__cf_email__` decoding which
 *     isn't present on Firebase Hosting; mailto: links from the original
 *     site break on first deploy unless something replaces it.
 *   - embed-consent: GDPR-shaped click-to-load gate. Required for any
 *     YouTube / SoundCloud / Google Maps embed under the German reading of
 *     § 25 TTDSG (and a generally good default elsewhere).
 *   - lightbox: Fancybox + jQuery is what the Weebly theme used for image
 *     galleries. The chrome deny-list strips the Fancybox sprites + skin;
 *     this is what fills the gap when the user starts hooking up galleries.
 *
 * Strings ship in English. Each module is small enough to localize in
 * place if the migrated site is German / French / etc.
 */

export function emailHiderJs() {
  return `// email-hider.js — Obfuscated mailto links, decoded at runtime.
//
// @docs src/js/email-hider.md
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

Tiny runtime decoder for \`mailto:\` links so the address never appears as a
joined string in the static HTML — keeps trivial scrapers from harvesting
it without forcing the visitor through a contact form.

## Why this exists

Weebly relied on Cloudflare's \`__cf_email__\` / \`data-cfemail\` obfuscation.
That decoding happens in a Cloudflare edge script that isn't present on
the new static Firebase deployment, so those links render as
\`[email protected]\` and don't work.

This module restores the same property — address split in source, joined
at the client — without the Cloudflare runtime. The split-attribute
trick (Q42-style) is the smallest thing that holds up against the bots
that actually matter (regex sweeps, simple headless scrapers) while
remaining a real clickable \`mailto:\` for humans and accessibility tools.

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

export function embedConsentJs() {
  return `// embed-consent.js — Click-to-load consent gate for third-party embeds.
//
// @docs src/js/embed-consent.md
//
// Replaces author-marked placeholder divs with the real iframe only after
// an explicit user click. The iframe URL never enters the document — and
// never hits Google / SoundCloud — until the user opts in. This is what
// the German "informierte Einwilligung" actually requires for YouTube
// embeds and the like; a single global "OK" banner does not.
//
// Per-provider consent can be remembered in localStorage via the
// "remember" checkbox. The choice persists across pages and reloads,
// scoped per provider — opting in to YouTube does not opt in to
// SoundCloud.
//
// HTML contract (authored in the source, not generated by JS):
//
//   <div class="embed-consent"
//        data-provider="youtube"
//        data-embed="https://www.youtube.com/embed/<ID>?rel=0"></div>
//
// The iframe is rebuilt on demand using provider-specific attributes
// (see PROVIDERS below), so the source stays clean and one-line per embed.

"use strict";

const STORAGE_PREFIX = "embedConsent:";

// Privacy-policy link target — adjust to wherever your privacy policy
// lives. Used in the per-embed hint copy.
const PRIVACY_HREF = "/privacy.html";

// Provider registry. Each entry encodes the public-facing copy plus the
// iframe attributes we restore on click. Keep iframe attrs here, not in
// the HTML source — the source should only carry the embed URL.
const PROVIDERS = {
  youtube: {
    label: "YouTube",
    operator: "Google LLC, USA",
    actionLabel: "Load video",
    iframeAttrs: {
      frameborder: "0",
      allow: "autoplay; encrypted-media",
      allowfullscreen: "",
    },
  },
  soundcloud: {
    label: "SoundCloud",
    operator: "SoundCloud Global Ltd. & Co. KG, Berlin",
    actionLabel: "Load audio",
    iframeAttrs: {
      frameborder: "no",
      scrolling: "no",
      allow: "autoplay",
    },
  },
  gmaps: {
    label: "Google Maps",
    operator: "Google LLC, USA",
    actionLabel: "Load map",
    iframeAttrs: {
      frameborder: "0",
      allowfullscreen: "",
      style: "border:0",
    },
  },
};

function hasConsent(providerKey) {
  // localStorage can throw in private-mode Safari and on some embedded
  // browsers — treat any failure as "no prior consent".
  try {
    return localStorage.getItem(STORAGE_PREFIX + providerKey) === "1";
  } catch {
    return false;
  }
}

function rememberConsent(providerKey) {
  try {
    localStorage.setItem(STORAGE_PREFIX + providerKey, "1");
  } catch {
    // Silently ignore — the user still gets the embed for this session.
  }
}

// Build the visible placeholder. Minimal DOM on purpose: one label, one
// hint, one button, one optional checkbox. Editorial register — no fake
// play button, no thumbnail — also avoids any premature ping to the
// third-party host (a YouTube thumbnail would itself be a Google request,
// defeating the point).
function renderPlaceholder(node, provider) {
  const body = document.createElement("div");
  body.className = "embed-consent__body";

  const label = document.createElement("p");
  label.className = "embed-consent__label";
  label.textContent = "External content from " + provider.label;

  const hint = document.createElement("p");
  hint.className = "embed-consent__hint";
  hint.append("Loading will send data to " + provider.operator + ". See the ");
  const link = document.createElement("a");
  link.href = PRIVACY_HREF;
  link.textContent = "privacy policy";
  hint.append(link, " for details.");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "embed-consent__button";
  button.textContent = provider.actionLabel;

  const remember = document.createElement("label");
  remember.className = "embed-consent__remember";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  remember.append(checkbox, " Always load " + provider.label + " in the future");

  body.append(label, hint, button, remember);
  node.replaceChildren(body);

  button.addEventListener("click", () => {
    if (checkbox.checked) rememberConsent(node.dataset.provider);
    swapInIframe(node, provider);
  });
}

// Replace the placeholder with the actual iframe. Build fresh — the
// iframe never existed in the DOM — and apply the provider's attribute set.
function swapInIframe(node, provider) {
  const iframe = document.createElement("iframe");
  iframe.src = node.dataset.embed;
  iframe.width = "100%";
  iframe.height = "100%";
  for (const [name, value] of Object.entries(provider.iframeAttrs)) {
    if (value === "") iframe.setAttribute(name, "");
    else iframe.setAttribute(name, value);
  }
  node.replaceChildren(iframe);
  node.classList.add("embed-consent--loaded");
}

function process(root = document) {
  const nodes = root.querySelectorAll(".embed-consent[data-provider][data-embed]");
  for (const node of nodes) {
    const provider = PROVIDERS[node.dataset.provider];
    if (!provider) continue; // unknown provider key — leave the node alone so it's visible in dev
    if (hasConsent(node.dataset.provider)) {
      swapInIframe(node, provider);
    } else {
      renderPlaceholder(node, provider);
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => process());
} else {
  process();
}
`;
}

export function embedConsentMd() {
  return `# embed-consent.js

Click-to-load consent gate for third-party embeds (YouTube, SoundCloud,
Google Maps). Required for GDPR-conformant embedding under the German
reading of § 25 TTDSG; a generally good default elsewhere too.

## Why this exists

A traditional cookie banner — single "OK" button on a global modal — does
not make YouTube/SoundCloud embeds GDPR-conformant. By the time the user
clicks "OK", the iframe has already loaded, Google has already set
cookies, and the IP address has already been transmitted. The third-party
connection must be **withheld until** explicit, informed consent — not
retroactively justified after it.

This module satisfies that requirement by keeping the iframe **out of the
DOM** entirely until the user clicks. The HTML source carries only a
labelled placeholder; the iframe is constructed in JS on click and
inserted in place. No race condition with the parser: the browser cannot
fetch an iframe that does not exist.

No global banner. The consent decision lives directly next to the embed
it gates — contextual rather than interruptive, which both reads better
and matches what "informed consent" actually means.

## HTML contract

Each embed is authored in the source as:

\`\`\`html
<div class="embed-consent"
     data-provider="youtube"
     data-embed="https://www.youtube.com/embed/<ID>?rel=0"></div>
\`\`\`

The \`data-provider\` value picks an entry from the \`PROVIDERS\` registry
inside \`embed-consent.js\`. The \`data-embed\` value is the full iframe
\`src\` URL. Provider-specific iframe attributes (\`allow\`,
\`allowfullscreen\`, etc.) live in the registry, not in the HTML.

## Wiring it up

1. Import the JS from \`src/js/app.js\`:

   \`\`\`js
   import "./embed-consent.js";
   \`\`\`

2. Import the LESS from \`src/less/main.less\`:

   \`\`\`less
   @import "_embed-consent.less";
   \`\`\`

3. Set \`PRIVACY_HREF\` near the top of \`embed-consent.js\` to your privacy
   policy URL.

## Adding a new provider

Add an entry to \`PROVIDERS\`:

\`\`\`js
vimeo: {
  label: "Vimeo",
  operator: "Vimeo Inc., USA",
  actionLabel: "Load video",
  iframeAttrs: { frameborder: "0", allow: "autoplay; fullscreen" },
}
\`\`\`

Then author embeds with \`data-provider="vimeo"\`. No JS changes per embed.

## Per-provider consent persistence

The placeholder includes an opt-in checkbox. When checked at load-time,
\`localStorage["embedConsent:<provider>"] = "1"\` is written. On subsequent
visits, embeds of that provider auto-load without showing the placeholder.

Consent is scoped per provider — opting in to YouTube does not opt in to
SoundCloud. There is no global "accept all" path on purpose.

Users who want to revoke consent can clear site data via their browser.

## Limitations

- No-JS fallback: without JavaScript, the placeholder renders as an empty
  \`<div>\`. Accepted — the alternative (lazy-loaded iframe) would remove
  the consent gate itself.
- The CSS sizes the box (\`height: 300px\` for YouTube, \`100px\` for
  SoundCloud, \`470px\` for Google Maps) to common iframe dimensions.
  Tweak in \`_embed-consent.less\` if the embeds you're hosting differ.
`;
}

export function embedConsentLess() {
  return `// _embed-consent.less — Click-to-load consent placeholder.
//
// @docs src/js/embed-consent.md (the JS module that builds the inner DOM)
//
// The placeholder takes the slot the iframe would have occupied.
// Dimensions match common iframe sizes so the page doesn't reflow on
// click. Visual register: flat, type-led — the box reads as "intentional
// empty space" rather than "broken embed".
//
// Colors and fonts are baked in here (rather than referencing project
// LESS variables) so the partial drops in without a particular variable
// scheme. Swap to your tokens once the file is wired up.

.embed-consent {
  display: block;
  width: 100%;
  background: #e1e4e6;
  color: #000;
  font-family: inherit;
  // Match a typical iframe height so the page doesn't jump when the
  // user clicks "Load …" and the iframe takes over.
  height: 300px; // YouTube default — overridden below per provider
}

.embed-consent--soundcloud { height: 100px; }
.embed-consent--gmaps      { height: 470px; }

.embed-consent__body {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1.5rem 2rem;
  box-sizing: border-box;
}

.embed-consent__label {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.embed-consent__hint {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.45;
  max-width: 42em;
  // Hint copy stays secondary — the button is the action, the text is
  // there to make the consent informed, not to fight for attention.
  opacity: 0.75;

  a {
    color: inherit;
    text-decoration: underline;
  }
}

.embed-consent__button {
  appearance: none;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.9rem;
  padding: 0.55rem 1.25rem;
  cursor: pointer;
  transition: background-color 150ms ease-out, color 150ms ease-out;

  &:hover,
  &:focus-visible {
    background: #000;
    color: #e1e4e6;
  }
}

.embed-consent__remember {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  opacity: 0.7;
  cursor: pointer;

  input { margin: 0; }
}

// SoundCloud's 100px slot is too short for the full layout — collapse to
// a single-row variant so the load button stays inline with the label.
.embed-consent--soundcloud .embed-consent__body {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
}
.embed-consent--soundcloud .embed-consent__hint {
  flex-basis: 100%;
  order: 3;
  font-size: 0.8rem;
}

// Once loaded, the wrapper just holds the iframe; strip its own framing
// so the iframe fills the slot edge-to-edge.
.embed-consent--loaded {
  background: transparent;
  padding: 0;
  height: 300px;

  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
}
.embed-consent--loaded.embed-consent--soundcloud { height: 100px; }
.embed-consent--loaded.embed-consent--gmaps      { height: 470px; }
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
 * All scaffolded reusable modules, keyed by destination path relative to
 * the project root. Driven by `init.mjs` after directory creation.
 *
 * The user opts each module *in* by importing it from `src/js/app.js`
 * (and `src/less/main.less` for the LESS partials); the files land
 * unused until then. The build glob does not pick up standalone files in
 * src/js/, and `main.less` does not auto-include `_*.less` siblings.
 */
export function reusableModuleFiles() {
  return {
    'src/js/email-hider.js':       emailHiderJs(),
    'src/js/email-hider.md':       emailHiderMd(),
    'src/js/embed-consent.js':     embedConsentJs(),
    'src/js/embed-consent.md':     embedConsentMd(),
    'src/less/_embed-consent.less': embedConsentLess(),
    'src/js/lightbox.js':          lightboxJs(),
    'src/js/lightbox.md':          lightboxMd(),
    'src/less/_lightbox.less':     lightboxLess(),
  };
}
