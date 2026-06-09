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
 *   3. Create src/{html,less,js,gfx,img}, public/assets/{css,js,img}, reference/.
 *   4. Optionally: run `convert`, run `crawl`, `git init` + initial commit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ask, askValid, askYesNo } from '../lib/prompt.mjs';
import { resolveTarget } from '../lib/target.mjs';
import * as t from '../lib/templates.mjs';
import { run as runConvert } from './convert.mjs';
import { run as runCrawl } from './crawl.mjs';
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

/** kebab-case a free-form name. "Nele Quaas" → "nele-quaas". */
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

  console.log('\nMigration sources:\n');
  // Strip any scheme + trailing slash so the cached value matches the
  // directory wget writes the mirror into (reference/<host>/). Same call
  // crawl/port use — keeps the round trip stable.
  const liveDomain = normalizeDomain(await ask(
    'Live Weebly domain (for asset mirror; blank to skip)',
    { default: prior.liveDomain || '', value: flags.liveDomain, autoAccept },
  ));
  const githubRepo = await ask(
    'GitHub repo (owner/name; blank if not pushing yet)',
    { default: prior.githubRepo || '', value: flags.githubRepo, autoAccept },
  );

  return { name, slug, description, firebaseProject, hostingSite, setupFirebase, liveDomain, githubRepo };
}

function printSummary(cfg) {
  console.log('\nSummary:');
  for (const [k, v] of Object.entries(cfg)) {
    // Booleans need their own rendering — `false || '(none)'` would otherwise
    // print "(none)" for an intentional "no".
    const display = typeof v === 'boolean' ? (v ? 'yes' : 'no') : (v || '(none)');
    console.log(`  ${k.padEnd(16)} ${display}`);
  }
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
}

async function scaffoldDirectories(root) {
  console.log('\nScaffolding directories:');
  const dirs = [
    'src/html', 'src/less', 'src/js', 'src/gfx', 'src/img',
    'public/assets/css', 'public/assets/js', 'public/assets/img',
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

async function maybeInitGit(root, cfg, autoAccept) {
  if (await exists(path.join(root, '.git'))) {
    console.log('\nGit repo already initialized.');
    return;
  }
  const proceed = await askYesNo('\nInitialize git repo with an initial commit?',
    { default: true, autoAccept });
  if (!proceed) return;
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
    console.log('\nRefresh the live-site mirror any time:');
    console.log('  weebly-to-firebase crawl');
  }
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
  printSummary(cfg);

  if (!await askYesNo('\nProceed?', { default: true, autoAccept })) {
    console.log('Aborted.');
    return;
  }

  await scaffoldConfigFiles(root, cfg);
  await scaffoldDirectories(root);
  await fs.writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n  +    .weebly-migrate.json (cache for re-runs)`);

  // Pass through to sub-commands with the resolved root so they don't re-resolve.
  const subFlags = { ...flags, target: root };

  // Firebase project + hosting site, opt-in. Failures are non-fatal — the
  // user can still finish setup by hand from the scaffolded .firebaserc.
  if (cfg.setupFirebase) await setupFirebaseProject(cfg);

  if (!flags.skipConvert) {
    const doConvert = await askYesNo(
      '\nConvert Weebly assets now (reference/WeeblyExport → src/{less,js,html})?',
      { default: true, autoAccept },
    );
    if (doConvert) await runConvert(subFlags);
  }

  if (!flags.skipCrawl && cfg.liveDomain) {
    const doCrawl = await askYesNo(
      `\nMirror ${cfg.liveDomain} into reference/ now?`,
      { default: true, autoAccept },
    );
    if (doCrawl) await runCrawl({ ...subFlags, domain: cfg.liveDomain });
  }

  if (!flags.skipGit) await maybeInitGit(root, cfg, autoAccept);
  printNextSteps(root, cfg);
}
