import { join, resolve } from 'node:path';

import type { RslibConfig } from '@rslib/core';
import { withRslibConfig } from '@rstest/adapter-rslib';
import { describe, expect, it, type ExtendConfig } from '@rstest/core';

import agentBundleRslibConfig, { agentBundleRuntimeLibId } from '../rslib.config.ts';
import packageManifest from '../package.json' with { type: 'json' };
import { agentBundleRslibAdapterOptions, rstestHygiene, withAgentBundleRslibConfig } from '../../../rstest.rslib.ts';
import { agentBundlePackageRoot } from './helpers/workspace-paths.ts';

/**
 * Every adapter-based pool extends `withAgentBundleRslibConfig()`, which hands
 * `packages/agent-bundle/rslib.config.ts` to `@rstest/adapter-rslib` and trims
 * the result. The adapter reads the lib entry only when told its `id`, and
 * reads the entry silently as `{}` otherwise, so this suite pins both the id
 * wiring and the resolved pool config the pools compile against.
 */
const workspaceRoot = resolve(agentBundlePackageRoot, '../..');

/** Names of the plugin objects in an Rsbuild `plugins` list; nested lists, promises, and falsy entries have none. */
const pluginNames = (plugins: ExtendConfig['plugins']): readonly string[] => (plugins ?? []).flatMap((plugin) => (
  typeof plugin === 'object' && plugin !== null && 'name' in plugin && typeof plugin.name === 'string' ? [plugin.name] : []
));

const publishOnlyPlugins = ['plugin-publint'];

/** The pool config as a pool with no overrides of its own receives it, resolved once. */
let poolConfig: Promise<ExtendConfig> | undefined;
const resolvedPoolConfig = (): Promise<ExtendConfig> => (poolConfig ??= Promise.resolve(withAgentBundleRslibConfig()({})));

describe('rstest.rslib.ts', () => {
  it('selects the public lib while the re-bundled runtime has its own profile', () => {
    expect(agentBundleRslibAdapterOptions.cwd).toBe(agentBundlePackageRoot);
    expect((agentBundleRslibConfig.lib ?? []).map((lib) => lib.id)).toEqual([
      agentBundleRslibAdapterOptions.libId,
      agentBundleRuntimeLibId,
    ]);
    expect(agentBundleRslibConfig.lib?.find((lib) => lib.id === agentBundleRuntimeLibId)).toMatchObject({
      dts: false,
      source: {
        entry: {
          app: './src/app/index.ts',
          'mcp-server-runtime': './src/mcp-server-runtime.ts',
        },
      },
    });
  });

  it('shims the CommonJS path globals through Rslib in both libs, not through a plugin of its own', () => {
    for (const lib of agentBundleRslibConfig.lib ?? []) {
      expect(lib.shims, lib.id).toEqual({ esm: { __dirname: true, __filename: true } });
    }
    expect(pluginNames(agentBundleRslibConfig.plugins)).toEqual(publishOnlyPlugins);
  });

  it('reads the lib entry through libId only — the adapter falls back to an empty entry without a diagnostic', async () => {
    const config = {
      lib: [{ id: 'browser-cjs', format: 'cjs', output: { target: 'web' } }],
      output: { target: 'node' },
      // Set so the adapter does not probe a tsconfig for `experimentalDecorators`.
      source: { decorators: { version: '2022-03' } },
    } satisfies RslibConfig;
    const [unnamed, unmatched, named] = await Promise.all([
      withRslibConfig({ config })({}),
      withRslibConfig({ config, libId: 'no-such-lib' })({}),
      withRslibConfig({ config, libId: 'browser-cjs' })({}),
    ]);
    expect(unnamed).toMatchObject({ output: { module: true }, testEnvironment: 'node' });
    expect(unmatched).toMatchObject({ output: { module: true }, testEnvironment: 'node' });
    expect(named).toMatchObject({ output: { module: false }, testEnvironment: 'happy-dom' });
  });

  it('resolves the package rslib config, rooted at the workspace', async () => {
    const config = await resolvedPoolConfig();
    expect(config.root).toBe(workspaceRoot);
    expect(config.forceRerunTriggers).toEqual([join(agentBundlePackageRoot, 'rslib.config.ts')]);
  });

  it('compiles tests as ESM for node', async () => {
    const config = await resolvedPoolConfig();
    expect(config.testEnvironment).toBe('node');
    expect(config.output?.module).toBe(true);
  });

  it('keeps the compile-time version define as a JSON string literal', async () => {
    const config = await resolvedPoolConfig();
    const version: unknown = config.source?.define?.['__AGENT_BUNDLE_VERSION__'];
    expect(version).toBe(JSON.stringify(packageManifest.version));
    expect(JSON.parse(version as string)).toBe(packageManifest.version);
  });

  it('repoints tsconfigPath at the workspace tsconfig', async () => {
    const config = await resolvedPoolConfig();
    expect(config.source?.tsconfigPath).toBe(join(workspaceRoot, 'tsconfig.json'));
  });

  it('drops the publish-only plugins the package build registers', async () => {
    const config = await resolvedPoolConfig();
    expect(pluginNames(agentBundleRslibConfig.plugins)).toEqual(expect.arrayContaining(publishOnlyPlugins));
    for (const name of publishOnlyPlugins) expect(pluginNames(config.plugins)).not.toContain(name);
  });

  it('drops tools.rspack', async () => {
    const config = await resolvedPoolConfig();
    expect(agentBundleRslibConfig.tools?.rspack).toBeDefined();
    expect(config.tools?.rspack).toBeUndefined();
  });

  it('drops the project name the adapter derives from libId, so pools keep the default', async () => {
    const config = await resolvedPoolConfig();
    expect(config.name).toBeUndefined();
  });

  it('applies rstestHygiene', async () => {
    const config = await resolvedPoolConfig();
    expect(rstestHygiene).toEqual({ clearMocks: true, restoreMocks: true, unstubEnvs: true, unstubGlobals: true });
    expect(config).toMatchObject(rstestHygiene);
  });
});
