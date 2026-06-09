/**
 * Weebly form detection + Firebase-native form-handler scaffolding.
 *
 * Weebly's editor produces forms whose `action=` points at a Weebly handler
 * URL (or no action at all — JS hijacks submit). Once we strip the runtime
 * scripts and host on Firebase, those forms are dead. This module is the
 * "make the form work again" pass:
 *
 *   1. detectForms(html)            — true when a Weebly form is present
 *   2. rewriteFormAction(html)      — point <form action> at our endpoint
 *                                     and inject a honeypot input
 *   3. functions{IndexJs,PackageJson,Gitignore,Readme}() — templates for
 *                                     a `functions/submitForm` HTTP function
 *                                     that writes submissions to Firestore
 *
 * The endpoint we rewrite to (/api/submit-form) is wired in firebase.json's
 * `rewrites` block to the `submitForm` Cloud Function — port.mjs does the
 * firebase.json mutation. Hosting same-origin means no CORS dance.
 *
 * Why this design over JotForm / Formspree:
 *   - Owner-controlled data lives in the same Firebase project as the site
 *   - No third-party account, no recurring fee beyond Blaze usage (a contact
 *     form sits comfortably in the free tier)
 *   - The hand-edited handler is the seam for whatever else the user wants
 *     (custom validation, multiple form types, email notifications)
 *
 * The cost: Functions require the Blaze (pay-as-you-go) plan. functions/README
 * (also generated here) flags that as the one manual step.
 */

/* ──────────────────────────────────────────────────────────────────────────
 * Detection
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Weebly form markers that survive after stripping their runtime scripts.
 * Class names are the most reliable signal: the editor consistently tags the
 * outer wrapper with `wsite-form-container` and the inner form fields with
 * `wsite-form-*`. We also match a bare `<form>` whose nested markup carries
 * the wsite-form-field class, since some themes drop the container class.
 */
