/**
 * Resolve the target project directory the tool should operate on.
 *
 * The tool lives outside the project (in ~/Work Files/Weebly-to-Firebase/) and
 * mutates a separate project root, so every script needs a consistent way to
 * answer the question "where am I working?".
 *
 * Resolution order:
 *   1. Explicit positional arg (process.argv[2])
 *   2. process.cwd()
 *
 * Throws if the resolved path doesn't exist — better to fail loud than
 * silently scaffold into the wrong directory.
 */

import fs from 'node:fs';
import path from 'node:path';

export function resolveTarget(argv) {
  const arg = argv && argv[0];
  const target = arg ? path.resolve(arg) : process.cwd();
  if (!fs.existsSync(target)) {
    throw new Error(`Target directory does not exist: ${target}`);
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new Error(`Target is not a directory: ${target}`);
  }
  return target;
}
