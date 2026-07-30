// w2f cms test suite — written test-first from dev/plans/cms.md (Stage 2.5).
// Guard: touches only test/**; source modules are expected to not exist until Stage 3.
//
// Command-level tests for commands/cms.mjs (plan Step 4), run against a
// fresh copy of test/fixtures/ported-site/ per test. Covers: section
// extraction/YAML shape, the form-boundary rule, marker replacement +
// $-token survival, idempotency (incl. --force and the two "half state"
// edge cases), scaffold-file writing, package.json mutation (exactly
// once across repeated runs), asset copy/rewrite, and the CLI surface.
//
// commands/cms.mjs does not exist yet — every `await import('../commands/
// cms.mjs')` below throws ERR_MODULE_NOT_FOUND until Stage 3. Imported
// dynamically (inside each test) rather than statically at module scope so
// node --test reports a clean per-test failure instead of crashing the
// whole file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURE_DIR = path.join(HERE, 'fixtures/ported-site');

async function freshFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'w2f-cms-'));
  await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
  return tmp;
}

async function readText(p) {
  return fs.readFile(p, 'utf8');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list every file under `root`, relative paths, sorted. */
async function listFiles(root, base = root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

/**
 * Cheap whole-tree fingerprint: sha256 of every file's relative path +
 * content, in sorted-path order. Used for the "second run is a byte-for-
 * byte no-op" idempotency assertion — any write anywhere in the tree
 * changes the hash, so it's a strictly stronger check than asserting
 * individual files are unchanged one at a time.
 */
async function hashTree(root) {
  const files = await listFiles(root);
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update(await fs.readFile(path.join(root, rel)));
  }
  return hash.digest('hex');
}

/* ──────────────────────────────────────────────────────────────────────────
 * Section extraction / YAML shape
 * ────────────────────────────────────────────────────────────────────────── */

test('cms — full run lifts expected sections per page (headings, lead, title fallback)', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);

  const indexYml = await readText(path.join(tmp, 'src/content/index.yml'));
  assert.match(indexYml, /heading:\s*"Welcome to Acme"/);
  assert.match(indexYml, /heading:\s*"Our Services"/);

  // about.html: content before the first heading → section 0, empty heading.
  const aboutYml = await readText(path.join(tmp, 'src/content/about.yml'));
  assert.match(aboutYml, /heading:\s*""/);
  assert.match(aboutYml, /heading:\s*"Our Story"/);
  assert.match(aboutYml, /heading:\s*"Our Team"/);

  // plain.html: no headings → single section with an EMPTY heading (an
  // invented <h2> would break the round-trip guarantee); the page <title>
  // rides along in the TODO comment as the suggested heading.
  const plainYml = await readText(path.join(tmp, 'src/content/plain.yml'));
  assert.match(plainYml, /heading:\s*""/);
  assert.match(plainYml, /TODO\(w2f\)[^\n]*"Plain Page"/);
});

test('cms — _nav.html partial is excluded from page enumeration', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  assert.equal(await exists(path.join(tmp, 'src/content/_nav.yml')), false);
  assert.equal(await exists(path.join(tmp, 'src/content/nav.yml')), false);
});

test('cms — form boundary: lift stops before <form>, tail (incl. later headings) survives in HTML', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);

  const contactYml = await readText(path.join(tmp, 'src/content/contact.yml'));
  assert.match(contactYml, /heading:\s*"Get in touch"/);
  assert.match(contactYml, /heading:\s*"Visit"/);
  assert.doesNotMatch(contactYml, /Office Hours/);

  const contactHtml = await readText(path.join(tmp, 'src/html/contact.html'));
  assert.match(contactHtml, /<!-- @render:sections -->/);
  assert.match(contactHtml, /<form\b/);
  assert.match(contactHtml, /Office Hours/); // hand-authored tail, kept verbatim
});

