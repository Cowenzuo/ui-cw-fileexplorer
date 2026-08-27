/**
 * Standalone build for the ui-cw-fileexplorer plugin (external bundle living
 * outside the dsh monorepo). Mirrors the semantics of the in-repo
 * `clientBundle` preset (packages/client/tsdown.client.ts):
 *
 * - node half: src/index.ts → lib/index.js (esm, externalizes peer deps);
 * - browser half: src/client/index.ts → lib/client.js (cjs closure factory
 *   handed to window.__ModuleLoader__.load, externals resolved through the
 *   loader module table — the shell-seeded baseline below);
 * - CSS Modules: `x.module.css` compiles through lightningcss into a hashed
 *   class map and injects a plugin-owned style tag at factory execution
 *   (same virtual-id approach as the in-repo preset).
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/**
 * Shell-seeded module-table entries a browser bundle must never inline
 * (packages/client/web/src/platform.ts: PLATFORM_MODULES +
 * PRELOADED_CLIENT_EXTERNALS). Any non-baseline @deepseek-ai value import
 * would need dsh.client.external; M0 code has none.
 */
const BASELINE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

const ID = '@dsh-plugins/ui-cw-fileexplorer'

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector plus the CSS Modules class map. */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** CSS Modules compilation: hashed class map + minified text + style injector. */
function cssModulesPlugin(id: string) {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        // Content hash, NOT the path hash: path-hashed names are stable
        // across versions, so a stale HMR-injected stylesheet and the fresh
        // one would share class names and the stale rules win by cascade
        // order (the collapsed-rail centering regression was exactly that).
        cssModules: { pattern: '[content-hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  }
}

const nodeConfig: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  // Keep the .js spelling the manifest and exports map name (no .mjs suffix).
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    // Peer dependencies stay imports on the Node side; everything else inlines.
    neverBundle: (specifier: string) => specifier === '@deepseek-ai/cordis',
    alwaysBundle: (specifier: string) => specifier !== '@deepseek-ai/cordis',
  },
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => (BASELINE_EXTERNALS as readonly string[]).includes(specifier),
    alwaysBundle: (specifier: string) => !(BASELINE_EXTERNALS as readonly string[]).includes(specifier),
  },
  // Same substitutions as the in-repo preset: bundled code may read these
  // (zustand/immer read process.env.NODE_ENV; zustand also probes
  // import.meta.env.MODE, which a CJS output cannot carry otherwise).
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssModulesPlugin(ID)],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeConfig, clientConfig]
