import { resolve } from 'node:path';

import { withRslibConfig } from '@rstest/adapter-rslib';
import type { ExtendConfig, ExtendConfigFn } from '@rstest/core';

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
 * The shared pool configuration: the package's Rslib build config, reduced to
 * what compiling tests needs, plus `rstestHygiene`.
 *
 * Kept from the package build: `source.define` — `__AGENT_BUNDLE_VERSION__`
 * in src/cli.ts is a compile-time identifier and resolves here exactly as in
 * the published build — and `source.tsconfigPath`, repointed at the workspace
 * tsconfig so test files resolve beside the sources. Dropped: the publish-only
 * plugins above and `tools.rspack`, whose `ignoreWarnings` entry and
 * `node.__dirname = false` exist for the inlined TypeScript parser (external
 * in pools; Rstest sets its own `node` options).
 */
export const withAgentBundleRslibConfig = (): ExtendConfigFn => {
  const rslib = withRslibConfig({
    cwd: packageRoot,
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
  });
  return async (userConfig) => ({ ...(await rslib(userConfig)), ...rstestHygiene });
};