test('cms — marker replaces lifted content; $-tokens survive intact (no replace-string expansion bug)', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);

  const indexHtml = await readText(path.join(tmp, 'src/html/index.html'));
  assert.match(indexHtml, /<!-- @render:sections -->/);
  assert.doesNotMatch(indexHtml, /Welcome to Acme/); // lifted out of the page

  const indexYml = await readText(path.join(tmp, 'src/content/index.yml'));
  assert.match(indexYml, /\$&/); // literal dollar token from the fixture survived the lift verbatim
});

/* ──────────────────────────────────────────────────────────────────────────
 * Skeleton pages (port not run / failed)
 * ────────────────────────────────────────────────────────────────────────── */

test('cms — enumerated run skips a still-skeleton page with a log, does not throw', async () => {
  const tmp = await freshFixture();
  await fs.writeFile(
    path.join(tmp, 'src/html/skeleton.html'),
    '<!DOCTYPE html><html><body><main><!-- TODO: port content from reference/x --></main></body></html>',
  );
  const { run } = await import('../commands/cms.mjs');
  await assert.doesNotReject(() => run({ target: tmp, yes: true }, []));
  assert.equal(await exists(path.join(tmp, 'src/content/skeleton.yml')), false);
});

test('cms — named skeleton page throws with a hint to run port first', async () => {
  const tmp = await freshFixture();
  await fs.writeFile(
    path.join(tmp, 'src/html/skeleton.html'),
    '<!DOCTYPE html><html><body><main><!-- TODO: port content from reference/x --></main></body></html>',
  );
  const { run } = await import('../commands/cms.mjs');
  await assert.rejects(() => run({ target: tmp, yes: true }, ['skeleton']), /port/i);
});

test('cms — named page with no src/html/<page>.html throws naming the expected path', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await assert.rejects(
    () => run({ target: tmp, yes: true }, ['nope']),
    /src\/html\/nope\.html/,
  );
});

/* ──────────────────────────────────────────────────────────────────────────
 * Idempotency
 * ────────────────────────────────────────────────────────────────────────── */

test('cms — idempotent second run: byte-identical tree', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const hashAfterFirst = await hashTree(tmp);
  await run({ target: tmp, yes: true }, []);
  const hashAfterSecond = await hashTree(tmp);
  assert.equal(hashAfterSecond, hashAfterFirst);
});

test('cms — yml missing but marker present (content deleted by hand): warns, does not crash, does not re-lift', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  await fs.rm(path.join(tmp, 'src/content/index.yml'));
  await assert.doesNotReject(() => run({ target: tmp, yes: true }, []));
  assert.equal(await exists(path.join(tmp, 'src/content/index.yml')), false);
  const indexHtml = await readText(path.join(tmp, 'src/html/index.html'));
  assert.match(indexHtml, /<!-- @render:sections -->/); // marker untouched, page not re-lifted
});

test('cms — marker absent but yml present (HTML hand-restored from git): skip without --force', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const original = await readText(path.join(FIXTURE_DIR, 'src/html/index.html'));
  await fs.writeFile(path.join(tmp, 'src/html/index.html'), original);
  await assert.doesNotReject(() => run({ target: tmp, yes: true }, []));
  const stillRestored = await readText(path.join(tmp, 'src/html/index.html'));
  assert.equal(stillRestored, original); // untouched — skipped, not re-lifted
});

