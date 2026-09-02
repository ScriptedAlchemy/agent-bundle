import { spawn } from 'node:child_process';
import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from '@rstest/core';

import { discoverDevServerUrl } from '../src/dev/dev-lock.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';
import { replaceWatchedSource } from './support/watched-files.ts';

const cliEntry = join(import.meta.dirname, '..', 'bin', 'agent-bundle.js');

const within = async <Value>(promise: Promise<Value>, milliseconds = 10_000): Promise<Value> => Promise.race([
  promise,
  new Promise<Value>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

const serverSource = (root: string, version: 'v1' | 'v2'): string => [
  "import { access } from 'node:fs/promises';",
  "import { McpServer } from '@modelcontextprotocol/server';",
  "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
  '',
  `const version = ${JSON.stringify(version)};`,
  'let count = 0;',
  "const server = new McpServer({ name: 'host-proxy-fixture', version: '1.0.0' });",
  "server.registerTool('count', { description: 'Increment session-local state.' }, async () => ({",
  "  content: [{ type: 'text', text: String(++count) }],",
  '}));',
  "server.registerTool('version', { description: 'Report the built fixture version.' }, async () => ({",
  "  content: [{ type: 'text', text: version }],",
  '}));',
  "server.registerTool('slow-version', { description: 'Complete after the test releases the call.' }, async () => {",
  `  const release = ${JSON.stringify(join(root, 'release-slow-call'))};`,
  '  while (true) {',
  '    try { await access(release); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }',
  '  }',
  "  return { content: [{ type: 'text', text: version }] };",
  '});',
  ...(version === 'v2'
    ? [
        "server.registerTool('new-tool', { description: 'Added by the rebuild.' }, async () => ({",
        "  content: [{ type: 'text', text: 'new' }],",
        '}));',
      ]
    : []),
  'await server.connect(new StdioServerTransport());',
  '',
].join('\n');

const writeProxyProject = async (root: string): Promise<string> => {
  const entry = join(root, 'src', 'server.ts');
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    symlink(
      join(agentBundleNodeModules, '@modelcontextprotocol'),
      join(root, 'node_modules', '@modelcontextprotocol'),
      'dir',
    ),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(entry, serverSource(root, 'v1')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'host-proxy-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
  return entry;
};

const openProxy = async (root: string, url?: string) => {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    args: [
      cliEntry,
      'dev',
      'proxy',
      '--root',
      root,
      '--server',
      'fixture',
      ...(url === undefined ? [] : ['--url', url]),
    ],
    command: process.execPath,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer | string) => stderr.push(chunk.toString()));
  const client = new Client({ name: 'host-proxy-test', version: '1.0.0' });
  await client.connect(transport).catch(async (error: unknown) => {
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 20); });
    throw new Error(`Proxy initialize failed. Proxy stderr: ${stderr.join('')}`, { cause: error });
  });
  return { client, stderr, transport };
};

const resultText = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected a text tool result.');
  return first.text;
};

it('preserves generated-server state across calls within one host epoch', async () => {
  const project = await createProjectFixture();
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    await writeProxyProject(project.root);
    server = await startDevServer({ open: false, port: 0, root: project.root });
    ({ client } = await openProxy(project.root, server.url));

    expect(resultText(await client.callTool({ arguments: {}, name: 'count' }))).toBe('1');
    expect(resultText(await client.callTool({ arguments: {}, name: 'count' }))).toBe('2');
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 60_000);

it('keeps one real proxy connection across rebuilds while calls stay bound to their starting epoch', async () => {
  const project = await createProjectFixture();
  let client: Client | undefined;
  let stderr: string[] = [];
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    const entry = await writeProxyProject(project.root);
    server = await startDevServer({ open: false, port: 0, root: project.root });
    expect(await discoverDevServerUrl({ projectRoot: project.root })).toBe(server.url);
    ({ client, stderr } = await openProxy(project.root, server.url));

    const listed = await client.listTools().catch((error: unknown) => {
      throw new Error(`Initial tools/list failed. Proxy stderr: ${stderr.join('')}`, { cause: error });
    });
    expect(listed.tools.map((tool) => tool.name)).toEqual(['count', 'version', 'slow-version']);
    expect(resultText(await client.callTool({ arguments: {}, name: 'version' }))).toBe('v1');

    const changed = Promise.withResolvers<void>();
    client.setNotificationHandler('notifications/tools/list_changed', async () => {
      changed.resolve();
    });
    const inFlight = client.callTool({ arguments: {}, name: 'slow-version' });
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50); });
    await replaceWatchedSource(project.root, entry, serverSource(project.root, 'v2'));
    await within(changed.promise);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['count', 'version', 'slow-version', 'new-tool']);
    expect(resultText(await client.callTool({ arguments: {}, name: 'version' }))).toBe('v2');
    await writeFile(join(project.root, 'release-slow-call'), '');
    expect(resultText(await inFlight)).toBe('v1');
    expect(resultText(await client.callTool({ arguments: {}, name: 'new-tool' }))).toBe('new');
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 90_000);

it('fails the connected host session closed with AB8024 when its active epoch is physically removed', async () => {
  const project = await createProjectFixture();
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    await writeProxyProject(project.root);
    server = await startDevServer({ open: false, port: 0, root: project.root });
    ({ client } = await openProxy(project.root, server.url));
    await client.listTools();
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected an active epoch.');
    const epochId = artifact.activeEpoch.id;
    await rm(join(project.root, '.agent-bundle', 'epochs', epochId), { force: true, recursive: true });
    await rm(join(project.root, '.agent-bundle', 'epochs', '.metadata', `${epochId}.json`), { force: true });

    await expect(client.listTools()).rejects.toMatchObject({
      data: { code: 'AB8024', epochId },
    });
    await expect(client.listTools()).rejects.toBeDefined();
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 60_000);

it('reports AB8025 and an MCP error when the discovered dev server goes away', async () => {
  const project = await createProjectFixture();
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let stderr: string[] = [];
  try {
    await writeProxyProject(project.root);
    server = await startDevServer({ open: false, port: 0, root: project.root });
    ({ client, stderr } = await openProxy(project.root, server.url));
    await client.listTools();
    await server.close();
    server = undefined;

    await expect(client.listTools()).rejects.toBeDefined();
    await within((async () => {
      while (!stderr.join('').includes('AB8025')) {
        await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 10); });
      }
    })());
    expect(stderr.join('')).toContain('Development MCP server is unavailable');
    await expect(access(join(project.root, '.agent-bundle', 'dev.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await removeProjectFixture(project.root);
  }
}, 60_000);

it('exits fail-closed when no development server is running', async () => {
  const project = await createProjectFixture();
  try {
    const child = spawn(process.execPath, [
      cliEntry,
      'dev',
      'proxy',
      '--root',
      project.root,
      '--server',
      'fixture',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer | string) => stderr.push(chunk.toString()));
    child.stdin.write(`${JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'host-proxy-test', version: '1.0.0' },
        protocolVersion: '2025-06-18',
      },
    })}\n`);

    const exitCode = await within(new Promise<number | null>((resolvePromise) => {
      child.once('close', resolvePromise);
    }));
    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('[AB8025] Development MCP server is unavailable.');
    const response = JSON.parse(stdout.join('').trim()) as {
      readonly error?: { readonly data?: { readonly code?: string } };
    };
    expect(response.error?.data?.code).toBe('AB8025');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 30_000);
