import { resolve } from 'node:path';

import { defineConfig, type Rspack, type rspack as RspackInstance } from '@rslib/core';
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
 * eager `getNodeSystem()`); every other chunk is left untouched.
 */
const esmNodeGlobalsPlugin = (rspack: typeof RspackInstance): Rspack.RspackPluginInstance => ({
  apply(compiler: Rspack.Compiler) {
    compiler.hooks.thisCompilation.tap('agent-bundle:esm-node-globals', (compilation: Rspack.Compilation) => {
      compilation.hooks.processAssets.tap({
        name: 'agent-bundle:esm-node-globals',
        stage: rspack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
      }, (assets: Rspack.Assets) => {
        for (const [name, asset] of Object.entries(assets)) {
          if (!name.endsWith('.js') || !/\b__(?:filename|dirname)\b/u.test(asset.source().toString())) continue;
          compilation.updateAsset(name, new rspack.sources.ConcatSource(esmNodeGlobalsShim, asset));
        }
      });
    });
  },
});

export default defineConfig({
  lib: [
    {
      bundle: true,
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
  // Suggestions stay informational; errors and warnings block publishing.
  plugins: [pluginPublint({ throwOn: 'warning' })],
  root: import.meta.dirname,
  tools: {
    // The TypeScript 5 parser is bundled (a devDependency, #381) so consumers
    // never receive its `tsc` bin beside their own TypeScript.
    rspack: (config, { rspack }) => {
      // Its `sys.tryEnableSourceMapsForHost` requires `source-map-support`
      // inside a try/catch for the tsc CLI only; the static route-config
      // extractor never reaches it.
      config.ignoreWarnings = [...(config.ignoreWarnings ?? []), /Can't resolve 'source-map-support'/u];
      // Its eager `getNodeSystem()` reads the CommonJS `__filename`/`__dirname`
      // globals, which the ESM output does not define and which Rspack's
      // `node-module` rewrite leaves untouched inside that module. The chunk
      // that carries them gets a module-scoped shim derived from its own
      // `import.meta.url` (`process.getBuiltinModule` is Node >= 22.3).
      config.node = { ...(typeof config.node === 'object' ? config.node : {}), __dirname: false, __filename: false };
      config.plugins = [...(config.plugins ?? []), esmNodeGlobalsPlugin(rspack)];
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
      'lifecycle-render-child': './src/dev/playground/lifecycle-render-child.ts',
      'mcp-apps': './src/mcp-apps.ts',
      'mcp-entry': './src/mcp-entry.ts',
      meta: './src/meta.ts',
      'mcp-server-runtime': './src/mcp-server-runtime.ts',
      // The route authoring surface: types plus the compile-time helpers a
      // route module may import at run time without pulling the compiler
      // into its generated bundle.
      routes: './src/routes/public.ts',
      rstest: './src/rstest/index.ts',
      test: './src/test/index.ts',
      'test/browser': './src/test/browser.ts',
    },
  },
});