test('cms — --force re-lifts a page whose HTML was restored from git', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const original = await readText(path.join(FIXTURE_DIR, 'src/html/index.html'));
  await fs.writeFile(path.join(tmp, 'src/html/index.html'), original);
  await run({ target: tmp, yes: true, force: true }, []);
  const relifted = await readText(path.join(tmp, 'src/html/index.html'));
  assert.match(relifted, /<!-- @render:sections -->/);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Scaffold files
 * ────────────────────────────────────────────────────────────────────────── */

test('cms — scaffolds admin shell, config.yml, render-content.mjs, docs/cms.md', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);

  assert.equal(await exists(path.join(tmp, 'public/admin/index.html')), true);
  assert.equal(await exists(path.join(tmp, 'scripts/render-content.mjs')), true);
  assert.equal(await exists(path.join(tmp, 'docs/cms.md')), true);

  const configYml = await readText(path.join(tmp, 'public/admin/config.yml'));
  assert.match(configYml, /# w2f:pages/);
  assert.match(configYml, /TODO\(w2f\)/); // .weebly-migrate.json absent -> githubRepo TODO
  for (const page of ['index', 'about', 'contact', 'plain']) {
    assert.match(configYml, new RegExp(`file:\\s*src/content/${page}\\.yml`));
  }
});

test('cms — cached githubRepo in .weebly-migrate.json fills config.yml backend (no TODO)', async () => {
  const tmp = await freshFixture();
  await fs.writeFile(
    path.join(tmp, '.weebly-migrate.json'),
    JSON.stringify({ githubRepo: 'owner/name' }),
  );
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const configYml = await readText(path.join(tmp, 'public/admin/config.yml'));
  assert.match(configYml, /repo:\s*owner\/name/);
});

test('cms — scaffold files are writeIfMissing (re-run does not clobber hand edits)', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const docsPath = path.join(tmp, 'docs/cms.md');
  await fs.writeFile(docsPath, '# hand-edited\n');
  await run({ target: tmp, yes: true }, []);
  assert.equal(await readText(docsPath), '# hand-edited\n');
});

test('cms — package.json build:html gains the render step + yaml/marked devDeps, exactly once', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  await run({ target: tmp, yes: true }, []); // second run must not duplicate anything

  const pkg = JSON.parse(await readText(path.join(tmp, 'package.json')));

  // Reference-implementation shape: the renderer runs INSIDE build:html,
  // right after posthtml — no separate build:content script.
  const buildHtml = pkg.scripts['build:html'];
  assert.match(buildHtml, /posthtml[\s\S]*&& node scripts\/render-content\.mjs/);
  assert.equal(buildHtml.split('render-content.mjs').length - 1, 1, 'render step not duplicated across runs');
  assert.equal(pkg.scripts['build:content'], undefined, 'no separate build:content script');
  assert.match(pkg.scripts.build, /build:html/);

  assert.ok(pkg.devDependencies.yaml, 'yaml devDependency added');
  assert.ok(pkg.devDependencies.marked, 'marked devDependency added');
});

/* ──────────────────────────────────────────────────────────────────────────
 * Asset copy
 * ────────────────────────────────────────────────────────────────────────── */

test('cms — copies referenced local assets into public/assets/files/, rewrites refs, leaves originals + external URLs untouched', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);

  assert.equal(await exists(path.join(tmp, 'public/assets/files/pixel.png')), true);
  assert.equal(await exists(path.join(tmp, 'public/assets/gfx/pixel.png')), true); // original untouched

  const indexYml = await readText(path.join(tmp, 'src/content/index.yml'));
  assert.match(indexYml, /\/assets\/files\/pixel\.png/);
  assert.doesNotMatch(indexYml, /\/assets\/gfx\/pixel\.png/);

  const aboutYml = await readText(path.join(tmp, 'src/content/about.yml'));
  assert.match(aboutYml, /https:\/\/cdn\.example\.com\/team\/founder\.jpg/); // external, unrewritten
});

/* ──────────────────────────────────────────────────────────────────────────
 * CLI surface
 * ────────────────────────────────────────────────────────────────────────── */

test('cms — CLI: `node cli.mjs help cms` exits 0 and prints USAGE', () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli.mjs'), 'help', 'cms'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /USAGE/);
  assert.match(result.stdout, /\bcms\b/);
});

// — Review-fix regressions (Stage 3.5) —

