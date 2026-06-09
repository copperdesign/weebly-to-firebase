/**
 * File-content generators for the scaffolded Firebase project.
 *
 * Each export takes a config object and returns the file contents as a string.
 * Layout mirrors the Quartier 42 / Katrin Fillies pattern:
 *   - Firebase Hosting only (no Functions / Firestore yet)
 *   - public/ is the deploy target; src/ is the authoring source
 *   - posthtml + posthtml-include partials in src/html/ (compiled to public/
 *     via `npm run build:html`). Partials use the Sass `_` prefix convention;
 *     the build glob (`src/html/[!_]*.html`) only picks up page entry points.
 *   - LESS or SCSS in src/{less,sass}/, JS in src/js/, design sources in src/gfx/
 *
 * The tool that runs these (~/Work Files/Weebly-to-Firebase/) is not part of
 * the scaffolded project — the project ships clean, no local scripts/ folder.
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
    author: {
      name: 'Christian Fillies',
      email: 'christian@manolab.com',
      url: 'https://christianfillies.com',
    },
    scripts: {
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
 * firebase.json — hosting-only config matching the Q42 shape.
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
export function posthtmlrc() {
  return `// posthtml-cli config — composes src/html/[!_]*.html into public/.
// Partials live alongside pages in src/html/ and are referenced via
//   <include src="_meta.html"></include>
// Sass-convention `_` prefix keeps them out of the build glob.

module.exports = {
  plugins: {
    'posthtml-include': { root: './src/html' },
  },
};
`;
}

/**
 * .gitignore — adapted from Quartier 42. Notable: public/ is NOT ignored,
 * since the posthtml-compiled HTML is checked in (Firebase Hosting deploys from it).
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

Scaffolded by the **Weebly-to-Firebase converter** at
\`~/Work Files/Weebly-to-Firebase/\`.

## Layout

\`\`\`
src/
  html/      Pages + partials (\`_*.html\`) → compiled to public/ via posthtml
  less/      LESS sources → public/assets/css/
  js/        JS sources  → public/assets/js/
  gfx/       Design sources (psd, afdesign, etc. — not in git)
  img/       Raw images → public/assets/img/
public/      Firebase Hosting deploy target (checked in)
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

The converter is idempotent — safe to re-run any time:

\`\`\`bash
node ~/Work\\ Files/Weebly-to-Firebase/converter.mjs      # from project root
node ~/Work\\ Files/Weebly-to-Firebase/crawl-site.mjs     # refresh the live-site mirror
node ~/Work\\ Files/Weebly-to-Firebase/convert-assets.mjs # re-migrate Weebly assets
\`\`\`
`;
}
