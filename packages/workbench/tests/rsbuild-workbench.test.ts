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

it('hashes production JS, CSS, and assets so the foreground can cache them immutably', () => {
  expect(resolveConfig('build')).toMatchObject({
    mode: 'production',
    output: {
      copy: [
        { from: join(workbenchRoot, 'THIRD_PARTY_NOTICES'), to: 'THIRD_PARTY_NOTICES', toType: 'file' },
        { from: join(workbenchRoot, 'src/mcp/APP-RENDERER-LICENSE'), to: 'src/mcp/APP-RENDERER-LICENSE', toType: 'file' },
      ],
      filenameHash: true,
      filename: {
        assets: '[name].[contenthash:8][ext]',
        css: '[name].[contenthash:8].css',
        js: '[name].[contenthash:8].js',
      },
    },
  });
});

it('keeps contributor HMR filenames unhashed', () => {
  expect(resolveConfig('dev')).toMatchObject({
    mode: 'development',
    output: {
      filenameHash: false,
      filename: {
        assets: '[name][ext]',
        css: '[name].css',
        js: '[name].js',
      },
    },
  });
  expect(createWorkbenchConfig(undefined, 'development')).toMatchObject({
    output: {
      filenameHash: false,
      filename: {
        assets: '[name][ext]',
        css: '[name].css',
        js: '[name].js',
      },
    },
  });
});

it('proxies every typed foreground API route only when a contributor supplies its live foreground target', () => {
  const configured = createWorkbenchConfig('http://127.0.0.1:3100');

  // Rsbuild 2.x enables changeOrigin for every proxy rule by default, which
  // rewrites only Host: the browser's Origin reaches the foreground intact.
  // strictPort keeps the UI on the port the foreground allowlisted.
  expect(configured).toMatchObject({
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:3100' },
      },
      strictPort: true,
    },
  });
});

it('configures no dev server block when no foreground target is supplied', () => {
  const ambientTarget = process.env.AGENT_BUNDLE_WORKBENCH_API_PROXY;
  delete process.env.AGENT_BUNDLE_WORKBENCH_API_PROXY;
  try {
    expect(createWorkbenchConfig()).not.toHaveProperty('server');
  } finally {
    if (ambientTarget !== undefined) process.env.AGENT_BUNDLE_WORKBENCH_API_PROXY = ambientTarget;
  }
});

const hashedBundleName = (kind: 'css' | 'js'): RegExp =>
  kind === 'css' ? /^index\.[a-f0-9]{8}\.css$/u : /^index\.[a-f0-9]{8}\.js$/u;

it('publishes the workbench application at the foreground server index asset', async () => {
  const jsRoot = join(workbenchRoot, 'dist', 'static', 'js');
  await expect(access(join(workbenchRoot, 'dist', 'index.html'))).resolves.toBeUndefined();
  const js = (await readdir(jsRoot)).filter((name) => name.endsWith('.js'));
  expect(js.some((name) => hashedBundleName('js').test(name))).toBe(true);
  expect(js).not.toContain('index.js');
});

it('emits browser-safe content-hashed JS that index.html references', async () => {
  const jsRoot = join(workbenchRoot, 'dist', 'static', 'js');
  const cssRoot = join(workbenchRoot, 'dist', 'static', 'css');
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
  const referencedJs = files.filter((name) => indexHtml.includes(`/static/js/${name}`));
  expect(referencedJs.length).toBeGreaterThan(0);
  expect(referencedJs.every((name) => /\.[a-f0-9]{8}\.js$/u.test(name))).toBe(true);
  expect(referencedJs.some((name) => hashedBundleName('js').test(name))).toBe(true);
  const css = (await readdir(cssRoot)).filter((name) => name.endsWith('.css'));
  const referencedCss = css.filter((name) => indexHtml.includes(`/static/css/${name}`));
  expect(referencedCss).toEqual(expect.arrayContaining([expect.stringMatching(hashedBundleName('css'))]));
});
