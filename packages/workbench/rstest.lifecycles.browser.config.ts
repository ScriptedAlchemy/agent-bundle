import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { pluginReact } from '@rsbuild/plugin-react';
import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const browserReactRoot = realpathSync(resolve(import.meta.dirname, 'node_modules/react'));
const browserReactDomRoot = realpathSync(resolve(import.meta.dirname, 'node_modules/react-dom'));

export default defineConfig({
  browser: {
    enabled: true,
    headless: true,
    provider: 'playwright',
    providerOptions: { launch: { channel: 'chrome' } },
    viewport: { height: 900, width: 1440 },
  },
  extends: withRslibConfig(),
  include: ['packages/workbench/tests/lifecycles-page.browser.test.tsx'],
  plugins: [pluginReact()],
  root: workspaceRoot,
  setupFiles: ['./rstest.setup.browser.ts'],
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
});
