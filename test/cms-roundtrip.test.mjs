// w2f cms test suite — written test-first from dev/plans/cms.md (Stage 2.5).
// Guard: touches only test/**; source modules are expected to not exist until Stage 3.
//
// End-to-end round-trip (dev/specs/cms.md acceptance criterion): scaffold
// the fixture → run cms → `npm i` in the temp project → simulate the
// posthtml build step → run the shipped scripts/render-content.mjs →
// normalized-DOM diff of the rebuilt <main> against a pre-lift snapshot.
// Heavy (npm install, real subprocess) — skipped via t.skip() when
// W2F_SKIP_E2E=1 (fast local loop; CI has network and runs it in full).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeHtml } from './helpers/normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures/ported-site');
const PAGES = ['index', 'about', 'contact', 'plain', 'wrapped'];

function extractMain(html) {
  const m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return m ? m[1] : '';
}

async function freshFixture(prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.cp(FIXTURE_DIR, tmp, { recursive: true });
  return tmp;
}

/**
 * `src/html/[!_]*.html` in this fixture carries no `<include>` partials to
 * resolve (deliberate — see the test-writer brief for test/fixtures/
 * ported-site/), so a straight copy into public/ matches what posthtml's
 * `build:html` would emit here. Keeps the round-trip's dependency surface
 * to exactly what render-content.mjs itself needs (yaml + marked).
 */
async function simulatePosthtmlBuild(root, pages) {
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  for (const page of pages) {
    await fs.copyFile(
      path.join(root, 'src/html', `${page}.html`),
      path.join(root, 'public', `${page}.html`),
    );
  }
}

test('cms round-trip — rendered output matches the pre-lift ported page', async (t) => {
  if (process.env.W2F_SKIP_E2E === '1') {
    t.skip('W2F_SKIP_E2E=1');
    return;
  }

  const tmp = await freshFixture('w2f-cms-e2e-');

  const snapshots = {};
  for (const page of PAGES) {
    const html = await fs.readFile(path.join(tmp, 'src/html', `${page}.html`), 'utf8');
    snapshots[page] = extractMain(html);
  }

  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);

  const npmInstall = spawnSync('npm', ['i', '--no-audit', '--no-fund'], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(npmInstall.status, 0, `npm i failed:\n${npmInstall.stderr}`);

  await simulatePosthtmlBuild(tmp, PAGES);

  const render = spawnSync(process.execPath, ['scripts/render-content.mjs'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.equal(render.status, 0, `render-content.mjs failed:\n${render.stderr}`);

  // The lone local asset in the fixture (index.html's pixel.png) is copied
  // to public/assets/files/ and its references rewritten there; map it back
  // to the original /assets/gfx/ path so the diff against the pre-lift
  // snapshot is fair.
  const assetMap = { '/assets/files/pixel.png': '/assets/gfx/pixel.png' };

  for (const page of PAGES) {
    const built = await fs.readFile(path.join(tmp, 'public', `${page}.html`), 'utf8');
    const builtMain = extractMain(built);
    assert.equal(
      normalizeHtml(builtMain, { assetMap }),
      normalizeHtml(snapshots[page]),
      `round-trip mismatch on ${page}.html`,
    );
  }
});

test('cms round-trip — draft:true removes the section from rendered output', async (t) => {
  if (process.env.W2F_SKIP_E2E === '1') {
    t.skip('W2F_SKIP_E2E=1');
    return;
  }

  const tmp = await freshFixture('w2f-cms-e2e-draft-');

  const { run } = await import('../commands/cms.mjs');
  await run({ target: tmp, yes: true }, []);

  const npmInstall = spawnSync('npm', ['i', '--no-audit', '--no-fund'], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(npmInstall.status, 0, `npm i failed:\n${npmInstall.stderr}`);

  // Flip the "Our Story" section's draft flag before the first render.
  // Regex is scoped to pageYaml()'s documented shape (dev/plans/cms.md
  // Step 3): each section's own `draft: false` line is the nearest one
  // after its `heading:` line, so a non-greedy match stays inside the
  // section it names.
  const ymlPath = path.join(tmp, 'src/content/about.yml');
  const yml = await fs.readFile(ymlPath, 'utf8');
  const flipped = yml.replace(
    /(heading: "Our Story"[\s\S]*?)draft: false/,
    '$1draft: true',
  );
  assert.notEqual(flipped, yml, 'expected a draft: false line under "Our Story" — check pageYaml() shape');
  await fs.writeFile(ymlPath, flipped);

  await simulatePosthtmlBuild(tmp, ['about']);

  const render = spawnSync(process.execPath, ['scripts/render-content.mjs'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.equal(render.status, 0, `render-content.mjs failed:\n${render.stderr}`);

  const built = await fs.readFile(path.join(tmp, 'public/about.html'), 'utf8');
  assert.doesNotMatch(built, /Our Story/);
  assert.doesNotMatch(built, /It started with a single client/);
  // Sibling sections stay rendered — only the drafted one drops out.
  assert.match(built, /Our Team/);
});
