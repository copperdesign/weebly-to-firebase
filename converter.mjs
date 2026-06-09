#!/usr/bin/env node
/**
 * Weebly → Firebase converter (main entry).
 *
 * Bootstraps a Firebase Hosting project around an existing src/WeeblyExport/.
 *
 * Interactive and idempotent: writes the standard scaffold (package.json,
 * firebase.json, .firebaserc, .gitignore, .gitattributes, README.md), creates
 * src/{html,less,js,gfx,img} and public/, then optionally:
 *   - migrates Weebly assets into src/   (delegated to convert-assets.mjs)
 *   - mirrors the live site into reference/  (delegated to crawl-site.mjs)
 *   - initializes git with an initial commit
 *
 * Re-runnable: prior answers are cached in <target>/.weebly-migrate.json and
 * offered as defaults next time. Never overwrites existing files.
 *
 * Usage:
 *   cd <project-root> && node ~/Work\ Files/Weebly-to-Firebase/converter.mjs
 *   # or
 *   node ~/Work\ Files/Weebly-to-Firebase/converter.mjs <project-root>
 *   # or, if linked globally (`npm link` from this dir):
 *   weebly-to-firebase [project-root]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ask, askValid, askYesNo, close } from './lib/prompt.mjs';
import { resolveTarget } from './lib/target.mjs';
import * as t from './lib/templates.mjs';
import { run as runConvert } from './convert-assets.mjs';
import { run as runCrawl } from './crawl-site.mjs';

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

/**
 * Write a file only if it doesn't already exist, unless `force` is true.
 * Returns true if written.
 */
async function writeIfMissing(root, relPath, contents, { force = false } = {}) {
  const filePath = path.join(root, relPath);
  if (!force && await exists(filePath)) {
    console.log(`  skip ${relPath} (exists)`);
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
  console.log(`  +    ${relPath}`);
  return true;
}

/** Spawn a command, inheriting stdio. Resolves with exit code. */
function runCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', reject);
  });
}

async function promptConfig(root, prior) {
  // Heuristic default for project name: the target dir, or its parent if the
  // target is a generic "web" / "site" / "frontend" folder.
  const dirName = path.basename(root);
  const generic = ['web', 'site', 'frontend', 'www'];
  const fallback = generic.includes(dirName.toLowerCase())
    ? path.basename(path.dirname(root))
    : dirName;
  const defaultName = prior.name || fallback;

  console.log('\nProject details:\n');
  const name = await ask('Project name', defaultName);
  const slug = await ask('npm package slug', prior.slug || slugify(name));
  const description = await ask('One-line description', prior.description || `${name} website`);

  console.log('\nFirebase:\n');
  const firebaseProject = await askValid(
    'Firebase project ID',
    prior.firebaseProject || slug,
    v => v.length > 0 ? true : 'required (see firebase.google.com/project)',
  );
  const hostingSite = await ask(
    'Hosting site name (firebase.json hosting.site — blank for project default)',
    prior.hostingSite || '',
  );

  console.log('\nMigration sources:\n');
  const liveDomain = await ask(
    'Live Weebly domain (for asset mirror; blank to skip)',
    prior.liveDomain || '',
  );
  const githubRepo = await ask(
    'GitHub repo (owner/name; blank if not pushing yet)',
    prior.githubRepo || '',
  );

  return { name, slug, description, firebaseProject, hostingSite, liveDomain, githubRepo };
}

function printSummary(cfg) {
  console.log('\nSummary:');
  for (const [k, v] of Object.entries(cfg)) {
    console.log(`  ${k.padEnd(16)} ${v || '(none)'}`);
  }
}

async function scaffoldConfigFiles(root, cfg) {
  console.log('\nScaffolding config:');
  await writeIfMissing(root, 'package.json',    t.packageJson(cfg));
  await writeIfMissing(root, 'firebase.json',   t.firebaseJson(cfg));
  await writeIfMissing(root, '.firebaserc',     t.firebaseRc(cfg));
  await writeIfMissing(root, '.gitignore',      t.gitignore());
  await writeIfMissing(root, '.gitattributes',  t.gitattributes());
  await writeIfMissing(root, 'README.md',       t.readme(cfg));
}

async function scaffoldDirectories(root) {
  console.log('\nScaffolding directories:');
  const dirs = [
    'src/html', 'src/less', 'src/js', 'src/gfx', 'src/img',
    'public/assets/css', 'public/assets/js', 'public/assets/img',
    'reference',
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

async function maybeInitGit(root, cfg) {
  if (await exists(path.join(root, '.git'))) {
    console.log('\nGit repo already initialized.');
    return;
  }
  if (!await askYesNo('\nInitialize git repo with an initial commit?', true)) return;
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
    console.log('\nIf you skipped the crawl, run it any time:');
    console.log(`  node ~/Work\\ Files/Weebly-to-Firebase/crawl-site.mjs`);
  }
  console.log('');
}

async function main() {
  const root = resolveTarget(process.argv.slice(2));
  const configFile = path.join(root, '.weebly-migrate.json');

  console.log('Weebly → Firebase converter\n');
  console.log(`Target: ${root}`);

  const prior = await readJson(configFile);
  if (Object.keys(prior).length) console.log('(prior config found — values offered as defaults)');

  const cfg = await promptConfig(root, prior);
  printSummary(cfg);

  if (!await askYesNo('\nProceed?', true)) {
    console.log('Aborted.');
    return;
  }

  await scaffoldConfigFiles(root, cfg);
  await scaffoldDirectories(root);
  await fs.writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n  +    .weebly-migrate.json (cache for re-runs)`);

  if (await askYesNo('\nConvert Weebly assets now (src/WeeblyExport → src/{less,js,html})?', true)) {
    await runConvert({ root, interactive: true });
  }

  if (cfg.liveDomain && await askYesNo(`\nMirror ${cfg.liveDomain} into reference/ now?`, true)) {
    await runCrawl({ root, interactive: false, domain: cfg.liveDomain });
  }

  await maybeInitGit(root, cfg);
  printNextSteps(root, cfg);
}

try {
  await main();
} finally {
  close();
}
