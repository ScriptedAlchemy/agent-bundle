import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import config, { createWorkbenchConfig } from '../rsbuild.config.ts';

const workspaceRoot = process.cwd();
const workbenchRoot = join(workspaceRoot, 'packages', 'workbench');

const resolveConfig = (command: 'build' | 'dev') => {
  if (typeof config === 'function') {
    const env = command === 'dev' ? 'development' : 'production';
    return config({ env, command, envMode: env });
  }
  return config;
};

it('pins production mode for builds so ambient NODE_ENV cannot select mode none', () => {
  expect(resolveConfig('build')).toMatchObject({ mode: 'production' });
  expect(resolveConfig('dev')).toMatchObject({ mode: 'development' });
});

it('builds workbench assets with stable unhashed names', () => {
  expect(resolveConfig('build')).toMatchObject({
    output: {
      copy: [
        { from: join(workbenchRoot, 'THIRD_PARTY_NOTICES'), to: 'THIRD_PARTY_NOTICES', toType: 'file' },
        { from: join(workbenchRoot, 'src/mcp/APP-RENDERER-LICENSE'), to: 'src/mcp/APP-RENDERER-LICENSE', toType: 'file' },
      ],
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

  // Rsbuild 2.x enables changeOrigin for every proxy rule by default.
  expect(configured).toMatchObject({
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:3100' },
      },
    },
  });
});

it('publishes the workbench application at the foreground server index asset', async () => {
  await expect(access(join(workbenchRoot, 'dist', 'index.html'))).resolves.toBeUndefined();
  await expect(access(join(workbenchRoot, 'dist', 'static', 'js', 'index.js'))).resolves.toBeUndefined();
});

it('emits browser-safe JS from the prepared production build', async () => {
  const jsRoot = join(workbenchRoot, 'dist', 'static', 'js');
  const files = await readdir(jsRoot);
  const contents = await Promise.all(
    files.filter((name) => name.endsWith('.js')).map(async (name) => ({
      name,
      text: await readFile(join(jsRoot, name), 'utf8'),
    })),
  );

  for (const { name, text } of contents) {
    expect(text, `${name} must not retain bare process.env.NODE_ENV`).not.toContain('process.env.NODE_ENV');
  }

  const indexHtml = await readFile(join(workbenchRoot, 'dist', 'index.html'), 'utf8');
  expect(indexHtml).toContain('id="root"');
  expect(indexHtml).toContain('/static/js/index.js');
});
