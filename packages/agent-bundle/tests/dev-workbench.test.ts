import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { expect, it } from '@rstest/core';

import { runCli } from '../src/cli.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import {
  closeDevServerLifecycle,
  DevServerLifecycleCloseError,
  startDevServer,
} from '../src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';

const readToEnd = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const next = await reader.read();
    if (next.done) return output;
    output += decoder.decode(next.value, { stream: true });
  }
};

const within = async <Value>(promise: Promise<Value>, milliseconds: number): Promise<Value> => Promise.race([
  promise,
  new Promise<Value>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

const writeMcpProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    symlink(
      join(process.cwd(), 'node_modules', '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    ),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      '',
      "const server = new McpServer({ name: 'workbench-fixture', version: '1.0.0' });",
      "server.registerTool('wait', { description: 'Wait for shutdown.' }, async () => new Promise(() => {}));",
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'workbench-mcp-fixture', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

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
    await expect(fetch(`${server.url}/api/skills/source/skill%3Areview`).then(async (response) => ({
      body: await response.json(),
      status: response.status,
    }))).resolves.toMatchObject({
      body: { document: { id: 'skill:review', frontmatter: { name: 'review' } } },
      status: 200,
    });
    expect(openCalls).toBe(0);
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(server.url)).rejects.toThrow();
  } finally {
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('normalizes a relative project root once before constructing every dev service', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-relative-root-'));
  const root = relative(process.cwd(), project.root);
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>');
  try {
    expect(root).not.toBe(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root,
    });

    expect(server.status().artifact.state).toBe('active');
    await expect(fetch(`${server.url}/api/skills/source/skill%3Areview`).then((response) => response.json())).resolves.toMatchObject({
      document: { id: 'skill:review' },
    });
  } finally {
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 30_000);

it('binds real epoch MCP sessions to the workbench lifecycle and drains trace readers before cleanup', async () => {
  const project = await createProjectFixture();
  const assetsRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-workbench-mcp-'));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    writeMcpProject(project.root),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Agent Bundle workbench</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected the workbench to publish an active artifact epoch.');
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const headers = { origin: server.url, 'x-agent-bundle-session': token };
    const created = await fetch(`${server.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: artifact.activeEpoch.id, serverName: 'fixture', target: 'portable' }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(200);
    const { session } = await created.json() as { readonly session: { readonly id: string } };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/u);

    const config = await fetch(`${server.url}/api/mcp/sessions/${session.id}/config`, { headers });
    const configBody = await config.json() as { readonly config: { readonly origin: string } };
    expect(configBody.config.origin).toBe('artifact');

    const trace = await fetch(`${server.url}/api/mcp/sessions/${session.id}/stream?after=0`, { headers });
    reader = trace.body?.getReader();
    if (reader === undefined) throw new Error('Expected an MCP trace stream.');

    const closing = server.close();
    await expect(within(readToEnd(reader), 1_000)).resolves.toContain('"kind":"operation"');
    await expect(closing).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(fetch(`${server.url}/api/mcp/sessions/${session.id}`, { headers })).rejects.toThrow();
    await expect(access(join(project.root, '.agent-bundle', 'epochs', artifact.activeEpoch.id))).resolves.toBeUndefined();
  } finally {
    await reader?.cancel();
    await server?.close().catch(() => undefined);
    await Promise.all([removeProjectFixture(project.root), rm(assetsRoot, { force: true, recursive: true })]);
  }
}, 60_000);

it('keeps MCP and coordinator cleanup failures structural while releasing both resources', async () => {
  const mcpFailure = new Error('MCP cleanup failed.');
  const coordinatorFailure = new Error('Coordinator cleanup failed.');
  let mcpCloseCalls = 0;
  let coordinatorCloseCalls = 0;

  await expect(closeDevServerLifecycle(
    { close: async () => { mcpCloseCalls += 1; throw mcpFailure; } },
    { close: async () => { coordinatorCloseCalls += 1; throw coordinatorFailure; } },
  )).rejects.toEqual(expect.objectContaining({
    failures: [
      { error: mcpFailure, resource: 'mcp-sessions' },
      { error: coordinatorFailure, resource: 'coordinator' },
    ],
    name: DevServerLifecycleCloseError.name,
  }));
  expect(mcpCloseCalls).toBe(1);
  expect(coordinatorCloseCalls).toBe(1);
});

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

it('closes the foreground session once when the dev CLI receives a termination signal', async () => {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const removed: NodeJS.Signals[] = [];
  let closeCalls = 0;

  await expect(runCli(['dev', '--root', '/project', '--no-open'], {}, {
    signals: {
      once: (signal, listener) => { handlers.set(signal, listener); },
      removeListener: (signal) => { removed.push(signal); },
    },
    startDevServer: async () => ({
      close: async () => { closeCalls += 1; },
      status: () => ({}) as never,
      url: 'http://127.0.0.1:4100',
    }),
  })).resolves.toBe(0);

  handlers.get('SIGINT')?.();
  handlers.get('SIGTERM')?.();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  expect(closeCalls).toBe(1);
  expect(removed).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
});
