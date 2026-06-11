/**
 * `weebly-to-firebase init` — scaffold a Firebase Hosting project from an
 * existing reference/WeeblyExport/ (falls back to src/WeeblyExport/ for
 * projects scaffolded under the older layout).
 *
 * Interactive by default; flag-driven when --yes or per-question flags are
 * provided. Idempotent: prior answers cached in <target>/.weebly-migrate.json
 * and offered as defaults; existing files are never overwritten.
 *
 * Steps:
 *   1. Prompt (or read flags) for project name, slug, description, firebase
 *      project, hosting site, live domain, github repo.
 *   2. Write package.json, firebase.json, .firebaserc, .gitignore,
 *      .gitattributes, README.md (skip if exists).
 *   3. Create src/{html,less,js,gfx}, public/assets/{css,js,gfx}, reference/.
 *   4. Optionally: run `convert`, run `crawl`, `git init` + initial commit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ask, askValid, askYesNo } from '../lib/prompt.mjs';
import { resolveTarget } from '../lib/target.mjs';
import * as t from '../lib/templates.mjs';
import { reusableModuleFiles } from '../lib/scaffold-modules.mjs';
import { run as runConvert } from './convert.mjs';
import { run as runCrawl } from './crawl.mjs';
import { run as runPort } from './port.mjs';
import { setupFirebaseProject } from '../lib/firebase.mjs';
import { normalizeDomain } from '../lib/domain.mjs';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJson(p, fallback = {}) {
  if (!(await exists(p))) return fallback;
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return fallback; }
}

/** kebab-case a free-form name. "My Site" → "my-site". */
function slugify(s) {
  return s.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics (ü → u)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Write file only if it doesn't already exist. Returns true if written. */
async function writeIfMissing(root, relPath, contents) {
  const filePath = path.join(root, relPath);
  if (await exists(filePath)) {
    console.log(`  skip ${relPath} (exists)`);
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
  console.log(`  +    ${relPath}`);
  return true;
}

/**
 * True when `reference/WeeblyExport/` (or the legacy `src/WeeblyExport/`)
 * holds anything beyond the empty drop-target the scaffold creates. Used to
 * suppress the convert prompt when there's nothing to convert — keeps the
 * wizard's "wget is primary" framing honest.
 */
async function hasWeeblyExportContent(root) {
  for (const rel of ['reference/WeeblyExport', 'src/WeeblyExport']) {
    const full = path.join(root, rel);
    if (!(await exists(full))) continue;
    try {
      const entries = await fs.readdir(full);
      if (entries.length) return true;
    } catch { /* unreadable — treat as empty */ }
  }
  return false;
}

function runCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', reject);
  });
}

/**
 * Build the config object by merging (in order of precedence):
 *   flag value > prior cached answer > computed default.
 */
async function buildConfig(root, flags, prior) {
  const autoAccept = !!flags.yes;

  // Default project name from dir name, falling back to parent if dir is generic.
  const dirName = path.basename(root);
  const generic = ['web', 'site', 'frontend', 'www'];
  const fallback = generic.includes(dirName.toLowerCase())
    ? path.basename(path.dirname(root))
    : dirName;
  const defaultName = prior.name || fallback;

  console.log('\nProject details:\n');
  const name = await ask('Project name',
    { default: defaultName, value: flags.name, autoAccept });
  const slug = await ask('npm package slug',
    { default: prior.slug || slugify(name), value: flags.slug, autoAccept });
  const description = await ask('One-line description',
    { default: prior.description || `${name} website`, value: flags.description, autoAccept });

  console.log('\nFirebase:\n');
  const firebaseProject = await askValid('Firebase project ID', {
    default: prior.firebaseProject || slug,
    value: flags.firebaseProject,
    autoAccept,
    validate: v => v.length > 0 ? true : 'required (see firebase.google.com/project)',
  });
  const hostingSite = await ask(
    'Hosting site name (firebase.json hosting.site — blank for project default)',
    { default: prior.hostingSite || '', value: flags.hostingSite, autoAccept },
  );
  // Opt-in: actually create the project + site via the firebase CLI after
  // scaffolding. Requires `firebase login`; the helper detects + reports.
  const setupFirebase = await askYesNo(
    'Create the Firebase project + hosting site via CLI after scaffolding? (requires firebase login)',
    { default: prior.setupFirebase ?? false, value: flags.setupFirebase, autoAccept },
  );

  console.log('\nLive site (primary source — wget mirror is the input):\n');
  // Strip any scheme + trailing slash so the cached value matches the
  // directory wget writes the mirror into (reference/<host>/). Same call
  // crawl/port use — keeps the round trip stable.
  const liveDomain = normalizeDomain(await ask(
    'Live Weebly domain (leave blank only if the site is already offline)',
    { default: prior.liveDomain || '', value: flags.liveDomain, autoAccept },
  ));
  const githubRepo = await ask(
    'GitHub repo (owner/name; blank if not pushing yet)',
    { default: prior.githubRepo || '', value: flags.githubRepo, autoAccept },
  );

  return { name, slug, description, firebaseProject, hostingSite, setupFirebase, liveDomain, githubRepo };
}

