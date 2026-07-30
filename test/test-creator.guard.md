# Test-writer guard note

**Feature:** `w2f cms` (Sveltia CMS layer + content lift)
**Date:** 2026-07-30
**Stage:** 2.5 — test-first, written before any implementation exists

## Scope

Files written, all new:

- `test/fixtures/ported-site/**` — mini ported-project fixture (package.json,
  firebase.json, `src/html/{index,about,contact,plain,_nav}.html`,
  `public/assets/gfx/pixel.png`)
- `test/helpers/normalize.mjs` — real, fully-implemented `normalizeHtml()`
  used by the round-trip diff (test infra, not a stub)
- `test/normalize.test.mjs` — self-tests for the helper above
- `test/extract.test.mjs` — unit tests for `lib/extract.mjs`
- `test/html-markdown.test.mjs` — unit tests for `lib/html-markdown.mjs`
- `test/cms.test.mjs` — command-level tests for `commands/cms.mjs`
- `test/cms-roundtrip.test.mjs` — e2e round-trip + draft-flip test
- `test/test-creator.guard.md` — this file

No shared/parent components modified. `commands/port.mjs`'s Step 1 refactor
(moving `extractTag`/`extractByIdOrClass`/`extractElement`/`tryEach`/
`isSkeleton` into `lib/extract.mjs`) is implementation-stage work — not
touched here. No file under `commands/`, `lib/`, `cli.mjs`, `README.md`,
`.claude/CLAUDE.md`, or `.github/workflows/ci.yml` was read for anything
beyond reference (and none was written to).

## Verification

```
W2F_SKIP_E2E=1 node --test test/
```

All failures are either `ERR_MODULE_NOT_FOUND` for `lib/extract.mjs`,
`lib/html-markdown.mjs`, `lib/cms-templates.mjs` (imported by
`commands/cms.mjs`, transitively), or `commands/cms.mjs` itself — or
assertions inside try/reject helpers that depend on those modules existing.
`test/normalize.test.mjs` and the `normalizeHtml` self-tests inside
`test/extract.test.mjs`'s sibling file are green today, independent of any
unbuilt source module.
