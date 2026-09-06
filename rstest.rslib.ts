import { resolve } from 'node:path';

import { withRslibConfig, type WithRslibConfigOptions } from '@rstest/adapter-rslib';
import type { ExtendConfig, ExtendConfigFn } from '@rstest/core';

import { agentBundleLibId } from './packages/agent-bundle/rslib.config.ts';

const workspaceRoot = import.meta.dirname;
const packageRoot = resolve(workspaceRoot, 'packages/agent-bundle');

/**
 * Plugins `packages/agent-bundle/rslib.config.ts` registers for publishing
 * the package, not for compiling its modules. The adapter copies the lib
 * config's `plugins` into every pool verbatim, so without this filter both
 * would run inside each test bundle:
 *
 * - `plugin-publint` (rsbuild-plugin-publint, `throwOn: 'warning'`) audits
 *   the manifest at `api.context.rootPath` in `onAfterBuild` — under the
 *   pools that would be the workspace root's private `package.json`, and a
 *   test build has no manifest to gate. Rstest 0.11 never drives
 *   `onAfterBuild` (DEBUG=rstest shows no publint output), so today the
 *   registration is inert; it stays out so a runner change cannot arm it.
 * - `agent-bundle:esm-node-globals` prepends the `__filename`/`__dirname`
 *   shim to emitted chunks that inline the TypeScript 5 parser. Its
 *   `processAssets` scan did run over every test chunk. Pools leave
 *   dependencies external, and Rstest supplies the real `__dirname` and
 *   `__filename` of each test module itself.
 *
 * Verify the names against the plugin objects, not the package names:
 * `pluginPublint().name` is `plugin-publint`.
 */
const publishOnlyPlugins: ReadonlySet<string> = new Set(['plugin-publint', 'agent-bundle:esm-node-globals']);

/** The `name` of an Rsbuild plugin entry; nested arrays, promises, and falsy entries have none. */
const pluginName = (plugin: unknown): string | undefined => (
  typeof plugin === 'object' && plugin !== null && 'name' in plugin && typeof plugin.name === 'string'
    ? plugin.name
    : undefined
);

/**
 * Per-test restoration shared by every pool. The unit pool runs with
 * `isolate: false`, so a mock, `rs.stubEnv`, or `rs.stubGlobal` a test leaves
 * behind is the next file's problem; restoring before each test makes file
 * order irrelevant. Rstest dispatches `restoreMocks` ahead of `clearMocks`
 * (its `mockRestore` is `mockReset` plus the original implementation, so
 * calls are cleared too); `clearMocks` stays listed as the floor should
 * `restoreMocks` ever be relaxed.
 */
export const rstestHygiene = {
  clearMocks: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
} as const satisfies ExtendConfig;

