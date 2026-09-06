import { resolve } from 'node:path';

import { defineConfig, type LibConfig, type RsbuildPlugin } from '@rslib/core';
import { pluginPublint } from 'rsbuild-plugin-publint';
import packageManifest from './package.json' with { type: 'json' };

/**
 * The bundled TypeScript 5 parser (a devDependency, #381) reads the CommonJS
 * `__filename`/`__dirname` globals in its eager `getNodeSystem()`, which the
 * ESM output does not define. Rslib 1.0's ESM shims rewrite each reference,
 * inside the module that makes it, to a path derived from the chunk's own
 * `import.meta.url` (`fileURLToPath` from `node:url`); a module with no such
 * reference is left untouched, so the runtime lib's chunks — the ones the
 * compiler re-bundles into consumer artifacts — gain nothing unless they need
 * it. tests/dist-esm-node-globals.test.ts holds every emitted chunk free of
 * the bare globals; tests/packed-consumer-typescript.test.ts runs the parser
 * from the installed tarball.
 */
const esmNodeGlobalsShims: LibConfig['shims'] = { esm: { __dirname: true, __filename: true } };

/**
 * Rslib's per-source declaration mode preserves `src/app/index.ts` as
 * `dist/app/index.d.ts`. The public browser entry is intentionally the flat
 * `dist/app.js`, so emit the matching declaration entry as a redirect while
 * retaining the shared per-module declarations and strict import graph.
 */
const appDeclarationEntrypointPlugin: RsbuildPlugin = {
  name: 'agent-bundle:app-declaration-entrypoint',
  setup(api) {
    api.processAssets({ stage: 'additions' }, ({ compilation, sources }) => {
      compilation.emitAsset('app.d.ts', new sources.RawSource("export * from './app/index.js';\n"));
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

/**
 * The `id` of the public lib entry. To Rslib an id is a name: it labels the
 * Rsbuild environment the entry becomes (`esm` when unset —
 * `composeRsbuildEnvironments` in @rslib/core), so it shows in build logs,
 * selects the entry for `rslib build --lib`, and keys the persistent build
 * cache's version (`<environment>-<mode>`, Rsbuild's cache plugin); it
 * changes no emitted file. It exists so `rstest.rslib.ts` can pass it as the
 * adapter's `libId`: without one, `@rstest/adapter-rslib` reads none of this
 * entry's fields into the pools' test build.
 */
export const agentBundleLibId = 'esm-node';
export const agentBundleRuntimeLibId = 'runtime-node';

const publicEntries = {
  api: './src/api.ts',
  cli: './src/cli.ts',
  config: './src/config/index.ts',
  'contracts/host-sessions': './src/contracts/host-sessions.ts',
  eval: './src/eval/index.ts',
  index: './src/index.ts',
  'lifecycle-render-child': './src/dev/playground/lifecycle-render-child.ts',
  'mcp-apps': './src/mcp-apps.ts',
  'route-invocation-child': './src/dev/routes/route-invocation-child.ts',
  rstest: './src/rstest/index.ts',
  test: './src/test/index.ts',
  'test/browser': './src/test/browser.ts',
};

const runtimeEntries = {
  app: './src/app/index.ts',
  'cli-entry': './src/cli-entry.ts',
  'event-ipc': './src/events/ipc.ts',
  'event-project': './src/events/project.ts',
  'launch-env': './src/launch-env.ts',
  'mcp-entry': './src/mcp-entry.ts',
  'mcp-server-runtime': process.env['AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE'] === '1'
    ? './tests/fixtures/runtime-rebundle/mcp-server-runtime.ts'
    : './src/mcp-server-runtime.ts',
  meta: './src/meta.ts',
  routes: './src/routes/public.ts',
  'terminal-capability': './src/terminal-capability.ts',
  'web-host': './src/web-host.ts',
};

export default defineConfig({
  lib: [
    {
      id: agentBundleLibId,
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
      output: {
        copy: [
          { from: resolve(import.meta.dirname, '../workbench/dist'), to: 'workbench', info: { minimized: true } },
          { from: resolve(import.meta.dirname, 'web-host-dist'), to: 'web-host', info: { minimized: true } },
        ],
      },
      plugins: [appDeclarationEntrypointPlugin],
      shims: esmNodeGlobalsShims,
      source: {
        entry: publicEntries,
      },
      syntax: 'es2022',
    },
    {
      id: agentBundleRuntimeLibId,
      bundle: true,
      dts: false,
      format: 'esm',
      shims: esmNodeGlobalsShims,
      source: {
        entry: runtimeEntries,
      },
      // These entries are inputs to a second Rspack compilation when the
      // compiler generates an artifact. Keeping them outside the public
      // graph's dynamic runtime import gives their transitive private modules
      // a re-bundle-safe placement without promoting siblings to entries.
      syntax: 'es2022',
    },
  ],
  output: {
    cleanDistPath: true,
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
  },
});