test('cms — .htm pages are read by their real filename (no mid-run ENOENT)', async () => {
  const tmp = await freshFixture();
  await fs.rename(path.join(tmp, 'src/html/about.html'), path.join(tmp, 'src/html/about.htm'));
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  assert.equal(await exists(path.join(tmp, 'src/content/about.yml')), true);
  const html = await readText(path.join(tmp, 'src/html/about.htm'));
  assert.match(html, /@render:sections/);
});

test('cms — named .htm page resolves too', async () => {
  const tmp = await freshFixture();
  await fs.rename(path.join(tmp, 'src/html/about.html'), path.join(tmp, 'src/html/about.htm'));
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, ['about']);
  assert.equal(await exists(path.join(tmp, 'src/content/about.yml')), true);
});

test('cms — config.yml is deferred when no pages lift (never files: null)', async () => {
  const tmp = await freshFixture();
  // Turn every page into a port skeleton so nothing lifts.
  const dir = path.join(tmp, 'src/html');
  for (const f of await fs.readdir(dir)) {
    if (f.startsWith('_') || !/\.html?$/i.test(f)) continue;
    const p = path.join(dir, f);
    const html = await readText(p);
    await fs.writeFile(p, html.replace(/<main\b[^>]*>[\s\S]*?<\/main>/i,
      () => '<main>\n    <!-- TODO: port content from reference/ -->\n  </main>'));
  }
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  assert.equal(await exists(path.join(tmp, 'public/admin/config.yml')), false);
  // Admin shell and render script still scaffold — only the config defers.
  assert.equal(await exists(path.join(tmp, 'public/admin/index.html')), true);
  assert.equal(await exists(path.join(tmp, 'scripts/render-content.mjs')), true);
});

test('port writePageMain — refuses to clobber a cms-lifted page, even with --force', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const pagePath = path.join(tmp, 'src/html/index.html');
  const lifted = await readText(pagePath);
  assert.match(lifted, /@render:sections/);
  const { writePageMain } = await import('../commands/port.mjs');
  await writePageMain(tmp, 'index', '<p>re-ported mirror content</p>', true);
  const after = await readText(pagePath);
  assert.equal(after, lifted, 'port --force must not touch a cms-lifted page');
});

test('cms — h1 sections carry level: 1 in the YAML; h2 sections do not', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const yml = await readText(path.join(tmp, 'src/content/index.yml'));
  const sections = yml.split(/\n(?=  - heading:)/);
  const welcome = sections.find(s => s.includes('Welcome to Acme'));
  const services = sections.find(s => s.includes('Our Services'));
  assert.match(welcome, /level: 1/);
  assert.doesNotMatch(services, /level: 1/);
});

test('cms — wrapper divs stay hand-authored around the marker; nested sections still lift', async () => {
  const tmp = await freshFixture();
  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);
  const yml = await readText(path.join(tmp, 'src/content/wrapped.yml'));
  assert.match(yml, /heading: "Inside the Wrap"/);
  assert.match(yml, /heading: "Still Inside"/);
  // No orphaned wrapper markup in any section body.
  assert.doesNotMatch(yml, /<div/);
  assert.doesNotMatch(yml, /<\/div>/);
  const html = await readText(path.join(tmp, 'src/html/wrapped.html'));
  // The wrappers survive in the page, balanced, with the marker inside them.
  assert.match(html, /class="main-wrap"[\s\S]*class="container"[\s\S]*@render:sections[\s\S]*<\/div>\s*<\/div>/);
});

test('pageYaml — image scalar is quoted (YAML-special filenames survive)', async () => {
  const { pageYaml } = await import('../lib/cms-templates.mjs');
  const yml = pageYaml('x', [{ heading: 'H', body: 'b', image: '/assets/files/Screen Shot: 1(final) #2.jpg', draft: false }]);
  assert.match(yml, /image: "\/assets\/files\/Screen Shot: 1\(final\) #2\.jpg"/);
});