function printSummary(cfg, flags) {
  console.log('\nSummary:');
  for (const [k, v] of Object.entries(cfg)) {
    // Booleans need their own rendering — `false || '(none)'` would otherwise
    // print "(none)" for an intentional "no".
    const display = typeof v === 'boolean' ? (v ? 'yes' : 'no') : (v || '(none)');
    console.log(`  ${k.padEnd(16)} ${display}`);
  }
  // Walk the same gates the runner walks so the preview matches reality —
  // skip-flags suppress lines, no liveDomain hides the crawl/port pair, etc.
  // Makes "Proceed?" a decision against a concrete plan rather than a leap.
  console.log('\nPipeline (auto-runs on Proceed):');
  let n = 1;
  console.log(`  ${n++}. Scaffold config + directories`);
  if (cfg.setupFirebase) console.log(`  ${n++}. Create Firebase project + hosting site via CLI`);
  if (!flags.skipCrawl && cfg.liveDomain) {
    console.log(`  ${n++}. Mirror ${cfg.liveDomain} with wget   [primary source]`);
  }
  if (!flags.skipPort && cfg.liveDomain && !flags.skipCrawl) {
    console.log(`  ${n++}. Port every page → src/html/ + dump CSS/fonts/images`);
  }
  if (!flags.skipConvert) {
    console.log(`  ${n++}. Overlay WeeblyExport theme           (only if reference/WeeblyExport/ has content)`);
  }
  if (!flags.skipGit) console.log(`  ${n++}. git init + initial commit`);
}

async function scaffoldConfigFiles(root, cfg) {
  console.log('\nScaffolding config:');
  await writeIfMissing(root, 'package.json',    t.packageJson(cfg));
  await writeIfMissing(root, 'firebase.json',   t.firebaseJson(cfg));
  await writeIfMissing(root, '.firebaserc',     t.firebaseRc(cfg));
  await writeIfMissing(root, '.posthtmlrc.js',  t.posthtmlrc());
  await writeIfMissing(root, '.gitignore',      t.gitignore());
  await writeIfMissing(root, '.gitattributes',  t.gitattributes());
  await writeIfMissing(root, 'README.md',       t.readme(cfg));
  // GitHub Actions deploy workflow lands only when both pieces are known —
  // we need the Firebase project ID (for the projectId field and the
  // service-account secret name) and the GitHub repo (implies CI lives
  // there at all). Otherwise the file would point at a placeholder secret
  // and confuse more than help.
  if (cfg.githubRepo && cfg.firebaseProject) {
    await writeIfMissing(
      root,
      '.github/workflows/firebase-hosting-merge.yml',
      t.githubActionsHostingDeploy(cfg),
    );
  }
}

/**
 * Drop the reusable JS/LESS modules every Weebly migration tends to need
 * (email-hider, embed-consent, lightbox). The files land unused — neither
 * `app.js` nor `main.less` imports them — so they cost nothing until the
 * user wires one up. See lib/scaffold-modules.mjs for rationale.
 */
async function scaffoldReusableModules(root) {
  console.log('\nScaffolding reusable modules (opt-in — see each @docs sibling):');
  for (const [relPath, content] of Object.entries(reusableModuleFiles())) {
    await writeIfMissing(root, relPath, content);
  }
}

async function scaffoldDirectories(root) {
  console.log('\nScaffolding directories:');
  const dirs = [
    // src/gfx is the single bucket for graphics — deployable images AND
    // design sources (PSD/AFD/etc.) live side by side. The .gitignore strips
    // design-source extensions, leaving the deployable formats checked in.
    'src/html', 'src/less', 'src/js', 'src/gfx',
    'public/assets/css', 'public/assets/js', 'public/assets/gfx',
    // Empty reference/WeeblyExport is the agreed drop target so the user
    // sees where to unzip their Weebly theme export.
    'reference/WeeblyExport',
  ];
  for (const d of dirs) {
    const full = path.join(root, d);
    if (await exists(full)) {
      console.log(`  skip ${d}/ (exists)`);
    } else {
      await fs.mkdir(full, { recursive: true });
      console.log(`  +    ${d}/`);
    }
  }
}

/**
 * Initialize git + commit the scaffold. No prompt — the wizard's "Proceed?"
 * step already gated the whole pipeline; asking again per sub-step is
 * friction. Skip path is `--skip-git`. A pre-existing `.git/` short-circuits
 * because committing into someone else's repo is a surprise.
 */
