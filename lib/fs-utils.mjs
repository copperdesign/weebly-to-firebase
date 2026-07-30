/**
 * Tiny filesystem helpers shared across commands/*.mjs. `exists()` was
 * copied verbatim into init.mjs, port.mjs, and convert.mjs — the pattern
 * asserted itself three times, so the fourth caller (cms) is the extraction
 * point per philosophy.md.
 */

import fs from 'node:fs/promises';

/** True if `p` is reachable (file or directory); false on any access error. */
export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
