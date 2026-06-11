/**
 * File-content generators for the scaffolded Firebase project.
 *
 * Each export takes a config object and returns the file contents as a string.
 * Layout:
 *   - Firebase Hosting only (no Functions / Firestore yet)
 *   - public/ is the deploy target; src/ is the authoring source
 *   - posthtml + posthtml-include partials in src/html/ (compiled to public/
 *     via `npm run build:html`). Partials use the Sass `_` prefix convention;
 *     the build glob (`src/html/[!_]*.html`) only picks up page entry points.
 *   - LESS or SCSS in src/{less,sass}/, JS in src/js/, all graphics in src/gfx/
 *     (deployable + design sources side by side; .gitignore strips PSD/AFD/etc.)
 *
 * The converter tool itself is not part of the scaffolded project — the
 * project ships clean, no local scripts/ folder.
 */

/**
 * package.json — minimal scripts, LESS + Rollup build, Firebase emulator for dev.
 * Heavy build steps (image conversion, PWA assets) can be added later as the
 * project takes shape; not premature here.
 */
export function packageJson(cfg) {
  const pkg = {
    name: cfg.slug,
    version: '0.0.0',
    description: `${cfg.name} website`,
    private: true,
    // No `author` field — left for you to fill in by hand. We intentionally
    // don't auto-populate from git config (the converter's user is rarely the
    // site's owner; bad defaults are worse than none on a private package).
    scripts: {
      // Ensures `wget` is available for the live-site mirror (the converter's
      // `crawl` command shells out to it). No-op if wget already present; uses
      // brew if available; silently succeeds otherwise so non-macOS clones
      // don't fail `npm install`.
      postinstall: "command -v wget >/dev/null 2>&1 || (command -v brew >/dev/null 2>&1 && brew install wget) || true",
      dev: 'firebase emulators:start --only hosting',
      deploy: cfg.hostingSite
        ? `firebase deploy --only hosting:${cfg.hostingSite}`
        : 'firebase deploy --only hosting',
      // Glob excludes `_*.html` so partials don't compile as standalone pages.
      // Plugin config (posthtml-include's include root) lives in .posthtmlrc.js.
      'build:html': "posthtml 'src/html/[!_]*.html' -o public",
      'build:css': 'lessc src/less/main.less public/assets/css/main.css',
      'build:js': 'rollup src/js/app.js -o public/assets/js/app.js -f iife --compact',
      build: 'npm run build:html && npm run build:css && npm run build:js',
    },
    devDependencies: {
      less: '^4.2.0',
      'posthtml-cli': '^0.10.0',
      'posthtml-include': '^1.7.4',
      rollup: '^4.21.0',
      terser: '^5.31.6',
    },
  };
  if (cfg.githubRepo) {
    pkg.repository = { type: 'git', url: `https://github.com/${cfg.githubRepo}.git` };
    pkg.homepage = `https://github.com/${cfg.githubRepo}#readme`;
  }
  return JSON.stringify(pkg, null, 2) + '\n';
}

/**
 * firebase.json — hosting-only config.
 * cleanUrls + trailingSlash:false produces /kontakt instead of /kontakt.html.
 * The ignore list excludes src and reference from deploys.
 */
export function firebaseJson(cfg) {
  const hosting = {
    public: 'public',
    cleanUrls: true,
    trailingSlash: false,
    ignore: [
      'firebase.json',
      '**/.*',
      '**/node_modules/**',
      'src/**',
      'reference/**',
    ],
  };
  if (cfg.hostingSite) hosting.site = cfg.hostingSite;
  return JSON.stringify({ hosting }, null, 2) + '\n';
}

export function firebaseRc(cfg) {
  return JSON.stringify({ projects: { default: cfg.firebaseProject } }, null, 2) + '\n';
}

/**
 * .posthtmlrc.js — posthtml-cli config consumed by `npm run build:html`.
 *
 * Single plugin: posthtml-include, with `src/html/` set as the include root so
 * pages can reference partials by bare name (`<include src="_meta.html">`)
 * regardless of which subdirectory they live in.
 *
 * CommonJS (`module.exports`) is used deliberately — posthtml-cli loads this
 * via require(), and ESM configs require extra ceremony that buys nothing.
 */
/**
 * GitHub Actions workflow for Firebase Hosting deploy on push to main.
 *
 * Hand-edited (vs. the un-edited `firebase init hosting:github` output) to
 * add the build step before deploy — without it, the action ships whatever
 * happened to be committed locally to `public/`, not a fresh build.
 *
 * The service-account secret name is derived from the Firebase project ID
 * (uppercased, dashes → underscores). The user creates the secret by
 * running `firebase init hosting:github` once, or manually pasting a
 * service-account JSON into a repo secret of that name. Either way the
 * name lines up.
 */
