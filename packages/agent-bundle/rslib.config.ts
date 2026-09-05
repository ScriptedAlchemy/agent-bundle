import { resolve } from 'node:path';

import { defineConfig, type RsbuildPlugin } from '@rslib/core';
import { pluginPublint } from 'rsbuild-plugin-publint';
import packageManifest from './package.json' with { type: 'json' };

const esmNodeGlobalsShim = [
  '// agent-bundle ESM shims for the bundled TypeScript parser',
  "const __filename = process.getBuiltinModule('node:url').fileURLToPath(import.meta.url);",
  "const __dirname = process.getBuiltinModule('node:path').dirname(__filename);",
  '',
].join('\n');

/**
 * Prepends the `__filename`/`__dirname` shim to every emitted ESM chunk that
 * still references those CommonJS globals (the bundled TypeScript parser's
 * eager `getNodeSystem()`); every other chunk is left untouched. Registered
 * through Rsbuild's `processAssets` hook (the `additions` stage), the way
 * Rsbuild's own `rsbuild:inline-chunk` and `rsbuild:appIcon` plugins hang
 * asset rewrites, so no Rspack plugin class or compiler tap is needed.
 */
const esmNodeGlobalsPlugin: RsbuildPlugin = {
  name: 'agent-bundle:esm-node-globals',
  setup(api) {
    api.processAssets({ stage: 'additions' }, ({ assets, compilation, sources }) => {
      for (const [name, asset] of Object.entries(assets)) {
        if (!name.endsWith('.js') || !/\b__(?:filename|dirname)\b/u.test(asset.source().toString())) continue;
        compilation.updateAsset(name, new sources.ConcatSource(esmNodeGlobalsShim, asset));
      }
    });
  },
};

/**
 * Rslib enables Rspack's persistent build cache by default and keys its
 * directory by this config's root (`node_modules/.cache/rspack`), never by
 * `--dist-path`. Two builds of this config running at once — the packed pool's
 * packed-consumer and dev-workbench-packaging suites each rebuild it into an
 * isolated dist from parallel workers — would then contend for a single cache
 * lock ("Transaction already in progress by process … in directory …"). Test
 * harnesses hand every spawned build its own directory through this variable
 * (rstest.worker-isolation.ts); `pnpm build` keeps the default warm cache.
 */
const buildCacheDirectory = process.env['AGENT_BUNDLE_RSLIB_CACHE_DIRECTORY'];

