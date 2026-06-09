/**
 * Tiny readline wrapper. Zero deps, shared across all commands.
 *
 * Each `ask*` function accepts an options bag with:
 *   - default      fallback shown to the user, returned on empty input
 *   - value        flag-provided value; if set, skip the prompt entirely
 *   - autoAccept   global --yes; if set, return the default without prompting
 *   - validate     (askValid only) `(v) => true | "error string"`
 *
 * This is the bridge between the interactive flow and the non-interactive
 * flag-driven flow: every prompt site stays a single line of code.
 *
 * Single readline interface is created lazily; whichever entry point owns
 * the lifecycle calls close() at the end.
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let rl = null;

function getRl() {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
  return rl;
}

function hasValue(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Free-form string prompt. Returns the trimmed answer, or the default if the
 * user just hit enter. Flag value short-circuits the prompt entirely.
 */
export async function ask(question, opts = {}) {
  const { default: def = '', value, autoAccept = false } = opts;
  if (hasValue(value)) return String(value);
  if (autoAccept) return def;
  const suffix = def ? ` (${def})` : '';
  const answer = (await getRl().question(`${question}${suffix}: `)).trim();
  return answer || def;
}

/**
 * Yes/no prompt. Accepts y/yes/n/no (case-insensitive). Any other input
 * falls back to the default. `value` must be a boolean if provided.
 */
export async function askYesNo(question, opts = {}) {
  const { default: defaultYes = true, value, autoAccept = false } = opts;
  if (typeof value === 'boolean') return value;
  if (autoAccept) return defaultYes;
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const raw = (await getRl().question(`${question} [${hint}] `)).trim().toLowerCase();
  if (!raw) return defaultYes;
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  return defaultYes;
}

/**
 * Prompt for a value that must satisfy `validate(v)`. Re-prompts on invalid
 * input. If a flag `value` is provided and invalid, throws (we can't loop
 * in non-interactive mode). If `autoAccept` is set, validates the default.
 */
export async function askValid(question, opts = {}) {
  const { default: def, value, validate, autoAccept = false } = opts;
  if (hasValue(value)) {
    const ok = validate(value);
    if (ok === true) return value;
    throw new Error(`invalid value for "${question}": ${ok}`);
  }
  if (autoAccept) {
    const ok = validate(def);
    if (ok === true) return def;
    throw new Error(`invalid default for "${question}": ${ok}`);
  }
  for (;;) {
    const v = await ask(question, { default: def });
    const ok = validate(v);
    if (ok === true) return v;
    console.log(`  → ${ok}`);
  }
}

export function close() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