const FORM_MARKERS_RE = /(?:class\s*=\s*["'][^"']*\bwsite-form-(?:container|field|input|label)\b|<form\b[^>]*\bid\s*=\s*["']form-\d+["'])/i;

/** True when the HTML contains a Weebly-shaped form. */
export function detectForms(html) {
  if (!html) return false;
  return FORM_MARKERS_RE.test(html);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Rewrite
 * ────────────────────────────────────────────────────────────────────────── */

/** Endpoint path the rewritten forms POST to. Wired in firebase.json. */
export const FORM_ENDPOINT = '/api/submit-form';

/**
 * hCaptcha's official test sitekey/secret pair. ALWAYS passes verification —
 * lets the scaffolded form work out of the box without a real hCaptcha
 * account, but provides ZERO spam protection. The scaffold marks both with
 * TODOs so the user replaces them before going live:
 *   - sitekey lives in the form HTML (public; safe to commit)
 *   - secret is read by the Function from env (set via firebase functions:
 *     secrets:set HCAPTCHA_SECRET)
 *
 * Reference: https://docs.hcaptcha.com/#integration-testing-test-keys
 */
export const HCAPTCHA_TEST_SITEKEY = '10000000-ffff-ffff-ffff-000000000001';
export const HCAPTCHA_TEST_SECRET = '0x0000000000000000000000000000000000000000';

/**
 * Rewrite every `<form>` in `html`:
 *   - action="…"   → action="/api/submit-form"  (added if missing)
 *   - method=…     → method="POST"              (added if missing)
 *   - inject the hCaptcha widget (`<div class="h-captcha" data-sitekey=…>`)
 *     just before the submit button, plus the hCaptcha loader script — the
 *     widget POSTs back an `h-captcha-response` field the Function checks
 *     against hCaptcha's siteverify API
 *   - inject a `<input type="text" name="_gotcha">` honeypot. Bots auto-fill
 *     every visible input; legit users can't see it (off-screen + tabindex=-1
 *     + autocomplete=off). The Function short-circuits on any non-empty value
 *
 * The honeypot catches naive bots without a network call; hCaptcha catches
 * everything that survives the honeypot. Two layers because each is cheap
 * and they fail in different ways.
 *
 * Returns `{ html, count }` so the caller can log "rewrote N forms" without
 * re-scanning the output.
 */
export function rewriteFormAction(html) {
  if (!html) return { html, count: 0 };
  let count = 0;
  const out = html.replace(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi, (_, attrs, body) => {
    count++;
    let nextAttrs = attrs;
    // action — replace if present, append otherwise.
    if (/\baction\s*=\s*["'][^"']*["']/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(
        /\baction\s*=\s*["'][^"']*["']/i,
        `action="${FORM_ENDPOINT}"`,
      );
    } else {
      nextAttrs = `${nextAttrs} action="${FORM_ENDPOINT}"`;
    }
    // method — force POST. Weebly forms are GET in the static export
    // sometimes; the Function only accepts POST.
    if (/\bmethod\s*=\s*["'][^"']*["']/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(/\bmethod\s*=\s*["'][^"']*["']/i, 'method="POST"');
    } else {
      nextAttrs = `${nextAttrs} method="POST"`;
    }
    // hCaptcha widget — inject right before the submit button so it appears
    // above "Send"/"Submit" rather than dangling after it. Falls back to
    // appending before </form> if no submit element is found.
    let nextBody = body;
    if (!/\bh-captcha\b/i.test(nextBody)) {
      const submitRe = /<(?:input|button)\b[^>]*\btype\s*=\s*["']submit["'][^>]*>/i;
      const m = nextBody.match(submitRe);
      if (m && typeof m.index === 'number') {
        nextBody = nextBody.slice(0, m.index)
          + CAPTCHA_WIDGET + '\n      '
          + nextBody.slice(m.index);
      } else {
        nextBody = `${nextBody.replace(/\s*$/, '')}\n      ${CAPTCHA_WIDGET}\n    `;
      }
    }
    // hCaptcha loader script — idempotent: browsers dedupe by src, but we
    // still skip when the marker is present so the output stays tidy on
    // re-runs. Lives inside the form so the script only loads on pages that
    // actually have one.
    if (!/js\.hcaptcha\.com/i.test(nextBody)) {
      nextBody = `${nextBody.replace(/\s*$/, '')}\n      ${CAPTCHA_SCRIPT}\n    `;
    }
    // Honeypot — only inject if not already present (idempotent re-runs).
    if (!/name\s*=\s*["']_gotcha["']/i.test(nextBody)) {
      nextBody = `${nextBody.replace(/\s*$/, '')}\n      ${HONEYPOT_FIELD}\n    `;
    }
    return `<form${nextAttrs}>${nextBody}</form>`;
  });
  return { html: out, count };
}

/**
 * hCaptcha widget. The sitekey is the official test key — always passes,
 * provides no real protection. Replace with your sitekey from
 * https://dashboard.hcaptcha.com/sites before going live, AND set the
 * matching secret on the Function (see functions/README.md).
 */
const CAPTCHA_WIDGET = `<div class="h-captcha" data-sitekey="${HCAPTCHA_TEST_SITEKEY}"><!-- TODO: replace with real hCaptcha sitekey from https://dashboard.hcaptcha.com/sites --></div>`;

/** hCaptcha loader — async/defer so it doesn't block render. */
const CAPTCHA_SCRIPT = `<script src="https://js.hcaptcha.com/1/api.js" async defer></script>`;

/**
 * Honeypot input — hidden from real users via off-screen positioning + a11y
 * attrs, fillable by naive bots that just `value=…` every input on the page.
 * Inline style keeps the rule self-contained so it survives even if the
 * project's CSS cascade misses it.
 */
const HONEYPOT_FIELD = `<input type="text" name="_gotcha" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">`;

/* ──────────────────────────────────────────────────────────────────────────
 * Firebase.json mutation
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Merge the forms-handler config into an existing firebase.json object.
 * Idempotent: skips work when the rewrite + functions block are already
 * present. Returns true when the object was modified (caller writes back).
 *
 * Expected shape going in:
 *   { hosting: { …existing hosting config… } }
 * Going out:
 *   { hosting: { …, rewrites: [{ source, function }] }, functions: { source } }
 */
export function applyFormsConfigToFirebaseJson(fbJson) {
  let changed = false;
  fbJson.hosting = fbJson.hosting || {};
  const rewrites = fbJson.hosting.rewrites || [];
  const hasRewrite = rewrites.some(r =>
    r && r.source === FORM_ENDPOINT && r.function === 'submitForm',
  );
  if (!hasRewrite) {
    rewrites.push({ source: FORM_ENDPOINT, function: 'submitForm' });
    fbJson.hosting.rewrites = rewrites;
    changed = true;
  }
  if (!fbJson.functions) {
    // Mirror firebase init's shape — array-wrapped, source-only is enough
    // for v2 functions deploys. Predeploy lints / installs can be added by
    // the user if they want them; we don't impose a workflow.
    fbJson.functions = [{ source: 'functions', codebase: 'default' }];
    changed = true;
  }
  return changed;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Functions scaffold templates
 * Each returns a complete file body. Written verbatim by port.mjs when forms
 * are first detected.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * functions/index.js — the actual handler. ES module to match the rest of
 * this project's style. firebase-functions v2 + firebase-admin.
 *
 * Behavior:
 *   - Only POST. Anything else → 405.
 *   - Honeypot: if `_gotcha` is non-empty, fake a 200 success (so bots don't
 *     learn they were filtered) and skip the write.
 *   - Strip control fields (_gotcha, _redirect) before saving.
 *   - Write to Firestore `formSubmissions/` with metadata (IP, UA, timestamp).
 *   - Redirect back to the page that submitted (?ok=1) so the visitor sees
 *     their own site, not a JSON blob. Override per form via hidden
 *     `<input name="_redirect" value="/thanks">` if you want a dedicated
 *     thank-you page.
 *
 * Email notifications: see the TODO inside `notify()`. Wire your provider
 * (Resend, SendGrid, Mailgun) there. Left unwired so we don't impose a dep.
 */
export function functionsIndexJs() {
  return `// functions/index.js — Firebase HTTP function for Weebly-replacement
// contact forms.
//
// Generated by \`w2f port\` on first form detection. Hand-edit freely; w2f
// won't overwrite this once it exists.
//
// Endpoint: POST /api/submit-form  (see firebase.json hosting.rewrites)
// Storage:  Firestore collection \`formSubmissions/\`
// Spam:     two layers, both on by default
//             1. honeypot field \`_gotcha\` (injected by w2f) — catches naive
//                bots without a network call
//             2. hCaptcha (\`h-captcha-response\`) — verified server-side
//                against hCaptcha's siteverify API
//           For very high traffic, layer App Check + rate limiting on top.

import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

/**
 * hCaptcha secret. Set via \`firebase functions:secrets:set HCAPTCHA_SECRET\`
 * with the secret from https://dashboard.hcaptcha.com/sites (matches the
 * sitekey embedded in the form HTML).
 *
 * If the secret is unset OR set to the official test value, the Function
 * uses hCaptcha's test secret — every captcha passes, providing zero real
 * protection. This lets the scaffold work out of the box; replace before
 * going live.
 */
const HCAPTCHA_SECRET = defineSecret('HCAPTCHA_SECRET');
const HCAPTCHA_TEST_SECRET = '0x0000000000000000000000000000000000000000';

/**
 * Region: defaults to us-central1 (cheapest, Firebase default). If most of
 * your traffic is European, set { region: 'europe-west3' } (Frankfurt) or
 * 'europe-west1' (Belgium) — closer = lower latency on the form POST.
 */
export const submitForm = onRequest(
  { cors: true, maxInstances: 10, secrets: [HCAPTCHA_SECRET] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const body = req.body || {};

    // Layer 1: honeypot. Bots fill every input. Real users never touch this.
    // Pretend success so spammers don't learn the filter exists.
    if (typeof body._gotcha === 'string' && body._gotcha.trim()) {
      logger.info('submitForm honeypot tripped', { ip: req.ip });
      res.status(200).send('ok');
      return;
    }

    // Layer 2: hCaptcha siteverify. The browser widget adds an
    // \`h-captcha-response\` token to the form body; we POST that + our
    // secret to hCaptcha and trust the verdict.
    const token = body['h-captcha-response'];
    const secret = HCAPTCHA_SECRET.value() || HCAPTCHA_TEST_SECRET;
    const captchaOk = await verifyHCaptcha(token, secret, req.ip);
    if (!captchaOk) {
      logger.info('submitForm captcha failed', { ip: req.ip });
      res.status(400).send('Captcha verification failed.');
      return;
    }

    // Pull out control + captcha fields so they don't pollute the record.
    const { _gotcha, _redirect, 'h-captcha-response': _hc, ...fields } = body;

    try {
      const doc = await db.collection('formSubmissions').add({
        fields,
        userAgent: req.get('user-agent') || null,
        referer: req.get('referer') || null,
        ip: req.ip || null,
        createdAt: FieldValue.serverTimestamp(),
      });
      logger.info('submitForm saved', { id: doc.id });

      await notify(fields, doc.id).catch(err => {
        // Don't fail the request if email fails — the record is already
        // persisted, and the visitor doesn't care about our SMTP.
        logger.warn('submitForm notify failed', { error: err?.message });
      });

      // Redirect back to where the form was submitted. ?ok=1 lets the page
      // show a "thanks" state without needing a separate route.
      const destination = typeof _redirect === 'string' && _redirect
        ? _redirect
        : (req.get('referer') || '/');
      const url = destination + (destination.includes('?') ? '&' : '?') + 'ok=1';
      res.redirect(303, url);
    } catch (err) {
      logger.error('submitForm failed', { error: err?.message });
      res.status(500).send('Internal error');
    }
  },
);

/**
 * POST the token to hCaptcha's siteverify endpoint. Returns true when the
 * captcha passed, false on any failure (network error, bad token, missing
 * input). Conservative on failure — a flaky hCaptcha shouldn't lock real
 * users out, but we never return true without an explicit success from them.
 *
 * Docs: https://docs.hcaptcha.com/#verify-the-user-response-server-side
 */
async function verifyHCaptcha(token, secret, remoteIp) {
  if (!token || typeof token !== 'string') return false;
  const params = new URLSearchParams({ secret, response: token });
  if (remoteIp) params.set('remoteip', remoteIp);
  try {
    const r = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!r.ok) {
      logger.warn('hCaptcha siteverify HTTP error', { status: r.status });
      return false;
    }
    const data = await r.json();
    if (!data.success && Array.isArray(data['error-codes'])) {
      logger.info('hCaptcha rejected', { errors: data['error-codes'] });
    }
    return !!data.success;
  } catch (err) {
    logger.warn('hCaptcha siteverify network error', { error: err?.message });
    return false;
  }
}

/**
 * Email notification stub. Plumb your provider here.
 *
 * Resend (recommended for low volume):
 *   import { Resend } from 'resend';
 *   const resend = new Resend(process.env.RESEND_KEY);
 *   await resend.emails.send({
 *     from: 'forms@yourdomain.com',
 *     to: 'you@yourdomain.com',
 *     subject: 'New form submission',
 *     text: JSON.stringify(fields, null, 2),
 *   });
 *
 * Secrets: \`firebase functions:secrets:set RESEND_KEY\`, then add
 *   secrets: ['RESEND_KEY'] to the onRequest() options above.
 */
async function notify(fields, id) {
  // TODO: wire email provider. Until then, submissions land in Firestore
  // only — view at console.firebase.google.com → Firestore → formSubmissions.
  return { id, fields };
}
`;
}

/**
 * functions/package.json. ES module (matches index.js). Node 20 runtime —
 * Firebase Functions current LTS. Versions pinned with caret to track minor
 * updates; bump as needed.
 */
export function functionsPackageJson() {
  return JSON.stringify({
    name: 'functions',
    description: 'Cloud Functions for Firebase (form handler)',
    type: 'module',
    engines: { node: '20' },
    main: 'index.js',
    scripts: {
      // Convenience — run from functions/ or `npm --prefix functions run …`.
      serve: 'firebase emulators:start --only functions',
      logs: 'firebase functions:log',
    },
    dependencies: {
      'firebase-admin': '^12.0.0',
      'firebase-functions': '^6.0.0',
    },
    private: true,
  }, null, 2) + '\n';
}

export function functionsGitignore() {
  return `node_modules/
*.log
.runtimeconfig.json
`;
}

/**
 * functions/README.md — explains what the Function does, the Blaze
 * requirement, how to deploy, where to read submissions, and how to add
 * email. This is the "long-form WHY" companion to index.js's inline notes.
 */
export function functionsReadme() {
  return `# functions/

Cloud Function that backs the site's contact / feedback forms. Generated by
\`w2f port\` the first time it detected a Weebly form in the source markup.

## What it does

A single HTTP function, \`submitForm\`, exported from \`index.js\`:

- Accepts \`POST /api/submit-form\` (wired in \`firebase.json\` rewrites)
- Two-layer spam check (both on by default):
  - **Honeypot** \`_gotcha\` field — \`w2f\` injects it into every form
  - **hCaptcha** server-side verification against [siteverify][siteverify]
- Writes the form fields to Firestore: collection \`formSubmissions/\`
- Redirects the visitor back to the submitting page with \`?ok=1\` appended

[siteverify]: https://docs.hcaptcha.com/#verify-the-user-response-server-side

View submissions in the Firebase console → Firestore → \`formSubmissions\`.

## One-time setup

### 1. Enable Blaze plan

Cloud Functions require the **Blaze (pay-as-you-go) plan**. A contact form
sits comfortably inside the free tier; Blaze is a billing-account step, not
a recurring charge. Enable it once at
[console.firebase.google.com](https://console.firebase.google.com) → your
project → Upgrade.

### 2. Replace the hCaptcha test keys

The scaffold ships with hCaptcha's [test sitekey/secret pair][test-keys] —
every captcha passes, so the form works out of the box, but **there is zero
real spam protection until you swap in real keys**.

[test-keys]: https://docs.hcaptcha.com/#integration-testing-test-keys

1. Sign up at [hCaptcha](https://www.hcaptcha.com/) (free tier covers any
   realistic contact-form volume) and create a site.
2. Replace the \`data-sitekey\` value in your form HTML:
   \`\`\`html
   <div class="h-captcha" data-sitekey="YOUR-REAL-SITEKEY"></div>
   \`\`\`
   The sitekey is public; safe to commit.
3. Store the matching secret on Firebase:
   \`\`\`bash
   firebase functions:secrets:set HCAPTCHA_SECRET
   \`\`\`
   Paste the secret when prompted. The Function reads it at runtime; never
   commit it.

Until you do step 3, the Function falls back to hCaptcha's test secret —
useful for local dev, **insecure in production**.

### 3. Install function deps

\`\`\`bash
cd functions && npm install
\`\`\`

## Deploy

\`\`\`bash
npm run deploy:functions     # from the project root, just the function
firebase deploy              # everything (hosting + functions)
\`\`\`

## Add email notifications

\`index.js\` has a \`notify()\` stub. Plumb in your provider (Resend, SendGrid,
Mailgun) and store the API key as a Firebase secret:

\`\`\`bash
firebase functions:secrets:set RESEND_KEY
\`\`\`

Then add \`'RESEND_KEY'\` to the \`secrets:\` array on the \`onRequest()\` options
(next to \`HCAPTCHA_SECRET\`).

## Local development

\`\`\`bash
firebase emulators:start
\`\`\`

The hosting emulator routes \`/api/submit-form\` to the local function the
same way production does. The hCaptcha test keys mean local submits succeed
without any captcha interaction.

## Hardening for higher traffic

Honeypot + hCaptcha handles a typical contact-form volume. If you need more:

- **Firebase App Check** — cryptographically verifies the request originated
  from your site, not a script someone wrote against your endpoint
- **Rate limiting** — track recent IPs in Firestore and reject bursts
- **Region pinning** — set \`region: 'europe-west3'\` in \`onRequest()\` options
  for lower latency on European traffic
`;
}
