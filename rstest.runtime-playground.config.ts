import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { pluginReact } from '@rsbuild/plugin-react';
import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig, defineInlineProject } from '@rstest/core';

const browserReactRoot = realpathSync(resolve('node_modules/react'));
const browserReactDomRoot = realpathSync(resolve('node_modules/react-dom'));

export default defineConfig({
  coverage: {
    enabled: true,
    include: ['packages/workbench/src/runtime-{client,model,playground}.{ts,tsx}'],
    provider: 'v8',
    reporters: ['text', 'json'],
    thresholds: { branches: 85, functions: 90, lines: 90, statements: 90 },
  },
  projects: [
    defineInlineProject({
      extends: withRslibConfig(),
      include: [
        'packages/workbench/tests/runtime-client.test.ts',
        'packages/workbench/tests/runtime-contract-compile.test.ts',
        'packages/workbench/tests/runtime-model.test.ts',
        'packages/workbench/tests/runtime-playground.test.ts',
      ],
      name: 'runtime-node',
      setupFiles: ['./rstest.setup.ts'],
      testEnvironment: 'node',
    }),
    defineInlineProject({
      browser: {
        enabled: true,
        headless: true,
        provider: 'playwright',
        providerOptions: { launch: { channel: 'chrome' } },
        viewport: { height: 900, width: 1440 },
      },
      extends: withRslibConfig(),
      include: ['packages/workbench/tests/runtime-playground.browser.test.tsx'],
      name: 'runtime-browser',
      setupFiles: ['./rstest.setup.browser.ts'],
      plugins: [pluginReact()],
      resolve: {
        alias: {
          react: browserReactRoot,
          'react-dom': browserReactDomRoot,
        },
      },
      tools: {
        rspack: {
          resolve: {
            extensionAlias: { '.js': ['.js', '.ts', '.tsx'], '.jsx': ['.jsx', '.tsx'] },
          },
        },
      },
    }),
  ],
});
