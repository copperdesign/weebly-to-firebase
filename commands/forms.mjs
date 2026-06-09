/**
 * `weebly-to-firebase forms` — go-live setup for the contact-form handler
 * scaffolded by `w2f port` on first form detection.
 *
 * Three independent steps, each opt-out via a flag — order matters because
 * earlier steps fail cheaply (filesystem only) and later ones touch the
 * network / interactive prompts:
 *
 *   1. npm install in functions/    (skip via --skip-install)
 *   2. Replace the hCaptcha test sitekey across src/html/  (only when
 *      --sitekey <key> is provided; without the flag, this step no-ops)
 *   3. firebase functions:secrets:set HCAPTCHA_SECRET     (skip via
 *      --skip-secret) — interactive: stdio is inherited so the user pastes
 *      the secret into the firebase CLI's own prompt. Auto-skipped when
 *      stdin isn't a TTY (CI, piped invocations, agent sessions) since the
 *      firebase prompt would block forever with no one to type into it.
 *
 * Separation rationale: `port` is the "re-run anytime, idempotent, offline"
 * command — running `npm install` (~30 MB of Functions deps) and a Firebase
 * CLI roundtrip on every port would slow iteration and fail noisily in
 * offline or Blaze-not-enabled states. `forms` is the explicit go-live step
 * the user runs once per project after grabbing their real hCaptcha keys.
 *
 * Preconditions:
 *   - functions/ exists (i.e. `port` has detected at least one form)
 *   - Step 3 also needs the firebase CLI on PATH + a logged-in user
 *
 * Each step prints a clear result line; failures are surfaced but do not
 * abort the remaining steps — a Blaze-pending project can still benefit
 * from npm install + sitekey rewrite landing locally.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveTarget } from '../lib/target.mjs';
import { HCAPTCHA_TEST_SITEKEY } from '../lib/forms.mjs';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Stream stdio through — the firebase CLI prompts; the user must see + type. */
function runStream(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', err => {
      console.log(`  !  spawn failed: ${err.message}`);
      resolve(-1);
    });
  });
}

