import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { compileTestManifest } from '../test/manifest.ts';
import { writeRouteTestSetup } from './setup-module.ts';

export { agentBundleBrowserRstest } from './browser.ts';
export type {
  AgentBundleBrowserRstestConfig,
  AgentBundleBrowserRstestOptions,
} from './browser.ts';

/**
 * The Node condition the React Server Components renderer requires. React
 * refuses to render Flight without it, and it is a process flag, so the
 * route-unit pool owns it — this is why the harness ships an Rstest
 * configuration rather than only a bundler plugin.
 */
const reactServerConditions: readonly string[] = Object.freeze(['--conditions', 'react-server']);

/**
 * The same condition for the bundler's own `exports` resolution, beside the
 * Node conditions Rstest resolves with. Condition order carries no meaning —
 * a package's own `exports` order decides the match — but the Node conditions
 * must stay listed, because this replaces the resolver's set rather than
 * extending it.
 */
const reactServerConditionNames: readonly string[] = Object.freeze([
  'react-server',
  'node',
  'module',
  'import',
  'require',
  'default',
]);

/**
 * Where route-unit tests live by default. The level keeps its own directory
 * because it keeps its own pool: a consumer's ordinary `rstest` run must not
 * pick these files up, and the directory name states which proof they carry.
 */
const routeUnitInclude = 'tests/route-unit/**/*.test.{ts,tsx}';

export interface AgentBundleRstestOptions {
  /** Explicit Agent Bundle configuration path; discovered from `root` when omitted. */
  readonly configPath?: string;
  /** Test files for the route-unit level; defaults to `tests/route-unit/**`. */
  readonly include?: readonly string[];
  /** Project root; defaults to the working directory Rstest was started in. */
  readonly root?: string;
  /** Extra setup files, appended after the generated route registry. */
  readonly setupFiles?: readonly string[];
}

/**
 * The Rstest configuration for the route-unit proof level. Mutable array and
 * literal member types keep the result directly assignable to Rstest's own
 * config type without this package depending on `@rstest/core`.
 */
export interface AgentBundleRstestConfig {
  include: string[];
  pool: { execArgv: string[]; type: 'forks' };
  setupFiles: string[];
  source?: { tsconfigPath: string };
  testEnvironment: 'node';
  tools: {
    rspack: { resolve: { conditionNames: string[] } };
    swc: { jsc: { transform: { react: { runtime: 'automatic' } } } };
  };
}

/**
 * Builds the Rstest configuration for a consumer project's route-unit tests.
 *
 * One compiler pass runs here — the same preparation the build and `inspect`
 * use, which owns route-graph compilation — and its manifest configures the
 * pool, the test environment, the TypeScript transform, and the generated
 * route registry the helpers in `agent-bundle/test` read. No artifact is built.
 *
 * ```ts
 * import { defineConfig } from '@rstest/core';
 * import { agentBundleRstest } from 'agent-bundle/rstest';
 *
 * export default defineConfig(await agentBundleRstest());
 * ```
 *
 * This configuration carries the route-unit level only. Transport, browser,
 * and packed-artifact proof levels arrive as their own configurations.
 */
export const agentBundleRstest = async (
  options: AgentBundleRstestOptions = {},
): Promise<AgentBundleRstestConfig> => {
  const root = resolve(options.root ?? process.cwd());
  const manifest = await compileTestManifest({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    root,
  });
  const setup = await writeRouteTestSetup(root, manifest);
  const tsconfigPath = resolve(root, 'tsconfig.json');
  return {
    include: [...(options.include ?? [routeUnitInclude])],
    pool: { execArgv: [...reactServerConditions], type: 'forks' },
    setupFiles: [setup, ...(options.setupFiles ?? [])],
    ...(existsSync(tsconfigPath) ? { source: { tsconfigPath } } : {}),
    testEnvironment: 'node',
    tools: {
      // Every bundler-side resolution must pick React's server build, the same
      // one the `react-server` process condition selects. Without it the JSX
      // runtime and the Flight renderer bind different React internals.
      rspack: { resolve: { conditionNames: [...reactServerConditionNames] } },
      // Route modules are authored as JSX against React 19's automatic runtime.
      // Rstest's default TSX transform is the classic runtime, which would fail
      // every route render with `React is not defined`.
      swc: { jsc: { transform: { react: { runtime: 'automatic' } } } },
    },
  };
};

export type {
  AgentBundleTestManifest,
  TestableRouteDescriptor,
  TestableStateDescriptor,
} from '../test/manifest.ts';
