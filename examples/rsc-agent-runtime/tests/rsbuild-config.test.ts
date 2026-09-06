import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { expect, test } from '@rstest/core';

import {
  createRscRuntimeRsbuildConfig,
  rscRuntimeBrowserHost,
  rscRuntimeReactPluginOptions,
} from '../rsbuild.config.js';

const webOutput = (
  config: ReturnType<typeof createRscRuntimeRsbuildConfig>,
  name: 'app' | 'rsc' | 'widget',
) => config.environments?.[name]?.output;

test('keeps the provider session and rsbuild build in production mode', () => {
  expect(createRscRuntimeRsbuildConfig({ compilerRoot: '/tmp/rsc-compiler', mode: 'development' }).mode)
    .toBe('production');
  expect(createRscRuntimeRsbuildConfig({ mode: 'production' }).mode).toBe('production');
});

test('configures pluginReact with Fast Refresh disabled', () => {
  expect(rscRuntimeReactPluginOptions).toEqual({ fastRefresh: false });
});

test('sets an explicit Chromium browserslist on the web hosts only', () => {
  expect(rscRuntimeBrowserHost).toEqual(['chrome >= 144']);
  const production = createRscRuntimeRsbuildConfig({ mode: 'production' });
  const development = createRscRuntimeRsbuildConfig({ compilerRoot: '/tmp/rsc-compiler', mode: 'development' });
  expect(webOutput(production, 'app')?.overrideBrowserslist).toEqual([...rscRuntimeBrowserHost]);
  expect(webOutput(production, 'widget')?.overrideBrowserslist).toEqual([...rscRuntimeBrowserHost]);
  expect(webOutput(production, 'rsc')?.overrideBrowserslist).toBeUndefined();
  expect(webOutput(development, 'app')?.overrideBrowserslist).toEqual([...rscRuntimeBrowserHost]);
  expect(webOutput(development, 'widget')?.overrideBrowserslist).toEqual([...rscRuntimeBrowserHost]);
});

test('resolved development topology keeps every React environment in production mode', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-config-'));
  try {
    const rsbuild = await createRsbuild({
      config: createRscRuntimeRsbuildConfig({ compilerRoot, mode: 'development' }),
      cwd: process.cwd(),
    });
    const inspection = await rsbuild.inspectConfig({ mode: 'development' });
    const widgetBundler = inspection.origin.bundlerConfigs.find((config) => config.name === 'widget');
    const appBundler = inspection.origin.bundlerConfigs.find((config) => config.name === 'app');

    expect(inspection.origin.rsbuildConfig.mode).toBe('production');
    expect(inspection.origin.environmentConfigs.app?.mode).toBe('production');
    expect(inspection.origin.environmentConfigs.rsc?.mode).toBe('production');
    expect(inspection.origin.environmentConfigs.widget?.mode).toBe('production');
    expect(inspection.origin.environmentConfigs.app?.output.overrideBrowserslist).toEqual([...rscRuntimeBrowserHost]);
    expect(inspection.origin.environmentConfigs.app?.output.sourceMap).toBe(false);
    expect(inspection.origin.environmentConfigs.widget?.output.overrideBrowserslist).toEqual([...rscRuntimeBrowserHost]);
    expect(appBundler?.plugins?.some((plugin) => plugin?.constructor?.name.includes('ReactRefresh'))).toBe(false);
    expect(widgetBundler?.plugins?.some((plugin) => plugin?.constructor?.name.includes('ReactRefresh'))).toBe(false);
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});
