/**
 * Tiny readline wrapper. Zero deps, shared across all scripts.
 *
 * Single readline interface is created lazily on first use. Whichever entry
 * point owns the lifecycle calls close() at the end; sub-scripts imported
 * from converter.mjs just reuse the same instance.
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let rl = null;

function getRl() {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
  return rl;
}

/**
 * Prompt for a free-form string. Returns the trimmed answer, or the default
 * if the user just hit enter.
 */
export async function ask(question, defaultValue = '') {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = (await getRl().question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

/**
 * Prompt for yes/no. `defaultYes` controls what enter-with-no-input means.
 * Accepts y/yes/n/no (case-insensitive); any other answer falls back to default.
 */
export async function askYesNo(question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const raw = (await getRl().question(`${question} [${hint}] `)).trim().toLowerCase();
  if (!raw) return defaultYes;
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  return defaultYes;
}

/**
 * Prompt for a value that must satisfy `validate(value)`. Re-prompts on invalid
 * input. `validate` returns true for valid, or a string error message.
 */
export async function askValid(question, defaultValue, validate) {
  for (;;) {
    const value = await ask(question, defaultValue);
    const ok = validate(value);
    if (ok === true) return value;
    console.log(`  → ${ok}`);
  }
}

export function close() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
