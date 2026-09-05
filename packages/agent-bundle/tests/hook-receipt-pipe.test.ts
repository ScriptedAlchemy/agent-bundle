import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { attachHookReceipts } from '../src/dev/hooks/hook-receipt-endpoint.ts';
import { diagnostic, isRequestDiagnostic, responseDiagnostic } from '../src/dev/http.ts';
import type { TraceEntry } from '../src/dev/trace/trace-entry.ts';
import { TraceHub } from '../src/dev/trace/trace-hub.ts';
import { DEV_INSTALL_MARKER_FILE } from '../src/events/trace-receipt.ts';

/**
 * #600 PR 2, lane T7: a host-invoked hook against the dev plugin reports a
 * receipt to the dev server. The generated Claude hook wrapper is spawned the
 * way Claude spawns it — `node hooks/<name>.mjs` with the native payload on
 * stdin — and the receipt lands on a `TraceHub` behind the same route class
 * the foreground server mounts.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

interface HookRun {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const runHook = async (
  entry: string,
  input: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<HookRun> => new Promise((resolve, reject) => {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PLUGIN_ROOT: undefined };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const child = spawn(process.execPath, [entry], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stderr, stdout }));
  child.stdin.end(JSON.stringify(input));
});

const listen = async (hub: TraceHub, projectRoot: string) => {
  const attachment = attachHookReceipts({ projectRoot, trace: hub });
  const server: Server = createServer((request, response) => {
    void attachment.routes.handle(request, response).then((handled) => {
      if (!handled) responseDiagnostic(response, diagnostic('AB8005', 'Not found.', 404));
    }).catch((error: unknown) => {
      responseDiagnostic(response, isRequestDiagnostic(error) ? error : diagnostic('AB8007', 'Request could not be completed.', 500));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await attachment.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { attachment, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const nativePreToolUse = (root: string, toolUseId: string): Readonly<Record<string, unknown>> => ({
  cwd: root,
  hook_event_name: 'PreToolUse',
  session_id: 'session-receipt',
  tool_input: { command: 'echo never-on-the-trace' },
  tool_name: 'Bash',
  tool_use_id: toolUseId,
  transcript_path: join(root, 'transcript.jsonl'),
});

it('posts a host-invoked hook execution to the dev server as hook.received / hook.completed', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-receipt-pipe-'));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: { '@agent-bundle/runtime': 'workspace:*', react: '19.2.8' },
      name: 'hook-receipt-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'hook-receipt-fixture', version: '1.0.0' }, targets: ['claude'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/before.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['claude'] };",
      'export default async function BeforeTool({ native }) {',
      "  return createElement(Agent.Result, null, createElement(Agent.Context, null, `receipt:${native.tool_name}`));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/after.tsx', [
      "export const config = { runtime: 'standalone', targets: ['claude'] };",
      'export default async function AfterTool() {',
      "  throw new Error('after-tool exploded');",
      '}',
      '',
    ].join('\n')),
  ]);
  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['claude'] });
  const before = compiled.build.compiledHooks.find((hook) => hook.event === 'beforeTool');
  const after = compiled.build.compiledHooks.find((hook) => hook.event === 'afterTool');
  expect(before).toBeDefined();
  expect(after).toBeDefined();

  const projectRoot = join(root, 'dev-project');
  const hub = new TraceHub({ projectRoot });
  const { attachment, url } = await listen(hub, projectRoot);

  // (1) A dev-server-spawned simulation: the endpoint travels in the environment.
  const simulated = await runHook(before!.output, nativePreToolUse(root, 'toolu_env'), attachment.environment(url));
  expect(simulated.code, simulated.stderr).toBe(0);
  expect(JSON.parse(simulated.stdout)).toMatchObject({
    hookSpecificOutput: { additionalContext: 'receipt:Bash', hookEventName: 'PreToolUse' },
  });
  const afterEnv = hub.replay().entries;
  expect(afterEnv.map((entry) => entry.kind)).toEqual(['hook.received', 'hook.completed']);
  const [received, completed] = afterEnv as [TraceEntry, TraceEntry];
  expect(received).toMatchObject({
    correlation: {
      conversationId: 'session-receipt',
      host: 'claude',
      requestId: 'toolu_env',
      routeId: 'event:tool/before',
      sessionId: 'session-receipt',
    },
    href: '/routes/events/tool/before',
    source: 'hook',
    status: 'ok',
    summary: 'claude PreToolUse → tool · before received',
  });
  expect(received.correlation.executionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(completed.correlation).toEqual(received.correlation);
  expect(completed).toMatchObject({
    details: {
      events: [
        { kind: 'execute.start', phase: 'execute', runtime: 'standalone' },
        { kind: 'render.start', phase: 'render' },
        { kind: 'render.finish', phase: 'render' },
      ],
      lineage: { source: 'native', state: 'available', value: { conversation: 'session-receipt', depth: 0, root: 'session-receipt' } },
      runtime: 'standalone',
    },
    href: '/routes/events/tool/before',
    status: 'ok',
    summary: 'claude PreToolUse → tool · before completed',
  });
  expect(typeof completed.durationMs).toBe('number');
  const serialized = JSON.stringify(afterEnv);
  expect(serialized).not.toContain('never-on-the-trace');
  expect(serialized).not.toContain('tool_input');
  expect(serialized).not.toContain(root);
  expect(serialized).not.toContain(attachment.token);

  // (2) A host's own invocation: no environment, the dev install marker beside
  //     the wrapper names the project whose dev server published its endpoint.
  await attachment.publishEndpoint(url);
  await writeFile(
    join(dirname(before!.output), '..', DEV_INSTALL_MARKER_FILE),
    `${JSON.stringify({ epochId: 'epoch-1', host: 'claude', projectRoot, schemaVersion: 1 })}\n`,
  );
  const hosted = await runHook(before!.output, nativePreToolUse(root, 'toolu_marker'), {});
  expect(hosted.code, hosted.stderr).toBe(0);
  const afterMarker = hub.replay().entries.slice(afterEnv.length);
  expect(afterMarker.map((entry) => entry.kind)).toEqual(['hook.received', 'hook.completed']);
  expect(afterMarker[0]!.correlation).toMatchObject({ requestId: 'toolu_marker' });
  expect(afterMarker[0]!.correlation.executionId).not.toBe(received.correlation.executionId);

  // (3) A thrown route still reports: hook.failed with the kernel error summary,
  //     and the host still sees exit 1 with the message on stderr.
  const thrown = await runHook(after!.output, {
    cwd: root,
    hook_event_name: 'PostToolUse',
    session_id: 'session-receipt',
    tool_input: { command: 'echo' },
    tool_name: 'Bash',
    tool_response: { ok: true },
    tool_use_id: 'toolu_thrown',
    transcript_path: join(root, 'transcript.jsonl'),
  }, {});
  expect(thrown.code).toBe(1);
  expect(thrown.stdout).toBe('');
  expect(thrown.stderr).toContain('after-tool exploded');
  const afterThrown = hub.replay().entries.slice(afterEnv.length + afterMarker.length);
  expect(afterThrown.map((entry) => entry.kind)).toEqual(['hook.received', 'hook.failed']);
  expect(afterThrown[1]).toMatchObject({
    correlation: { requestId: 'toolu_thrown', routeId: 'event:tool/after' },
    details: { error: { message: 'after-tool exploded', name: 'Error' }, failedPhase: 'render' },
    href: '/routes/events/tool/after',
    status: 'error',
  });

  // (4) Production silence: the dev server is gone, the wrapper answers the host and reports nothing.
  await attachment.close();
  const alone = await runHook(before!.output, nativePreToolUse(root, 'toolu_alone'), {});
  expect(alone.code, alone.stderr).toBe(0);
  expect(JSON.parse(alone.stdout)).toMatchObject({ hookSpecificOutput: { additionalContext: 'receipt:Bash' } });
  expect(hub.latestSequence).toBe(afterEnv.length + afterMarker.length + afterThrown.length);
});
