import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { startForegroundServer } from '../src/dev/foreground-server.ts';
import type { TraceHub } from '../src/dev/trace/trace-hub.ts';
import type { TraceReplay } from '../src/dev/trace/trace-entry.ts';
import type { EventTraceReceipt } from '../src/events/trace-receipt.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';
import { replaceWatchedSourceAndAwaitRebuild } from './support/watched-files.ts';

const runHook = (
  entry: string,
  input: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ code: number | null; stderr: string; stdout: string }>> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stderr, stdout }));
  child.stdin.end(JSON.stringify(input));
});

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
      'src/events/tool/before.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        '',
        "export const config = { runtime: 'standalone', targets: ['claude'] };",
        '',
        'export default async function BeforeTool({ native }) {',
        "  return createElement(Agent.Result, null, createElement(Agent.Context, null, `Observed ${native.tool_name}.`));",
        '}',
        '',
      ].join('\n'),
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
    const cookie = bootstrap.headers.get('set-cookie')!.split(';', 1)[0]!;
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

    const receiptRecordPath = join(project.root, '.agent-bundle', 'hook-receipts.json');
    const receiptEndpoint = JSON.parse(await readFile(receiptRecordPath, 'utf8')) as {
      readonly token: string;
      readonly url: string;
    };
    expect(receiptEndpoint.url).toBe(server.url);
    const receipt: EventTraceReceipt = {
      events: [
        { at: 100, kind: 'execute.start', phase: 'execute', runtime: 'standalone', sequence: 0 },
        { at: 102, kind: 'render.start', phase: 'render', sequence: 1 },
        { at: 105, durationMs: 3, kind: 'render.finish', phase: 'render', sequence: 2 },
      ],
      execution: {
        event: 'tool/before',
        executionId: 'trace-dev-server-receipt',
        host: 'claude',
        nativeEvent: 'PreToolUse',
      },
      identity: {
        conversationId: 'conversation-receipt',
        requestId: 'request-receipt',
        sessionId: 'session-receipt',
      },
      lineage: { reason: 'not-provided', state: 'unavailable' },
      startedAt: '2026-09-05T15:00:00.000Z',
      version: 1,
    };
    const browserReceipt = await fetch(`${server.url}/api/trace/receipts`, {
      body: JSON.stringify(receipt),
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: server.url,
        'x-agent-bundle-session': session.token,
      },
      method: 'POST',
    });
    expect(browserReceipt.status).toBe(403);
    await expect(browserReceipt.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8247',
        message: 'Hook receipts are not accepted from a browser.',
      },
    });
    const postedReceipt = await fetch(`${server.url}/api/trace/receipts`, {
      body: JSON.stringify(receipt),
      headers: {
        authorization: `Bearer ${receiptEndpoint.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(postedReceipt.status).toBe(204);
    const receiptReplayResponse = await fetch(`${server.url}/api/trace?after=0`, { headers });
    const receiptReplay = await receiptReplayResponse.json() as TraceReplay;
    expect(receiptReplay.entries.filter((entry) => entry.correlation.executionId === 'trace-dev-server-receipt'))
      .toEqual([
        expect.objectContaining({ kind: 'hook.received', source: 'hook' }),
        expect.objectContaining({ kind: 'hook.completed', source: 'hook' }),
      ]);

    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected an active artifact for the hook wrapper.');
    const artifactRoot = join(project.root, '.agent-bundle', 'epochs', artifact.activeEpoch.id);
    const installedRoot = join(project.root, 'installed-claude');
    await cp(artifactRoot, installedRoot, { recursive: true });
    await writeFile(join(installedRoot, '.agent-bundle-dev.json'), `${JSON.stringify({
      epochId: artifact.activeEpoch.id,
      host: 'claude',
      projectRoot: project.root,
      schemaVersion: 1,
    })}\n`);
    const hookEntryName = (await readdir(join(installedRoot, 'hooks')))
      .find((name) => name.endsWith('.mjs'));
    if (hookEntryName === undefined) throw new Error('Expected a generated hook wrapper.');
    const hostedHook = await runHook(join(installedRoot, 'hooks', hookEntryName), {
      cwd: project.root,
      hook_event_name: 'PreToolUse',
      session_id: 'session-marker',
      tool_input: { command: 'echo marker-discovery' },
      tool_name: 'Bash',
      tool_use_id: 'request-marker',
      transcript_path: join(project.root, 'transcript.jsonl'),
    });
    expect(hostedHook.code, hostedHook.stderr).toBe(0);
    const markerTraceResponse = await fetch(`${server.url}/api/trace?after=0`, { headers });
    const markerTrace = await markerTraceResponse.json() as TraceReplay;
    expect(markerTrace.entries.filter((entry) => entry.correlation.requestId === 'request-marker'))
      .toEqual([
        expect.objectContaining({ kind: 'hook.received', source: 'hook' }),
        expect.objectContaining({ kind: 'hook.completed', source: 'hook' }),
      ]);

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
    await expect(readFile(receiptRecordPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
