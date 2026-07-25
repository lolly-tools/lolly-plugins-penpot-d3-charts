import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Sibling checkout of github.com/lolly-tools/lolly. The plugin bundles the Lolly
// engine (tool loader + runtime + template hydration) straight from that working
// tree — there is no published package for it yet. CI sets LOLLY_DIR; locally it
// defaults to the sibling directory.
const LOLLY = process.env.LOLLY_DIR ? resolve(process.env.LOLLY_DIR) : resolve(HERE, '../lolly');

/**
 * The one tool this plugin exposes, loaded verbatim from the lolly tree.
 *
 * `community/` — the lolly-tools/lolly-tools submodule — not `tools/`. A lolly
 * checkout also has `tools/d3`, byte-identical and far easier to find, but it is
 * a generated profile mount: `/tools` is in lolly's .gitignore, built locally by
 * scripts/use-profile.ts from the mounted packs. It does not exist in a fresh
 * clone, so a build pointed there works on a developer's machine and fails in
 * CI. `community/` is the tracked source of truth, and the same directory the
 * filters plugin reads.
 */
export const TOOL_ID = 'd3';
const TOOL_DIR = resolve(LOLLY, 'community', TOOL_ID);

/**
 * Files the engine's loader may ask for, plus d3 itself.
 *
 * `lib/d3.min.js` is not a loader file — the template fetches it at paint time.
 * It is copied anyway because index.html preloads it (see there for why the
 * template's own absolute-path fetch never fires).
 */
const TOOL_FILES = ['tool.json', 'template.html', 'hooks.js', 'styles.css', 'lib/d3.min.js'];

/**
 * The tool is DATA, not code we compile: the engine fetches `d3/tool.json`,
 * `template.html` and `hooks.js` as text at mount time. So they're copied into
 * dist/tools/ verbatim on build, and served from memory in dev — never touched
 * by the bundler. Keeping them unmodified is the whole point: a chart behaves
 * identically here and on lolly.tools.
 */
function lollyTools(): Plugin {
  return {
    name: 'lolly-tools',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/tools\/([a-z0-9-]+)\/([a-z0-9./-]+)$/i.exec((req.url ?? '').split('?')[0]);
        if (!m || m[1] !== TOOL_ID || m[2].includes('..')) return next();
        const file = join(TOOL_DIR, m[2]);
        if (!existsSync(file)) {
          res.statusCode = 404;
          return res.end('not found');
        }
        const type = m[2].endsWith('.json')
          ? 'application/json'
          : m[2].endsWith('.js')
            ? 'text/javascript'
            : 'text/plain';
        res.setHeader('content-type', type);
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      if (!existsSync(TOOL_DIR)) {
        this.error(`Tool "${TOOL_ID}" not found at ${TOOL_DIR} — set LOLLY_DIR to a lolly checkout.`);
      }
      for (const f of TOOL_FILES) {
        const from = join(TOOL_DIR, f);
        if (!existsSync(from)) continue; // styles.css is optional; d3 ships none
        this.emitFile({
          type: 'asset',
          fileName: `tools/${TOOL_ID}/${f}`,
          source: readFileSync(from),
        });
      }
    },
  };
}

export default defineConfig({
  // Relative asset URLs so the same dist/ works at a domain root AND under a
  // GitHub Pages project subpath (/repo-name/).
  base: './',
  /**
   * No SPA history fallback — this is one page, not a router.
   *
   * It matters because of how the engine's loader probes for a tool's OPTIONAL
   * files (styles.css, template.md): it fetches them and treats a non-OK
   * response as "the tool doesn't ship one". Under the SPA fallback those
   * requests came back 200 with index.html, so in dev and preview the loader
   * was handed a page of HTML as the tool's stylesheet — while GitHub Pages,
   * which has no fallback, correctly 404s and hands it null. Harmless in
   * practice (the panel never applies tool styles), but it meant local testing
   * and production disagreed about what the tool actually is.
   */
  appType: 'mpa',
  plugins: [lollyTools()],
  resolve: {
    alias: {
      '@lolly-tools/core/host-v1': resolve(LOLLY, 'packages/core/src/host-v1.ts'),
      '@lolly-tools/core': resolve(LOLLY, 'packages/core/src/index.ts'),
      '@engine': resolve(LOLLY, 'engine/src'),
      // The engine's own runtime deps. It lives inside the lolly tree, so its bare
      // imports would resolve against lolly's node_modules — which CI doesn't
      // install. Pin both to THIS repo's node_modules instead.
      'ajv/dist/2020.js': resolve(HERE, 'node_modules/ajv/dist/2020.js'),
      handlebars: resolve(HERE, 'node_modules/handlebars/dist/cjs/handlebars.js'),
    },
  },
  server: {
    cors: true,
    fs: { allow: [HERE, LOLLY] },
  },
  preview: {
    cors: true,
  },
  build: {
    target: 'es2022',
  },
});
