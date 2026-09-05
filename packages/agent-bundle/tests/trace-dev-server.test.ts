import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { startForegroundServer } from '../src/dev/foreground-server.ts';
import type { TraceHub } from '../src/dev/trace/trace-hub.ts';
import type { TraceReplay } from '../src/dev/trace/trace-entry.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';
import { replaceWatchedSourceAndAwaitRebuild } from './support/watched-files.ts';

it('serves replay and live trace entries and lowers build failures', { timeout: 60_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'trace-dev-server', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      'src/mcp/status/tools/report.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ ready: z.boolean() }).strict();',
        'export default async function Report() {',
        "  return createElement(Agent.Text, null, 'Ready.');",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-trace-dev-server-',
  });
  const assetsRoot = join(project.root, 'workbench');
  const reportPath = join(project.root, 'src/mcp/status/tools/report.tsx');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let trace: TraceHub | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Trace</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
      testing: {
        startForegroundServer: async (options) => {
          trace = options.trace;
          return startForegroundServer(options);
        },
      },
    });
    if (trace === undefined) throw new Error('Expected the dev server to compose a TraceHub.');
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const session = await bootstrap.json() as { readonly token: string };
    const headers = {
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };
    try {
      await expect.poll(
        async () => fetch(`${server!.url}/api/routes/manifest`, { headers }).then((response) => response.status),
        { timeout: 10_000 },
      ).toBe(200);
    } catch (error) {
      throw new Error(`Route manifest did not become ready: ${JSON.stringify(server.status())}`, { cause: error });
    }

    trace.publish({
      correlation: { invocationId: 'inv_replay', routeId: 'tool:status/report' },
      href: '/routes/mcp/status/tool/report?invocation=inv_replay',
      kind: 'invocation.completed',
      source: 'invocation',
      status: 'ok',
      summary: 'Replay entry.',
    });
    const replayResponse = await fetch(`${server.url}/api/trace?after=0`, { headers });
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as TraceReplay;
    expect(replay.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'invocation.completed', summary: 'Replay entry.' }),
    ]));

    const stream = await fetch(`${server.url}/api/trace/stream?after=${trace.latestSequence}`, { headers });
    expect(stream.status).toBe(200);
    trace.publish({
      correlation: { mcpSessionId: 'mcp_1' },
      kind: 'mcp.request',
      source: 'mcp',
      status: 'running',
      summary: 'Live entry.',
    });
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected a trace stream body.');
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('"kind":"mcp.request"');
    await reader.cancel();

    const failed = await replaceWatchedSourceAndAwaitRebuild(
      server,
      project.root,
      reportPath,
      [
        "import './missing.js';",
        "export default function Report() { return 'broken'; }",
        '',
      ].join('\n'),
      { timeoutMs: 10_000 },
    );
    expect(failed.outcome).toBe('failed');
    await expect.poll(async () => {
      const response = await fetch(`${server!.url}/api/trace?after=0`, { headers });
      const current = await response.json() as TraceReplay;
      return current.entries.find((entry) => entry.kind === 'diagnostic.build.failed');
    }, { timeout: 10_000 }).toMatchObject({
      href: '/problems',
      source: 'diagnostic',
      status: 'error',
    });

    await server.close();
    server = undefined;
    expect(trace.closed).toBe(true);
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
