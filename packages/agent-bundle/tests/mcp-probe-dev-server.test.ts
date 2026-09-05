import { access, cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import type { McpProbeReport } from '../src/contracts/mcp-probe.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

it('runs an authenticated initialize and tools/list probe against a real built stdio server', { timeout: 30_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      '  mcp: {',
      '    servers: {',
      "      timeline: { entry: { prebuilt: './prebuilt/runtime/mcp/stdio.js' }, transport: 'stdio' },",
      '    },',
      '  },',
      "  payload: { runtime: './prebuilt/runtime' },",
      "  plugin: { name: 'mcp-probe-dev-server', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: { 'package.json': '{"type":"module"}\n' },
    prefix: 'agent-bundle-mcp-probe-dev-server-',
  });
  const assetsRoot = join(project.root, 'workbench');
  const exampleRuntime = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'examples',
    'rsc-agent-runtime',
    'dist',
    'runtime',
  );
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    mkdir(assetsRoot, { recursive: true }),
    mkdir(join(project.root, 'dist'), { recursive: true }),
    mkdir(join(project.root, 'prebuilt'), { recursive: true }),
  ]);
  await Promise.all([
    cp(exampleRuntime, join(project.root, 'prebuilt', 'runtime'), { recursive: true }),
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>MCP probe</title>'),
  ]);
  try {
    const built = await build({ output: join(project.root, 'dist'), root: project.root });
    expect(built.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    await access(join(project.root, 'dist', '.mcp.json'));

    const unauthenticated = await fetch(`${server.url}/api/discovery/probes`, {
      body: JSON.stringify({ host: 'claude', serverName: 'timeline' }),
      headers: {
        'content-type': 'application/json',
        origin: server.url,
      },
      method: 'POST',
    });
    expect(unauthenticated.status).toBe(403);

    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const { token } = await bootstrap.json() as { readonly token: string };
    const response = await fetch(`${server.url}/api/discovery/probes`, {
      body: JSON.stringify({ host: 'claude', serverName: 'timeline' }),
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        'x-agent-bundle-session': token,
      },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const report = await response.json() as McpProbeReport;

    expect(report.status).toBe('ok');
    expect(report.host).toBe('claude');
    expect(report.serverName).toBe('timeline');
    expect(report.snapshot?.protocolVersion).not.toBe('');
    expect(report.snapshot?.tools.length).toBeGreaterThan(0);
    expect(report.launch).toMatchObject({
      command: 'node',
      kind: 'stdio',
    });
    if (report.launch.kind !== 'stdio') throw new Error('Expected a stdio probe launch.');
    expect(Object.keys(report.launch.env).every((key) =>
      ['FORCE_COLOR', 'LANG', 'LC_ALL', 'NO_COLOR', 'TZ'].includes(key))).toBe(true);
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

it('joins detached probe plugin-data cleanup into Workbench shutdown', { timeout: 30_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      '  mcp: {',
      '    servers: {',
      "      timeline: { entry: { prebuilt: './prebuilt/runtime/mcp/stdio.js' }, transport: 'stdio' },",
      '    },',
      '  },',
      "  payload: { runtime: './prebuilt/runtime' },",
      "  plugin: { name: 'mcp-probe-dev-server-shutdown', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: { 'package.json': '{"type":"module"}\n' },
    prefix: 'agent-bundle-mcp-probe-dev-server-shutdown-',
  });
  const assetsRoot = join(project.root, 'workbench');
  const exampleRuntime = join(import.meta.dirname, '..', '..', '..', 'examples', 'rsc-agent-runtime', 'dist', 'runtime');
  const pluginData = join(project.root, 'probe-plugin-data');
  let transportCloseSettled = false;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await Promise.all([
    mkdir(assetsRoot, { recursive: true }),
    mkdir(join(project.root, 'dist'), { recursive: true }),
    mkdir(join(project.root, 'prebuilt'), { recursive: true }),
  ]);
  await Promise.all([
    cp(exampleRuntime, join(project.root, 'prebuilt', 'runtime'), { recursive: true }),
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>MCP probe</title>'),
  ]);
  try {
    const built = await build({ output: join(project.root, 'dist'), root: project.root });
    expect(built.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
      testing: {
        mcpProbeOptions: {
          createClient: () => ({
            close: async () => undefined,
            connect: async () => undefined,
            getInstructions: () => undefined,
            getNegotiatedProtocolVersion: () => '2025-11-25',
            getServerCapabilities: () => ({ tools: {} }),
            getServerVersion: () => ({ name: 'timeline', version: '1.0.0' }),
            listTools: async () => ({ tools: [] }),
          }),
          createPluginData: async () => {
            await mkdir(pluginData, { recursive: true });
            await writeFile(join(pluginData, 'proof.txt'), 'present');
            return pluginData;
          },
          // A stdio server whose shutdown outlives the 50 ms response boundary.
          createStdioTransport: () => ({
            close: async () => {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
              transportCloseSettled = true;
            },
            send: async () => undefined,
            start: async () => undefined,
          }),
        },
      },
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, { headers: { 'sec-fetch-site': 'same-origin' } });
    const { token } = await bootstrap.json() as { readonly token: string };
    const response = await fetch(`${server.url}/api/discovery/probes`, {
      body: JSON.stringify({ host: 'claude', serverName: 'timeline' }),
      headers: { 'content-type': 'application/json', origin: server.url, 'x-agent-bundle-session': token },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect((await response.json() as McpProbeReport).status).toBe('ok');
    // The response returned while the transport was still closing, so the
    // plugin data is still held...
    expect(transportCloseSettled).toBe(false);
    await access(join(pluginData, 'proof.txt'));

    // ...and Workbench shutdown joins the detached teardown before resolving.
    const closing = server;
    server = undefined;
    await closing.close();
    expect(transportCloseSettled).toBe(true);
    await expect(access(join(pluginData, 'proof.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
