import { expect, it } from '@rstest/core';

import { defineConfig, pathTokens } from '../src/index.ts';
import { runCli } from '../src/cli.ts';

it('preserves a synchronous config and exposes opaque path tokens', () => {
  const config = { plugin: { name: 'demo', version: '1.0.0' } };
  expect(defineConfig(config)).toBe(config);
  expect(pathTokens).toEqual({
    pluginRoot: 'agent-bundle:path:plugin-root',
    pluginData: 'agent-bundle:path:plugin-data',
    workspaceRoot: 'agent-bundle:path:workspace-root',
  });
});

it('loads every public subpath and reports the package version', async () => {
  await expect(import('../src/api.ts')).resolves.toBeDefined();
  await expect(import('../src/config/index.ts')).resolves.toBeDefined();
  await expect(import('../src/eval/index.ts')).resolves.toBeDefined();
  await expect(runCli(['--version'])).resolves.toBe(0);
});
