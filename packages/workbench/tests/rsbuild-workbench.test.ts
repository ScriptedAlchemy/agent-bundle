import { expect, it } from '@rstest/core';
import { access, readFile } from 'node:fs/promises';
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

it('keeps the Overview heading single-purpose and compact', async () => {
  const workbench = join(process.cwd(), 'packages/workbench');
  const [main, styles] = await Promise.all([
    readFile(join(workbench, 'src/main.tsx'), 'utf8'),
    readFile(join(workbench, 'src/styles.css'), 'utf8'),
  ]);

  expect(main).not.toContain('className="eyebrow"');
  expect(styles).not.toContain('.eyebrow');
  expect(styles).toContain('.page-heading { margin-bottom: 30px; }');
  expect(styles).toContain('font-size: clamp(31px, 4vw, 40px);');
});
