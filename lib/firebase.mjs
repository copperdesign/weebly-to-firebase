/**
 * Firebase project + hosting site setup via the `firebase` CLI.
 *
 * Opt-in step run from `init` (--setup-firebase or interactive prompt).
 * Idempotent: existing projects/sites are detected and left alone; only the
 * missing pieces get created.
 *
 * Preconditions:
 *   - `firebase` CLI installed (npm i -g firebase-tools)
 *   - User logged in (`firebase login`)
 *
 * Output streams straight to the terminal — Firebase may need to prompt
 * (org selection, billing confirmation, etc.) and the user has to see it.
 * Any failure is surfaced and returned as `false`; the parent init keeps
 * going (.firebaserc is already written, so the user can finish setup by
 * hand).
 */

import { spawn } from 'node:child_process';

/** Capture stdout/stderr/exit without inheriting the TTY. */
function runCapture(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('exit', code => resolve({ code: code ?? 0, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}

/** Stream stdio through — for commands that may prompt the user. */
function runStream(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', code => resolve(code ?? 0));
    child.on('error', () => resolve(-1));
  });
}

async function hasFirebaseCli() {
  const { code } = await runCapture('firebase', ['--version']);
  return code === 0;
}

/**
 * Coerce a free-form project name into a valid GCP display name. The Cloud
 * Resource Manager only accepts letters, numbers, spaces, hyphens, single
 * quotes and `!`, 4–30 chars — so a domain like "foo.de" is rejected for the
 * dot (this is exactly what bit hanna-m-schilling.de). Map anything illegal to
 * a hyphen, collapse runs, trim the edges, cap at 30, and pad short results so
 * the create call always gets a name the API will take.
 */
function toDisplayName(name) {
  let s = name
    .replace(/[^A-Za-z0-9 '!-]+/g, '-') // illegal char(s) → single hyphen
    .replace(/-{2,}/g, '-')             // collapse hyphen runs
    .replace(/^[\s-]+|[\s-]+$/g, '')    // trim leading/trailing space + hyphen
    .slice(0, 30);
  if (s.length < 4) s = `${s}-site`.slice(0, 30); // satisfy the 4-char minimum
  return s;
}

/**
 * List project IDs the user can access. Returns null on auth/CLI failure —
 * the caller surfaces that as "run firebase login" rather than silently
 * trying to create a duplicate.
 */
async function listProjectIds() {
  const { code, stdout } = await runCapture('firebase', ['projects:list', '--json']);
  if (code !== 0) return null;
  try {
    const parsed = JSON.parse(stdout);
    const result = parsed.result;
    if (!Array.isArray(result)) return null;
    return result.map(p => p.projectId).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * List hosting site IDs for the given project. Site `name` comes back as
 * `projects/<id>/sites/<siteId>`; we keep just the trailing siteId.
 */
async function listHostingSiteIds(projectId) {
  const { code, stdout } = await runCapture('firebase', [
    'hosting:sites:list', '--project', projectId, '--json',
  ]);
  if (code !== 0) return null;
  try {
    const parsed = JSON.parse(stdout);
    const sites = parsed.result?.sites ?? [];
    return sites.map(s => s.name?.split('/').pop()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Create the Firebase project (if missing) + the named hosting site (if the
 * user asked for one distinct from the project default). Returns true on
 * full success, false on any failure — the parent init keeps going either
 * way so the user isn't left with a half-scaffolded directory.
 */
export async function setupFirebaseProject(cfg) {
  console.log('\n→ Firebase project setup\n');

  if (!(await hasFirebaseCli())) {
    console.log('  !  firebase CLI not found.');
    console.log('     Install: npm i -g firebase-tools');
    return false;
  }

  const projects = await listProjectIds();
  if (projects === null) {
    console.log('  !  Could not list Firebase projects.');
    console.log('     Run: firebase login');
    return false;
  }

  // 1. Project — create if missing.
  if (projects.includes(cfg.firebaseProject)) {
    console.log(`  ok   project ${cfg.firebaseProject} already exists`);
  } else {
    const displayName = toDisplayName(cfg.name);
    console.log(`  +    creating project ${cfg.firebaseProject} ("${displayName}")…`);
    const code = await runStream('firebase', [
      'projects:create', cfg.firebaseProject,
      '--display-name', displayName,
    ]);
    if (code !== 0) {
      console.log(`  !    project create failed (exit ${code}).`);
      console.log('       Common causes: project ID taken globally, quota hit, billing required.');
      console.log('       See firebase-debug.log for the underlying API error.');
      return false;
    }
  }

  // 2. Hosting site — only when the user named one different from the project
  // default. Each Firebase project ships with a default site matching its ID;
  // additional named sites need explicit creation.
  if (cfg.hostingSite && cfg.hostingSite !== cfg.firebaseProject) {
    const sites = await listHostingSiteIds(cfg.firebaseProject);
    if (sites === null) {
      console.log(`  !    Could not list hosting sites for ${cfg.firebaseProject}.`);
      return false;
    }
    if (sites.includes(cfg.hostingSite)) {
      console.log(`  ok   hosting site ${cfg.hostingSite} already exists`);
    } else {
      console.log(`  +    creating hosting site ${cfg.hostingSite}…`);
      const code = await runStream('firebase', [
        'hosting:sites:create', cfg.hostingSite,
        '--project', cfg.firebaseProject,
      ]);
      if (code !== 0) {
        console.log(`  !    hosting site create failed (exit ${code}).`);
        return false;
      }
    }
  }

  console.log('\n  Firebase setup complete.');
  return true;
}
