import { describe, expect, it } from '@rstest/core';

import { composeToolsLayers, frameworkInvariantLayer } from '../src/build/compose-layers.ts';
import { composeMcpAppsRsbuildConfig } from '../src/build/mcp-apps.ts';
import { composeEntryLibConfig, type RslibEntry } from '../src/build/rslib.ts';
import type { AgentBundleToolsConfig } from '../src/core/types.ts';
import type { AgentBundleMeta } from '../src/meta.ts';

const meta: AgentBundleMeta = Object.freeze({
  name: 'layers-fixture',
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

const app = Object.freeze({ name: 'dashboard', source: '/project/src/apps/dashboard.tsx', template: undefined });

/**
 * A hatch touching every layer: `tools.rsbuild` sets a profile-owned output
 * option (reaches the resolved config), asks to clean the dist path (the
 * invariant must win), and `tools.rspack` contributes both a config fragment
 * and a mutator (must run before the framework invariant mutator).
 */
const rspackFragment = Object.freeze({ resolve: { extensionAlias: { '.js': ['.js', '.ts'] } } });
const rspackMutator = (): void => undefined;
const tools: AgentBundleToolsConfig = {
  rsbuild: { output: { cleanDistPath: true, legalComments: 'linked' } },
  rspack: [rspackFragment, rspackMutator],
};

const invariantMutatorOf = (config: { readonly tools?: { readonly rspack?: unknown } }): readonly unknown[] => {
  const rspack = config.tools?.rspack;
  return Array.isArray(rspack) ? rspack : [rspack];
};

describe('composeToolsLayers', () => {
  it('orders profile, tools.rsbuild, tools.rspack, invariants and omits absent hatch layers', () => {
    const lift = { rsbuild: (fragment: unknown) => ({ layer: 'rsbuild', fragment }), rspack: (hatch: unknown) => ({ layer: 'rspack', hatch }) };
    expect(composeToolsLayers<unknown>({ invariants: 'invariants', lift, profile: 'profile', tools })).toEqual([
      'profile',
      { layer: 'rsbuild', fragment: tools.rsbuild },
      { layer: 'rspack', hatch: tools.rspack },
      'invariants',
    ]);
    expect(composeToolsLayers<unknown>({ invariants: 'invariants', lift, profile: 'profile' })).toEqual(['profile', 'invariants']);
    expect(composeToolsLayers<unknown>({ invariants: 'invariants', lift, profile: 'profile', tools: { rspack: rspackMutator } }))
      .toEqual(['profile', { layer: 'rspack', hatch: rspackMutator }, 'invariants']);
  });

  it('pins the invariant layer to cleanDistPath off plus the engine mutator', () => {
    const enforce = (): void => undefined;
    expect(frameworkInvariantLayer(enforce)).toEqual({ output: { cleanDistPath: false }, tools: { rspack: enforce } });
  });
});

describe('the shared layering reaches every synthesized config the same way', () => {
  const lib = composeEntryLibConfig(entry, { meta, outputRoot: '/staged/portable', tools });
  const apps = composeMcpAppsRsbuildConfig([app], { meta, outDir: '/staged/portable', tools });

  it('lets a tools.rsbuild fragment reach the MCP Apps config exactly as it reaches an entry lib', () => {
    expect(lib.output?.legalComments).toBe('linked');
    expect(apps.output?.legalComments).toBe('linked');
    // The profile beneath the fragment survives the merge on both paths.
    expect(lib.output?.filename).toEqual({ js: 'scripts/tool.mjs' });
    expect(apps.output?.filename).toEqual({ css: '[name].css', html: '[name].html', js: '[name].js' });
  });

  it('applies the tools.rspack hatch before the framework invariant mutator on both paths', () => {
    for (const config of [lib, apps]) {
      const mutators = invariantMutatorOf(config);
      expect(mutators.slice(0, 2)).toEqual([rspackFragment, rspackMutator]);
      expect(mutators).toHaveLength(3);
      const enforce = mutators[2];
      expect(typeof enforce).toBe('function');
      expect((enforce as { readonly name: string }).name).toBe('enforceInvariants');
    }
  });

  it('keeps the invariants above the hatch: cleanDistPath stays off on both paths', () => {
    expect(lib.output?.cleanDistPath).toBe(false);
    expect(apps.output?.cleanDistPath).toBe(false);
  });

  it('composes only the profile and the invariants without a hatch', () => {
    const bareLib = composeEntryLibConfig(entry, { meta, outputRoot: '/staged/portable' });
    const bareApps = composeMcpAppsRsbuildConfig([app], { meta, outDir: '/staged/portable' });
    for (const config of [bareLib, bareApps]) {
      const mutators = invariantMutatorOf(config);
      expect(mutators).toHaveLength(1);
      expect((mutators[0] as { readonly name: string }).name).toBe('enforceInvariants');
      expect(config.output?.cleanDistPath).toBe(false);
    }
  });
});
