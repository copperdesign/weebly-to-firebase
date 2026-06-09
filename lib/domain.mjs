/**
 * Domain string normalization shared by crawl/init/port.
 *
 * Users type the domain in many ways: bare host, with scheme, with trailing
 * slash, with www, etc. We strip the scheme + trailing slashes so the canonical
 * form is just `host[/path]` — matches what wget writes its mirror to.
 *
 * Kept tiny and local because we only need string trimming; URL parsing would
 * fail on the bare-host inputs we want to accept (`nele-quaas.com`).
 */

export function normalizeDomain(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}