export function githubActionsHostingDeploy(cfg) {
  // GitHub repo-secret names are uppercase + underscores. Mirror what
  // `firebase init hosting:github` would generate so the secret created
  // by that workflow lines up with this file's reference.
  const secretName = `FIREBASE_SERVICE_ACCOUNT_${
    cfg.firebaseProject.toUpperCase().replace(/-/g, '_')
  }`;
  return `# Deploy Firebase Hosting on push to main.
#
# Hand-edited to add a build step — public/ is rebuilt from src/ in CI so
# pushes deploy fresh output, not whatever happened to be committed
# locally. The service-account secret is created by running
# \`firebase init hosting:github\` once, or by pasting a service-account
# JSON into a repo secret named ${secretName}.

name: Deploy to Firebase Hosting on merge
on:
  push:
    branches:
      - main
jobs:
  build_and_deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: \${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: \${{ secrets.${secretName} }}
          channelId: live
          projectId: ${cfg.firebaseProject}
`;
}

export function posthtmlrc() {
  return `// posthtml-cli config — composes src/html/[!_]*.html into public/.
// Partials live alongside pages in src/html/ and are referenced via
//   <include src="_meta.html"></include>
// Sass-convention underscore prefix keeps them out of the build glob.

module.exports = {
  plugins: {
    'posthtml-include': { root: './src/html' },
  },
};
`;
}

/**
 * .gitignore. Notable: public/ is NOT ignored, since the posthtml-compiled
 * HTML is checked in (Firebase Hosting deploys from it).
 * The reference/ mirror is ignored (it's bulky, regeneratable).
 */
export function gitignore() {
  return `# Logs
*.log
firebase-debug.log*
firebase-debug.*.log*

# Firebase cache
.firebase/

# Node
node_modules/
.npm
*.tgz

# Env
.env
.env.local

# macOS / IDE
.DS_Store
.idea/
.vscode/

# Design sources (kept locally, not in git)
*.psd
*.afphoto
*.afdesign
*.eps
*.ai
*.sketch

# SASS / LESS caches
.sass-cache/
*.css.map

# Reference mirror of the live Weebly site (large, regenerate via the converter)
reference/

# Converter state cache
.weebly-migrate.json
`;
}

export function gitattributes() {
  return `* text=auto eol=lf
*.html text
*.css text
*.less text
*.scss text
*.js text
*.json text
*.md text
*.png binary
*.jpg binary
*.jpeg binary
*.webp binary
*.avif binary
*.ico binary
*.woff binary
*.woff2 binary
`;
}

/**
 * Top-level README — explains the project layout, build, deploy.
 * The Weebly-migration story is called out so future-me knows why
 * reference/ exists and where the converter tool lives.
 */
export function readme(cfg) {
  return `# ${cfg.name}

${cfg.description || `Website for ${cfg.name}.`}

Originally a Weebly site (Unite theme); being migrated incrementally to
Firebase Hosting. The original theme export lives in \`reference/WeeblyExport/\`
and the live-site mirror (if crawled) in \`reference/${cfg.liveDomain || '<domain>'}/\`.

Scaffolded by the [Weebly-to-Firebase converter](https://github.com/copperdesign/weebly-to-firebase).

## Layout

\`\`\`
src/
  html/      Pages + partials (\`_*.html\`) → compiled to public/ via posthtml
  less/      LESS sources → public/assets/css/
  js/        JS sources  → public/assets/js/
  gfx/       Graphics — deployable images committed; design sources
             (\`*.psd\`, \`*.afdesign\`, …) live alongside but are gitignored
public/      Firebase Hosting deploy target (checked in)
  assets/
    css/     compiled LESS
    js/      bundled JS
    fonts/   harvested by \`w2f port\` from linked stylesheets
    gfx/     images pulled from the live mirror by \`w2f port\`
reference/   Original Weebly theme + crawled live-site mirror (not in git)
\`\`\`

Pages compose partials via posthtml-include — Sass-style underscore prefix:

\`\`\`html
<head>
  <include src="_meta.html"></include>
</head>
<body>
  <include src="_nav.html"></include>
  …
  <include src="_footer.html"></include>
</body>
\`\`\`

Plugin config: \`.posthtmlrc.js\` at the project root.

## Setup

\`\`\`bash
npm install
firebase login          # one-time
firebase use ${cfg.firebaseProject || '<project-id>'}
\`\`\`

## Develop

\`\`\`bash
npm run dev             # firebase emulators (hosting)
npm run build           # html (posthtml) + less + js → public/
\`\`\`

The HTML build is \`posthtml\` + \`posthtml-include\` driven by the CLI script
(\`npm run build:html\`). Compiled HTML is committed to \`public/\` so Firebase
deploy doesn't need a build step in CI.

## Deploy

\`\`\`bash
npm run deploy
\`\`\`

## Re-running the converter

The \`w2f\` CLI is idempotent — safe to re-run any time:

\`\`\`bash
w2f               # re-scaffold (skips existing files)
w2f crawl         # refresh the live-site mirror
w2f port          # re-extract content into src/html/
w2f convert       # re-migrate WeeblyExport assets
\`\`\`

\`w2f\` is short for \`weebly-to-firebase\`. See
[copperdesign/weebly-to-firebase](https://github.com/copperdesign/weebly-to-firebase)
or run \`w2f --help\` for the full reference.
`;
}