async function initGit(root, cfg) {
  if (await exists(path.join(root, '.git'))) {
    console.log('\nGit repo already initialized — skipping initial commit.');
    return;
  }
  console.log('\nInitializing git repo…');
  await runCmd('git', ['init', '-b', 'main'], root);
  await runCmd('git', ['add', '.'], root);
  await runCmd('git', ['commit', '-m', `Initial scaffold (${cfg.name})`], root);
  if (cfg.githubRepo) {
    console.log(`\nNext: create the repo on GitHub and push:`);
    console.log(`  gh repo create ${cfg.githubRepo} --private --source=. --remote=origin --push`);
  }
}

function printNextSteps(root, cfg) {
  console.log('\nNext steps:');
  console.log(`  cd "${root}"`);
  console.log('  npm install');
  console.log(`  firebase use ${cfg.firebaseProject}`);
  console.log('  npm run dev          # firebase emulators');
  console.log('  npm run build        # less + js → public/');
  console.log('  npm run deploy       # firebase hosting');
  if (cfg.liveDomain) {
    console.log('\nRefresh the live-site mirror or re-port any time:');
    console.log('  w2f crawl            # refresh wget mirror (sitemap-seeded)');
    console.log('  w2f port --all       # re-extract every page in the mirror');
    console.log('  w2f port kontakt     # re-extract a single page');
  }
  console.log('\nGot a Weebly theme export? Drop it into reference/WeeblyExport/ and:');
  console.log('  w2f convert          # overlay cleaner LESS/JS source on top of the mirror dump');
  console.log('');
}

export async function run(flags = {}) {
  const root = resolveTarget(flags.target);
  const configFile = path.join(root, '.weebly-migrate.json');
  const autoAccept = !!flags.yes;

  console.log('Weebly → Firebase converter\n');
  console.log(`Target: ${root}`);

  const prior = await readJson(configFile);
  if (Object.keys(prior).length) console.log('(prior config found — values offered as defaults)');

  const cfg = await buildConfig(root, flags, prior);
  printSummary(cfg, flags);

  if (!await askYesNo('\nProceed?', { default: true, autoAccept })) {
    console.log('Aborted.');
    return;
  }

  await scaffoldConfigFiles(root, cfg);
  await scaffoldDirectories(root);
  await scaffoldReusableModules(root);
  await fs.writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n  +    .weebly-migrate.json (cache for re-runs)`);

  // Pass through to sub-commands with the resolved root so they don't
  // re-resolve. Force `yes: true` so child commands don't re-prompt — the
  // wizard's "Proceed?" step is the single go signal; each sub-step is
  // already gated by an explicit `--skip-*` flag.
  const subFlags = { ...flags, target: root, yes: true };

  // Firebase project + hosting site, opt-in. Failures are non-fatal — the
  // user can still finish setup by hand from the scaffolded .firebaserc.
  if (cfg.setupFirebase) await setupFirebaseProject(cfg);

  // — Live site (primary): crawl → port-all —
  //
  // wget mirroring is the canonical input. With a liveDomain set we crawl
  // + port back-to-back automatically so the project lands buildable from
  // the wizard alone — no manual round-trip. Opt out per step via
  // --skip-crawl / --skip-port.
  let crawled = false;
  if (!flags.skipCrawl && cfg.liveDomain) {
    console.log(`\nMirroring ${cfg.liveDomain} into reference/ (wget — primary source)…`);
    await runCrawl({ ...subFlags, domain: cfg.liveDomain });
    crawled = true;
  }

  if (crawled && !flags.skipPort) {
    console.log('\nPorting every crawled page into src/html/ + dumping CSS/fonts/images…');
    // Errors here (missing index page, unreadable mirror, etc.) shouldn't
    // abort the wizard — the user can re-run `w2f port --all` after
    // they've sorted out whatever wget left behind.
    try { await runPort({ ...subFlags, all: true }, []); }
    catch (err) { console.log(`\n  !  port failed: ${err.message}`); }
  }

  // — Optional WeeblyExport overlay —
  //
  // Auto-run when reference/WeeblyExport/ actually has content. An empty
  // folder is the scaffold-created drop target, not a real source — skip
  // silently in that case. Hard opt-out via --skip-convert.
  if (!flags.skipConvert) {
    const hasExport = await hasWeeblyExportContent(root);
    if (hasExport) {
      console.log('\nOverlaying WeeblyExport theme onto src/{less,js,html} (cleaner LESS/JS source)…');
      await runConvert(subFlags);
    } else if (crawled) {
      console.log('\n(No Weebly theme export found — skipping convert overlay.');
      console.log(' Drop one into reference/WeeblyExport/ and run `w2f convert` to overlay later.)');
    }
  }

  if (!flags.skipGit) await initGit(root, cfg);
  printNextSteps(root, cfg);
}
