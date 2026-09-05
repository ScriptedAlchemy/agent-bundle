import { describe, expect, it } from '@rstest/core';

import { frameworkOwnedRsbuildPlugins } from '../src/build/framework-plugins.ts';
import { composeMcpAppsRsbuildConfig } from '../src/build/mcp-apps.ts';
import { composeEntryLibConfig, type RslibEntry } from '../src/build/rslib.ts';
import type { AgentBundleMeta } from '../src/meta.ts';

const meta: AgentBundleMeta = Object.freeze({
  name: 'registration-fixture',
  packageName: undefined,
  packageVersion: undefined,
  version: '1.0.0',
});

const entry: RslibEntry = Object.freeze({
  name: 'tool',
  outputRelativePath: 'scripts/tool.mjs',
  source: '/project/src/tool.ts',
  sourceInputs: ['/project/src/tool.ts'],
});

const reactView = Object.freeze({ name: 'dashboard', source: '/project/src/apps/dashboard.tsx', template: undefined });
const plainView = Object.freeze({ name: 'status', source: '/project/src/apps/status.ts', template: undefined });

const byName = (left: string, right: string): number => left.localeCompare(right);

const registeredPluginNames = (plugins: unknown): readonly string[] => (Array.isArray(plugins) ? plugins : [])
  .flatMap((plugin: unknown) => (
    typeof plugin === 'object' && plugin !== null && typeof (plugin as { readonly name?: unknown }).name === 'string'
      ? [(plugin as { readonly name: string }).name]
      : []
  ))
  .sort(byName);

/**
 * `frameworkOwnedRsbuildPlugins` is the set the AB4724 collision diagnostic
 * and the `tools.rsbuild` reference page describe as registered by the
 * framework. This suite derives that set from the configs the framework
 * actually synthesizes, so a plugin added to (or dropped from) a profile
 * without updating the registry fails here rather than in a consumer's
 * build.
 */
describe('framework-owned Rsbuild plugin registry', () => {
  const owned = [...frameworkOwnedRsbuildPlugins.keys()].sort(byName);

  it('matches exactly the plugins every synthesized entry lib registers', () => {
    const lib = composeEntryLibConfig(entry, { cwd: '/project', meta, outputRoot: '/staged/portable' });
    expect(registeredPluginNames(lib.plugins)).toEqual(owned);
  });

  it('matches exactly the plugins every MCP App view registers, whatever its entry extension', () => {
    const apps = composeMcpAppsRsbuildConfig([reactView, plainView], { cwd: '/project', meta, outDir: '/staged/portable' });
    // A `.ts` entry importing a `.tsx` component needs the React plugin as
    // much as a `.tsx` entry does, so the registration is not keyed on the
    // entry extension.
    expect(registeredPluginNames(apps.environments?.[reactView.name]?.plugins)).toEqual(owned);
    expect(registeredPluginNames(apps.environments?.[plainView.name]?.plugins)).toEqual(owned);
    // The framework registers plugins per environment, never at the root the
    // consumer's `tools.rsbuild.plugins` merges into.
    expect(apps.plugins).toBeUndefined();
  });

  it('registers no framework-owned plugin twice on either path', () => {
    const lib = composeEntryLibConfig(entry, { cwd: '/project', meta, outputRoot: '/staged/portable' });
    const apps = composeMcpAppsRsbuildConfig([reactView], { cwd: '/project', meta, outDir: '/staged/portable' });
    for (const names of [registeredPluginNames(lib.plugins), registeredPluginNames(apps.environments?.[reactView.name]?.plugins)]) {
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
