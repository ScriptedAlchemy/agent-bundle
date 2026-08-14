import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { runCli } from '../src/cli.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';

it('contains prebuilt workbench asset reads to their declared root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-assets-'));
  try {
    await mkdir(join(root, 'static'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'index.html'), '<!doctype html><title>Workbench</title>'),
      writeFile(join(root, 'static', 'index.js'), 'export {};\n'),
    ]);
    const assets = createWorkbenchAssetSource({ root });

    await expect(assets.read('index.html')).resolves.toMatchObject({ contentType: 'text/html; charset=utf-8' });
    await expect(assets.read('static/index.js')).resolves.toMatchObject({ contentType: 'text/javascript; charset=utf-8' });
    await expect(assets.read('../secret.txt')).resolves.toBeUndefined();
    await expect(assets.read('static/../../secret.txt')).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('starts a loopback server with prebuilt assets, does not open on --no-open, and closes its coordinator', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-page-'));
  let openCalls = 0;
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>');
  try {
    const server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      openBrowser: async () => { openCalls += 1; },
      port: 0,
      root: project.root,
    });

    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
    await expect(fetch(server.url).then(async (response) => ({ body: await response.text(), status: response.status }))).resolves.toEqual({
      body: '<!doctype html><title>Agent Bundle workbench</title>',
      status: 200,
    });
    expect(openCalls).toBe(0);
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(server.url)).rejects.toThrow();
  } finally {
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('passes --no-open and the requested port from the CLI to the public dev API', async () => {
  const stdout: string[] = [];
  const received: unknown[] = [];
  const exitCode = await runCli(['dev', '--root', '/project', '--no-open', '--port', '4100'], {
    stdout: { write: (value) => stdout.push(value) },
  }, {
    startDevServer: async (options) => {
      received.push(options);
      return { close: async () => undefined, status: () => ({}) as never, url: 'http://127.0.0.1:4100' };
    },
  });

  expect(exitCode).toBe(0);
  expect(received).toEqual([expect.objectContaining({ open: false, port: 4100, root: '/project' })]);
  expect(stdout.join('')).toBe('Development workbench at http://127.0.0.1:4100\n');
});