/**
 * What `packages/agent-bundle/rslib.config.ts` becomes under the adapter —
 * `withRslibConfig` in @rstest/adapter-rslib 0.11.12 (dist/index.js),
 * verified against its source, since the adapter documents none of it.
 *
 * The lib entry is found by `libId` (line 53: `lib.find((l) => l.id ===
 * libId) || {}`); without a `libId`, or with one no entry carries, the entry
 * is silently `{}` and only the top-level fields count. That is why the entry
 * has an `id` and these options pass it: a field moved into the selected
 * public entry — `output.target`, `source.define` — would otherwise vanish
 * from every pool without a diagnostic. Of the entry, only `source`,
 * `output`, `tools`, `plugins`, and `resolve` are merged over the top-level
 * config (lines 54-61); `format` is read once more, directly, as the fallback
 * for `output.module` (line 105).
 *
 * Mapped into the pool config (lines 69-120), after `modifyLibConfig`:
 *
 * | Rslib config                                 | Rstest config                          |
 * | -------------------------------------------- | -------------------------------------- |
 * | `root`                                       | `root`                                 |
 * | `plugins`                                    | `plugins`, verbatim, plus the          |
 * |                                              | adapter's own entry that removes       |
 * |                                              | `rsbuild:dts` and `rsbuild:type-check` |
 * | `source.define`, `source.tsconfigPath`       | the same keys (also `assetsInclude`,   |
 * |                                              | `decorators`, `include`, `exclude`,    |
 * |                                              | `transformImport`)                     |
 * | `resolve`                                    | `resolve`, verbatim                    |
 * | `output.module`, else lib `format !== 'cjs'` | `output.module` (`true` is ESM)        |
 * | `output.target`                              | `testEnvironment`: `web` becomes       |
 * |                                              | `happy-dom`, anything else `node`      |
 * |                                              | (line 119)                             |
 * | `output.cssModules`                          | `output.cssModules`                    |
 * | `performance.buildCache`                     | `performance.buildCache`, its          |
 * |                                              | `buildDependencies` resolved against   |
 * |                                              | the config file, which is appended     |
 * | `tools.rspack`, `tools.swc`,                 | the same keys                          |
 * | `tools.bundlerChain`                         |                                        |
 * | the config file's path                       | `forceRerunTriggers`                   |
 * | the `libId` option                           | `name` (line 75; dropped below)        |
 *
 * Never read: every other lib-entry field — `bundle`, `dts`, `syntax`, and
 * would-be `autoExternal`, `autoExtension`, `redirect`, `shims`, `banner`,
 * `footer`, `umdName`, `outBase`, `experiments` — and, top-level,
 * `source.entry`, `output.{cleanDistPath,copy,filenameHash,legalComments}`
 * (likewise `output.externals`, `distPath`, `minify`, `sourceMap`), any
 * `tools.*` beyond the three above, any `performance.*` beyond `buildCache`,
 * `mode`, `logLevel`, `dev`, `server`. Pools therefore leave every dependency
 * external — Rstest's default for `testEnvironment: 'node'` — where the
 * package build's `autoExternal` bundles devDependencies (the TypeScript
 * parser, #381). One probe escapes `modifyLibConfig`: when the pool sets
 * neither `source.tsconfigPath` nor `source.decorators.version` and the lib
 * sets no `source.decorators.version`, the adapter reads the tsconfig the lib
 * names (`tsconfig.build.json`, before the repointing below) for
 * `experimentalDecorators` (lines 62-67); it feeds nothing else.
 *
 * `modifyLibConfig` keeps `source.define` — `__AGENT_BUNDLE_VERSION__` in
 * src/cli.ts is a compile-time identifier and resolves here exactly as in the
 * published build — and `source.tsconfigPath`, repointed at the workspace
 * tsconfig so test files resolve beside the sources. It drops the
 * publish-only plugins above and `tools.rspack`, whose `ignoreWarnings` entry
 * and `node.__dirname = false` exist for the inlined TypeScript parser
 * (external in pools; Rstest sets its own `node` options).
 *
 * Exported so rstest-rslib-adapter.test.ts can hold `libId` against the
 * config's lib entries: the resolved config cannot show whether the lookup
 * matched, because a miss yields `{}` and this config's entry adds nothing
 * the top level lacks.
 */
export const agentBundleRslibAdapterOptions = {
  cwd: packageRoot,
  libId: agentBundleLibId,
  modifyLibConfig: ({ plugins, tools, ...config }) => {
    const { rspack: _publishOnlyRspack, ...testTools } = tools ?? {};
    return {
      ...config,
      root: workspaceRoot,
      plugins: plugins?.filter((plugin) => {
        const name = pluginName(plugin);
        return name === undefined || !publishOnlyPlugins.has(name);
      }),
      source: {
        ...config.source,
        tsconfigPath: resolve(workspaceRoot, 'tsconfig.json'),
      },
      tools: testTools,
    };
  },
} satisfies WithRslibConfigOptions;

/**
 * The shared pool configuration: the package's Rslib build config, reduced to
 * what compiling tests needs (`agentBundleRslibAdapterOptions`), plus
 * `rstestHygiene`, minus the `name` the adapter derives from `libId` — a
 * project name labels GitHub step summaries and answers `--project`, and
 * `esm-node` describes the build, not a pool, so the pools keep Rstest's
 * default (`rstest`).
 */
export const withAgentBundleRslibConfig = (): ExtendConfigFn => {
  const rslib = withRslibConfig(agentBundleRslibAdapterOptions);
  return async (userConfig) => {
    const { name: _libId, ...config } = await rslib(userConfig);
    return { ...config, ...rstestHygiene };
  };
};
