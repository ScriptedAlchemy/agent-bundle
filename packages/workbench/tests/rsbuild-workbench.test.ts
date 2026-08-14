import { expect, it } from '@rstest/core';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import config, { createWorkbenchConfig } from '../rsbuild.config.ts';

it('builds workbench assets with stable unhashed names', () => {
  expect(config).toMatchObject({
    output: {
      filenameHash: false,
      filename: {
        css: '[name].css',
        js: '[name].js',
      },
    },
  });
});

it('proxies every typed foreground API route only when a contributor supplies its live foreground target', () => {
  const configured = createWorkbenchConfig('http://127.0.0.1:3100');

  expect(configured).toMatchObject({
    server: {
      proxy: {
        '/api': { changeOrigin: true, target: 'http://127.0.0.1:3100' },
      },
    },
  });
});

it('publishes the workbench application at the foreground server index asset', async () => {
  await expect(access(join(process.cwd(), 'packages/workbench/dist/index.html'))).resolves.toBeUndefined();
  await expect(access(join(process.cwd(), 'packages/workbench/dist/static/js/index.js'))).resolves.toBeUndefined();
});