export default defineConfig({
  lib: [
    {
      bundle: true,
      // One `.d.ts` per source module. Bundling them per entry
      // (`dts: { bundle: true }`, API Extractor) was measured and rejected:
      // it fails inside a devDependency's `.d.cts` (zod), takes ~6x longer,
      // emits ~30% more bytes by inlining shared types into every entry, and
      // renames colliding public names (`AgentBundleConfig_2`). What keeps
      // the shipped declarations honest instead is the release gate
      // (scripts/check-declaration-imports.mjs --strict via `pnpm lint:release`):
      // no packed declaration, reachable or not, may import a devDependency.
      dts: true,
      format: 'esm',
      syntax: 'es2022',
    },
  ],
  output: {
    cleanDistPath: true,
    copy: [
      { from: resolve(import.meta.dirname, '../workbench/dist'), to: 'workbench', info: { minimized: true } },
    ],
    filenameHash: false,
    legalComments: 'linked',
    target: 'node',
  },
  ...(buildCacheDirectory === undefined || buildCacheDirectory.length === 0
    ? {}
    : { performance: { buildCache: { cacheDirectory: buildCacheDirectory } } }),
  plugins: [
    // Suggestions stay informational; errors and warnings block publishing.
    pluginPublint({ throwOn: 'warning' }),
    // The bundled TypeScript 5 parser's eager `getNodeSystem()` reads the
    // CommonJS `__filename`/`__dirname` globals, which the ESM output does
    // not define and which Rspack's `node-module` rewrite (disabled below)
    // leaves untouched inside that module. The chunk that carries them gets
    // a module-scoped shim derived from its own `import.meta.url`
    // (`process.getBuiltinModule` is Node >= 22.3).
    esmNodeGlobalsPlugin,
  ],
  root: import.meta.dirname,
  tools: {
    // The TypeScript 5 parser is bundled (a devDependency, #381) so consumers
    // never receive its `tsc` bin beside their own TypeScript.
    rspack: (config) => {
      // Its `sys.tryEnableSourceMapsForHost` requires `source-map-support`
      // inside a try/catch for the tsc CLI only; the static route-config
      // extractor never reaches it.
      config.ignoreWarnings = [...(config.ignoreWarnings ?? []), /Can't resolve 'source-map-support'/u];
      config.node = { ...(typeof config.node === 'object' ? config.node : {}), __dirname: false, __filename: false };
      // `externalsType` stays Rslib 1.x's ESM default, `modern-module`, on
      // purpose. The only externals this bundle loads through CommonJS
      // `require()` are the Node builtins the bundled TypeScript parser
      // reads (`fs`, `path`, `os`, `crypto`, `inspector`, `perf_hooks`), and
      // Rslib 0.x already emitted those through a `createRequire()` shim
      // chunk; `modern-module` reproduces that chunk byte for byte, while
      // pinning `module-import` would turn them into hoisted
      // `import * as` namespaces — a change, not a preservation. The shim
      // chunk is reachable only from the parser chunk, never from the
      // runtime entries the compiler re-bundles into consumer artifacts, so
      // the artifact bundler never has to see through a `createRequire()`.
    },
  },
  source: {
    tsconfigPath: './tsconfig.build.json',
    define: {
      __AGENT_BUNDLE_VERSION__: JSON.stringify(packageManifest.version),
    },
    entry: {
      api: './src/api.ts',
      cli: './src/cli.ts',
      'cli-entry': './src/cli-entry.ts',
      config: './src/config/index.ts',
      eval: './src/eval/index.ts',
      'event-ipc': './src/events/ipc.ts',
      'event-project': './src/events/project.ts',
      index: './src/index.ts',
      'install-entry': './src/install-entry.ts',
      'launch-env': './src/launch-env.ts',
      'lifecycle-render-child': './src/dev/playground/lifecycle-render-child.ts',
      'mcp-apps': './src/mcp-apps.ts',
      'mcp-entry': './src/mcp-entry.ts',
      meta: './src/meta.ts',
      // Same reason as `mcp-tasks` below: the runtime's only other private
      // sibling. Concatenated into the runtime's chunk it makes that chunk
      // host two modules, so rslib synthesizes the runtime's namespace
      // object (for `agent-bundle/test`'s dynamic import) through its own
      // `__webpack_require__`, and the generated stdio entry fails to start
      // with `__webpack_modules__[moduleId] is not a function`.
      'mcp-schema-projection': './src/mcp-schema-projection.ts',
      'mcp-server-runtime': './src/mcp-server-runtime.ts',
      // Its own entry so it is emitted as a chunk beside the runtime rather
      // than concatenated into it: a generated artifact bundles
      // `dist/mcp-server-runtime.js`, and a chunk that also hosts a sibling
      // module carries rslib's `__webpack_require__` runtime import, whose
      // identifiers shadow the artifact bundler's own runtime.
      'mcp-tasks': './src/mcp-tasks.ts',
      // The route authoring surface: types plus the compile-time helpers a
      // route module may import at run time without pulling the compiler
      // into its generated bundle.
      routes: './src/routes/public.ts',
      rstest: './src/rstest/index.ts',
      // Plain Node (#558): a routed command serves an MCP App by spawning
      // `agent-bundle serve-app` through this entry instead of importing the
      // compiler, so it must bundle into a self-contained executable.
      'serve-app-command': './src/serve-app-command.ts',
      'terminal-capability': './src/terminal-capability.ts',
      test: './src/test/index.ts',
      'test/browser': './src/test/browser.ts',
    },
  },
});