/** Quietly check for a binary on PATH. Returns true when present. */
function hasBinary(cmd) {
  return new Promise(resolve => {
    const child = spawn(cmd, ['--version'], { stdio: 'ignore' });
    child.on('exit', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Step 1: install function dependencies
 * ────────────────────────────────────────────────────────────────────────── */

async function installFunctionsDeps(fnDir) {
  console.log('\n→ functions/ npm install');
  if (!(await exists(path.join(fnDir, 'package.json')))) {
    console.log('  !  functions/package.json missing — skipping');
    return false;
  }
  // Detect prior install — node_modules exists AND has Functions runtime
  // present. This skips the network roundtrip on repeated `w2f forms` calls
  // without forcing the user to remember a --skip flag.
  const installed = await exists(path.join(fnDir, 'node_modules/firebase-functions'));
  if (installed) {
    console.log('  ok   functions/node_modules already populated');
    return true;
  }
  if (!(await hasBinary('npm'))) {
    console.log('  !    npm not found on PATH — install Node.js first');
    return false;
  }
  const code = await runStream('npm', ['install'], { cwd: fnDir });
  if (code !== 0) {
    console.log(`  !    npm install failed (exit ${code})`);
    return false;
  }
  console.log('  +    functions/ deps installed');
  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Step 2: rewrite the hCaptcha sitekey across src/html/
 *
 * `port` injects the official hCaptcha test sitekey alongside a TODO
 * comment. This step swaps in the user's real sitekey and drops the TODO,
 * across every page partial that carries it. Idempotent — running twice
 * with the same sitekey is a no-op.
 * ────────────────────────────────────────────────────────────────────────── */

async function rewriteSitekey(root, newSitekey) {
  console.log('\n→ hCaptcha sitekey rewrite');
  if (!/^[0-9a-fA-F-]{30,}$/.test(newSitekey)) {
    console.log(`  !    --sitekey "${newSitekey}" doesn't look like an hCaptcha sitekey (UUID-shaped). Skipping.`);
    return false;
  }
  const htmlDir = path.join(root, 'src/html');
  if (!(await exists(htmlDir))) {
    console.log('  !    src/html/ missing — skipping');
    return false;
  }
  const files = (await fs.readdir(htmlDir)).filter(f => f.endsWith('.html'));
  let touched = 0;
  for (const name of files) {
    const p = path.join(htmlDir, name);
    const before = await fs.readFile(p, 'utf8');
    // Swap the sitekey value AND drop the now-resolved TODO comment that
    // sits inside the captcha div. Match either ordering of attributes on
    // the wrapper to be safe against hand-edits.
    let after = before
      .replace(
        new RegExp(`data-sitekey=["']${HCAPTCHA_TEST_SITEKEY}["']`, 'g'),
        `data-sitekey="${newSitekey}"`,
      )
      .replace(
        /<!--\s*TODO:\s*replace with real hCaptcha sitekey[^-]*-->/gi,
        '',
      );
    if (after !== before) {
      await fs.writeFile(p, after);
      touched++;
      console.log(`  +    src/html/${name}`);
    }
  }
  if (!touched) {
    console.log('  ok   no test sitekey found (already replaced, or no forms in src/html/)');
    return true;
  }
  console.log(`  +    rewrote sitekey in ${touched} file${touched === 1 ? '' : 's'}`);
  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Step 3: set the hCaptcha secret on Firebase
 *
 * Runs `firebase functions:secrets:set HCAPTCHA_SECRET` with stdio inherited
 * so the firebase CLI's own prompt + paste flow drives the interaction. We
 * don't accept the secret on argv — putting it in shell history would leak it.
 * ────────────────────────────────────────────────────────────────────────── */

async function setHcaptchaSecret(root) {
  console.log('\n→ firebase functions:secrets:set HCAPTCHA_SECRET');
  if (!(await hasBinary('firebase'))) {
    console.log('  !    firebase CLI not found. Install: npm i -g firebase-tools');
    return false;
  }
  if (!(await exists(path.join(root, '.firebaserc')))) {
    console.log('  !    .firebaserc missing — run `w2f init` first');
    return false;
  }
  console.log('  Paste the secret from https://dashboard.hcaptcha.com/sites when prompted.');
  console.log('  (Firebase will prompt to enable secret manager / billing if not already on Blaze.)\n');
  const code = await runStream('firebase', [
    'functions:secrets:set', 'HCAPTCHA_SECRET',
  ], { cwd: root });
  if (code !== 0) {
    console.log(`  !    firebase functions:secrets:set failed (exit ${code})`);
    console.log('       Common causes: not logged in (firebase login), Blaze plan not enabled,');
    console.log('       or no project linked (firebase use <project-id>).');
    return false;
  }
  console.log('  +    HCAPTCHA_SECRET stored. Redeploy functions for it to take effect:');
  console.log('       npm run deploy:functions');
  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Runner
 * ────────────────────────────────────────────────────────────────────────── */

export async function run(flags = {}, positionals = []) {
  const root = resolveTarget(flags.target);
  const fnDir = path.join(root, 'functions');

  if (!(await exists(fnDir))) {
    throw new Error(
      "No functions/ directory found. Run `w2f port` first — the forms handler\n" +
      "scaffolds automatically the first time a Weebly form is detected in the\n" +
      "crawled source. If your site has no contact form, this command is a no-op."
    );
  }

  console.log(`\nFinalizing forms handler in ${root}`);

  const results = {
    install: null,
    sitekey: null,
    secret: null,
  };

  // — Step 1: install function deps —
  if (flags.skipInstall) {
    console.log('\n→ functions/ npm install (skipped via --skip-install)');
  } else {
    results.install = await installFunctionsDeps(fnDir);
  }

  // — Step 2: sitekey rewrite (opt-in via --sitekey) —
  // Positional argument also accepted: `w2f forms <sitekey>` reads cleaner
  // than `w2f forms --sitekey <key>` for the most common case.
  const sitekey = flags.sitekey || positionals[0];
  if (sitekey) {
    results.sitekey = await rewriteSitekey(root, sitekey);
  } else {
    console.log('\n→ hCaptcha sitekey rewrite (skipped — pass --sitekey <key> to replace the test key)');
  }

  // — Step 3: firebase secrets:set —
  // Auto-skip when stdin isn't a TTY: the firebase CLI prompts interactively
  // and inherits stdio, so a non-TTY caller (CI, agent session, `w2f forms |
  // tee log`) would block forever waiting for input no human can deliver.
  // The user gets a clear instruction to run the step themselves later.
  const nonInteractive = !process.stdin.isTTY;
  if (flags.skipSecret) {
    console.log('\n→ firebase functions:secrets:set HCAPTCHA_SECRET (skipped via --skip-secret)');
  } else if (nonInteractive) {
    console.log('\n→ firebase functions:secrets:set HCAPTCHA_SECRET (skipped — non-interactive shell)');
    console.log('  Run this yourself from a real terminal once you have the secret:');
    console.log('    firebase functions:secrets:set HCAPTCHA_SECRET');
    console.log('  (Paste it from https://dashboard.hcaptcha.com/sites at the prompt.)');
  } else {
    results.secret = await setHcaptchaSecret(root);
  }

  // — Summary —
  console.log('\nForms setup summary:');
  console.log(`  npm install:    ${formatResult(results.install, flags.skipInstall)}`);
  console.log(`  sitekey rewrite: ${formatResult(results.sitekey, !sitekey, 'no --sitekey')}`);
  const secretSkipReason = flags.skipSecret
    ? 'skipped'
    : (nonInteractive ? 'non-interactive shell' : null);
  console.log(`  secret set:     ${formatResult(results.secret, secretSkipReason !== null, secretSkipReason || 'skipped')}`);

  if (results.secret === true) {
    console.log('\nNext: `npm run deploy:functions` to push the handler live.');
  } else if (nonInteractive && !flags.skipSecret) {
    console.log('\nNext: run `firebase functions:secrets:set HCAPTCHA_SECRET` in a real');
    console.log('      terminal, then `npm run deploy:functions`.');
  } else if (!flags.skipSecret) {
    console.log('\nNext: resolve the secret-set failure above, then `npm run deploy:functions`.');
  }
}

function formatResult(value, skipped, skipReason = 'skipped') {
  if (skipped) return `— ${skipReason}`;
  if (value === true) return 'ok';
  if (value === false) return 'failed (see above)';
  return '—';
}
