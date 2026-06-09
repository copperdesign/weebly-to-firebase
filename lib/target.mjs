/**
 * Resolve the target project directory the tool should operate on.
 *
 * The tool lives outside the project and mutates a separate project root,
 * so every command needs a consistent way to answer "where am I working?".
 *
 *   1. Explicit --target <path> (or first arg, if a command passes it)
 *   2. process.cwd()
 *
 * Throws if the resolved path doesn't exist — better to fail loud than
 * silently scaffold into the wrong directory.
 */

import fs from 'node:fs';
import path from 'node:path';

export function resolveTarget(targetArg) {
  const target = targetArg ? path.resolve(targetArg) : process.cwd();
  if (!fs.existsSync(target)) {
    throw new Error(`Target directory does not exist: ${target}`);
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new Error(`Target is not a directory: ${target}`);
  }
  return target;
}
