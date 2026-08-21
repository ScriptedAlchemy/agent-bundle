import { execFile as executeFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import config, { createWorkbenchConfig } from '../rsbuild.config.ts';

const execFile = promisify(executeFile);
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
  await expect(access(join(workbenchRoot, 'dist', 'index.html'))).resolves.toBeUndefined();
  await expect(access(join(workbenchRoot, 'dist', 'static', 'js', 'index.js'))).resolves.toBeUndefined();
});

it('keeps the Overview heading single-purpose and compact', async () => {
  const [main, styles] = await Promise.all([
    readFile(join(workbenchRoot, 'src/main.tsx'), 'utf8'),
    readFile(join(workbenchRoot, 'src/styles.css'), 'utf8'),
  ]);

  expect(main).not.toContain('className="eyebrow"');
  expect(styles).not.toContain('.eyebrow');
  expect(styles).toContain('.page-heading { margin-bottom: 30px; }');
  expect(styles).toContain('font-size: clamp(31px, 4vw, 40px);');
});

it('emits browser-safe JS even when the caller sets NODE_ENV=test', async () => {
  // Rstest sets NODE_ENV=test. Without an explicit rsbuild mode, that selects
  // mode 'none', leaves process.env.NODE_ENV unreplaced, and the workbench
  // crashes on boot with "process is not defined".
  await expect(execFile('npm', ['run', 'build', '--workspace', 'agent-bundle-workbench'], {
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
  })).resolves.toMatchObject({ stderr: '' });

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
