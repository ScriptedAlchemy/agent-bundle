import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRslib, type RslibConfig } from '@rslib/core';
import { afterEach, describe, expect, it } from '@rstest/core';
import { pluginPublint } from 'rsbuild-plugin-publint';

import agentBundleConfig from '../rslib.config.ts';
import createAgentBundleConfig from '../../create-agent-bundle/rslib.config.ts';
import rscRuntimeConfig from '../../rsc-runtime/rslib.config.ts';

/**
 * publint is not a separate CI step: every publishable package's `rslib
 * build` runs it through rsbuild-plugin-publint and fails on a warning. This
 * suite is the proof behind removing the standalone `publint <dir>` script —
 * the plugin is registered where the packages build, and a warning-level
 * finding rejects the build the way the CI job expects.
 */

const publintPluginName = 'plugin-publint';

const pluginNames = (config: RslibConfig): readonly string[] =>
  (config.plugins ?? []).flatMap((plugin) => (
    typeof plugin === 'object' && plugin !== null && 'name' in plugin && typeof plugin.name === 'string'
      ? [plugin.name]
      : []
  ));

describe('publint build gate', () => {
  it('is registered in every publishable package build', () => {
    for (const config of [agentBundleConfig, createAgentBundleConfig, rscRuntimeConfig]) {
      expect(pluginNames(config)).toContain(publintPluginName);
    }
  });

  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  const probePackage = async (manifest: Readonly<Record<string, unknown>>): Promise<string> => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-publint-gate-')));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const probe = 1;\n');
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'publint-gate-probe',
      private: true,
      type: 'module',
      version: '0.0.0',
      ...manifest,
    }, null, 2)}\n`);
    return root;
  };

  const buildProbe = async (root: string): Promise<void> => {
    const rslib = await createRslib({
      config: {
        lib: [{ bundle: true, format: 'esm', syntax: 'es2022' }],
        logLevel: 'silent',
        output: { filenameHash: false, target: 'node' },
        performance: { buildCache: false },
        // The exact registration the three package configs use.
        plugins: [pluginPublint({ throwOn: 'warning' })],
        root,
        source: { entry: { index: './src/index.ts' } },
      },
      cwd: root,
    });
    const result = await rslib.build();
    await result.close();
  };

  it('fails the build on a warning-level publint finding', async () => {
    // `main` beside an `exports` map that never names "." is publint's
    // EXPORTS_MISSING_ROOT_ENTRYPOINT, a warning rather than an error.
    const root = await probePackage({
      exports: { './probe': './dist/index.js' },
      main: './dist/index.js',
    });
    await expect(buildProbe(root)).rejects.toThrow(/publint failed/iu);
  });

  it('passes a clean manifest', async () => {
    const root = await probePackage({ exports: { '.': './dist/index.js' } });
    await expect(buildProbe(root)).resolves.toBeUndefined();
  });
});
