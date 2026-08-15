import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRsbuild } from '@rsbuild/core';
import { expect, test } from '@rstest/core';
import { createElement, type ReactNode } from 'react';

import { ProjectService } from '../../../packages/agent-bundle/src/dev/index.ts';
import { createRscRuntimeRsbuildConfig } from '../rsbuild.config.js';
import { createDevRuntimeProvider } from '../src/dev/provider.js';
import { serializeInspection } from '../src/dev/serialize-inspection.js';

const readChildOutput = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  });

const startInvocation = (entry: string, request: Record<string, unknown>) => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify(request));

  const completed = Promise.all([
    readChildOutput(child.stdout),
    readChildOutput(child.stderr),
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }),
  ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stderr: stderr.toString('utf8'), stdout }));

  return { child, completed };
};

const invoke = async (entry: string, request: Record<string, unknown>) => startInvocation(entry, request).completed;

const buildInvocationEntry = async (compilerRoot: string): Promise<string> => {
  const rsbuild = await createRsbuild({
    config: createRscRuntimeRsbuildConfig({ compilerRoot, mode: 'development' }),
    cwd: process.cwd(),
  });
  await rsbuild.build();
  return join(compilerRoot, 'rsc', 'dev', 'invoke.js');
};

const waitFor = async (condition: () => boolean, message: string, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

const readWhenPresent = async (path: string): Promise<string> => {
  let value: string | undefined;
  await waitFor(() => {
    try {
      value = readFileSync(path, 'utf8');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }, `Timed out waiting for ${path}`);
  return value as string;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const event = (eventId: string) => ({
  eventId,
  host: 'claude' as const,
  path: `src/${eventId}.ts`,
  recordedAt: '2026-08-15T00:00:00.000Z',
  sessionId: 'session',
  toolName: 'Write',
});

const oversizedMcpWorker = (payloadBytes: number): string => {
  return `const payload = 'x'.repeat(${payloadBytes});
const model = ['$', 'mcp-result', null, {
  _meta: '$undefined',
  isError: '$undefined',
  structuredContent: { payload, stateVersion: 0 },
  children: [['$', 'mcp-text', null, { children: 'ok' }]],
}];
process.stdout.end(\`0:\${JSON.stringify(model)}\\n\`);
`;
};

const inspectionShape = (result: { inspection: Record<string, unknown> }) => {
  const { flight: _flight, ...inspection } = result.inspection;
  return inspection;
};

const assertJsonOnly = (value: unknown): void => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return;
  expect(typeof value).not.toBe('function');
  expect(typeof value).not.toBe('symbol');
  if (Array.isArray(value)) {
    value.forEach(assertJsonOnly);
    return;
  }
  expect(value).toBeTypeOf('object');
  Object.values(value as Record<string, unknown>).forEach(assertJsonOnly);
};

test('builds a generation-contained inspection entry for Claude, Codex, and MCP fixtures', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  const workspace = join(compilerRoot, 'workspace');
  const request = {
    host: 'claude',
    input: {
      cwd: workspace,
      hook_event_name: 'PostToolUse',
      session_id: 'claude-session',
      tool_input: { file_path: 'demo.txt' },
      tool_name: 'Write',
      tool_use_id: 'claude-fixture-1',
    },
    stateStoreId: 'fixture-state',
    type: 'hook/after-file-edit',
  };

  try {
    const entry = await buildInvocationEntry(compilerRoot);
    const first = await invoke(entry, { ...request, stateFile: join(compilerRoot, 'first.jsonl') });
    const second = await invoke(entry, { ...request, stateFile: join(compilerRoot, 'second.jsonl') });

    expect(first).toMatchObject({ exitCode: 0, stderr: '' });
    expect(second).toMatchObject({ exitCode: 0, stderr: '' });
    expect(first.stdout.byteLength).toBeLessThan(1024 * 1024);
    expect(first.stdout.toString('utf8')).toMatch(/^\{[^\n]+\}\n$/u);

    const firstResult = JSON.parse(first.stdout.toString('utf8')) as {
      flightBase64: string;
      inspection: Record<string, unknown>;
    };
    const secondResult = JSON.parse(second.stdout.toString('utf8')) as typeof firstResult;
    expect(inspectionShape(secondResult)).toEqual(inspectionShape(firstResult));
    expect(firstResult.flightBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    assertJsonOnly(firstResult);
    expect(firstResult.inspection).toMatchObject({
      agentVisible: 'Recorded demo.txt from claude. Shared state now contains 1 edit.',
      native: {
        hookSpecificOutput: {
          additionalContext: 'Recorded demo.txt from claude. Shared state now contains 1 edit.',
          hookEventName: 'PostToolUse',
        },
      },
      state: { identity: { stateStoreId: 'fixture-state', stateVersion: 1 } },
      trace: [
        { id: 'normalize', phase: 'normalize', status: 'succeeded' },
        { id: 'worker', phase: 'worker', status: 'succeeded' },
        { id: 'flight', phase: 'flight', status: 'succeeded' },
        { id: 'decode', phase: 'decode', status: 'succeeded' },
        { id: 'lower', phase: 'lower', status: 'succeeded' },
      ],
      tree: [
        {
          children: [
            {
              children: [
                { children: [], id: 'node-2', kind: 'text', label: 'Recorded demo.txt from claude. Shared state now contains 1 edit.' },
              ],
              id: 'node-1',
              kind: 'element',
              label: 'agent-hook-additional-context',
            },
          ],
          id: 'node-0',
          kind: 'element',
          label: 'agent-hook-result',
        },
      ],
    });

    const codex = await invoke(entry, {
      host: 'codex',
      input: {
        cwd: workspace,
        hook_event_name: 'PostToolUse',
        session_id: 'codex-session',
        tool_input: { command: '*** Begin Patch\n*** Add File: codex.txt\n+content\n*** End Patch' },
        tool_name: 'apply_patch',
        tool_use_id: 'codex-fixture-1',
      },
      stateFile: join(compilerRoot, 'codex.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'hook/after-file-edit',
    });
    expect(codex).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(codex.stdout.toString('utf8'))).toMatchObject({
      inspection: {
        agentVisible: 'Recorded codex.txt from codex. Shared state now contains 1 edit.',
        native: {
          hookSpecificOutput: {
            additionalContext: 'Recorded codex.txt from codex. Shared state now contains 1 edit.',
            hookEventName: 'PostToolUse',
          },
        },
      },
    });

    const status = await invoke(entry, {
      stateFile: join(compilerRoot, 'first.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'mcp/runtime-status',
    });
    expect(status).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(status.stdout.toString('utf8'))).toMatchObject({
      inspection: {
        modelVisible: [
          { text: 'Runtime state contains 1 edit.', type: 'text' },
          {
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
            mimeType: 'image/png',
            type: 'image',
          },
        ],
        protocol: {
          content: [
            { text: 'Runtime state contains 1 edit.', type: 'text' },
            {
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
              mimeType: 'image/png',
              type: 'image',
            },
          ],
          structuredContent: { editCount: 1, stateVersion: 1 },
        },
        state: { identity: { stateStoreId: 'fixture-state', stateVersion: 1 } },
      },
    });
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});

test('strictly freezes decoded inspection values while stripping only functions and symbols', () => {
  const valid = serializeInspection({
    flight: Buffer.from('flight'),
    node: createElement('inspection-root', { callback: () => undefined, keep: 'value', marker: Symbol('marker') }, 'text'),
    stateStoreId: 'state',
    stateVersion: 1,
  });
  expect(valid.tree).toEqual([
    {
      children: [{ children: [], id: 'node-1', kind: 'text', label: 'text' }],
      id: 'node-0',
      kind: 'element',
      label: 'inspection-root',
      props: { keep: 'value' },
    },
  ]);

  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'unexpected' });
  const sparse = new Array<unknown>(2);
  sparse[1] = 'present';
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const repeatedCycle = { cycle };
  const shared = Object.freeze({ value: 'shared' });
  const cyclicChildren: ReactNode[] = [];
  cyclicChildren.push(cyclicChildren);
  const sparseChildren = new Array<ReactNode>(2);
  sparseChildren[1] = 'present';
  const accessorChildren = new Array<ReactNode>(1);
  Object.defineProperty(accessorChildren, '0', { enumerable: true, get: () => 'unexpected' });

  for (const value of [accessor, sparse, new Date('2026-08-15T00:00:00.000Z'), repeatedCycle]) {
    expect(() => serializeInspection({
      flight: Buffer.from('flight'),
      node: createElement('inspection-root', { value }),
      stateStoreId: 'state',
      stateVersion: 1,
    })).toThrow('Inspection JSON');
  }
  expect(() => serializeInspection({
    flight: Buffer.from('flight'),
    node: createElement('inspection-root', null, cyclicChildren),
    stateStoreId: 'state',
    stateVersion: 1,
  })).toThrow('Inspection tree');
  for (const children of [sparseChildren, accessorChildren]) {
    expect(() => serializeInspection({
      flight: Buffer.from('flight'),
      node: createElement('inspection-root', null, children),
      stateStoreId: 'state',
      stateVersion: 1,
    })).toThrow('Inspection tree');
  }
  expect(() => serializeInspection({
    flight: Buffer.from('flight'),
    node: createElement('inspection-root', null, new Date('2026-08-15T00:00:00.000Z') as unknown as ReactNode),
    stateStoreId: 'state',
    stateVersion: 1,
  })).toThrow('Inspection JSON');
  expect(() => serializeInspection({
    flight: Buffer.from('flight'),
    native: { first: shared, second: shared },
    node: createElement('inspection-root'),
    stateStoreId: 'state',
    stateVersion: 1,
  })).toThrow('Inspection JSON');
});

test('rejects unsafe timeline snapshots before emitting an inspection', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    const sensitiveValue = 'Bearer fixture-credential-value';
    const providerCredential = 'sk-live-abcdefghijklmnopqrstuvwxyz';
    for (const snapshot of [
      { edits: [event('one')], stateVersion: 1, unexpected: true },
      { edits: [{ ...event('two'), accessToken: 'fixture-credential-value' }], stateVersion: 1 },
      { edits: [{ ...event('three'), path: sensitiveValue }], stateVersion: 1 },
      { edits: [{ ...event('four'), path: providerCredential }], stateVersion: 1 },
    ]) {
      const result = await invoke(entry, {
        snapshot,
        stateFile: join(compilerRoot, 'events.jsonl'),
        stateStoreId: 'fixture-state',
        type: 'mcp/render-timeline',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.stderr).not.toContain('fixture-credential-value');
      expect(result.stderr).not.toContain(providerCredential);
    }
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});

test('retains a supplied timeline snapshot across a deferred concurrent state-file edit', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    const stateFile = join(compilerRoot, 'events.jsonl');
    const rscRoot = join(compilerRoot, 'rsc', 'rsc');
    const workerPath = join(rscRoot, 'index.js');
    const delayedWorkerPath = join(rscRoot, 'index.deferred.js');
    const marker = join(compilerRoot, 'rsc-timeline-child.ready');
    await writeFile(stateFile, `${JSON.stringify(event('first'))}\n`);
    await rename(workerPath, delayedWorkerPath);
    await writeFile(
      workerPath,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setTimeout(() => require('./index.deferred.js'), 100);\n`,
    );
    const invocation = startInvocation(entry, {
      snapshot: { edits: [event('first')], stateVersion: 1 },
      stateFile,
      stateStoreId: 'fixture-state',
      type: 'mcp/render-timeline',
    });
    await readWhenPresent(marker);
    await appendFile(stateFile, `${JSON.stringify(event('second'))}\n`);
    const result = await invocation.completed;

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout.toString('utf8'))).toMatchObject({
      inspection: {
        protocol: { structuredContent: { edits: [event('first')], stateVersion: 1 } },
        state: { identity: { stateStoreId: 'fixture-state', stateVersion: 1 } },
      },
    });
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});

test('redacts bounded RSC worker stderr diagnostics', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    await writeFile(
      join(compilerRoot, 'rsc', 'rsc', 'index.js'),
      "process.stderr.write('credential=fixture-credential cookie=fixture-cookie authorization=fixture-authorization Bearer fixture-bearer-secret sk-live-abcdefghijklmnopqrstuvwxyz ghp_012345678901234567890123456789 xoxb-0123456789-0123456789-abcdefghijklmnop AKIA0123456789ABCDEF\\n'.repeat(20_000), () => process.exit(1));\n",
    );
    const result = await invoke(entry, {
      stateFile: join(compilerRoot, 'events.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'mcp/runtime-status',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(256 * 1024 + 1_024);
    for (const secret of [
      'fixture-credential',
      'fixture-cookie',
      'fixture-authorization',
      'fixture-bearer-secret',
      'sk-live-abcdefghijklmnopqrstuvwxyz',
      'ghp_012345678901234567890123456789',
      'xoxb-0123456789-0123456789-abcdefghijklmnop',
      'AKIA0123456789ABCDEF',
    ]) expect(result.stderr).not.toContain(secret);
    expect(result.stderr).toContain('[redacted]');
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});

test('caps a sub-two-megabyte Flight before its duplicated inspection response reaches stdout', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    await writeFile(join(compilerRoot, 'rsc', 'rsc', 'index.js'), oversizedMcpWorker(1_500_000));
    const result = await invoke(entry, {
      stateFile: join(compilerRoot, 'events.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'mcp/runtime-status',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr).toContain('Inspection response exceeded output limit');
    expect(result.stderr).not.toContain('x'.repeat(128));
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
});

test('bounds Flight output and waits for a SIGKILL cleanup when the RSC child ignores SIGTERM', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  let childPid: number | undefined;
  let invocation: ReturnType<typeof startInvocation> | undefined;
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    const marker = join(compilerRoot, 'rsc-flight-child.pid');
    await writeFile(
      join(compilerRoot, 'rsc', 'rsc', 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => undefined); process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => undefined, 1_000);\n`,
    );
    invocation = startInvocation(entry, {
      stateFile: join(compilerRoot, 'events.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'mcp/runtime-status',
    });
    childPid = Number(await readWhenPresent(marker));
    const result = await invocation.completed;

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    expect(result.stderr).toContain('Flight exceeded');
    await waitFor(() => !isProcessAlive(childPid as number), 'RSC child remained alive after Flight overflow');
  } finally {
    invocation?.child.kill('SIGKILL');
    if (childPid !== undefined && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
    await rm(compilerRoot, { force: true, recursive: true });
  }
}, 6_000);

test('forwards dev invocation termination through a SIGKILL cleanup of its RSC child', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  let childPid: number | undefined;
  let invocation: ReturnType<typeof startInvocation> | undefined;
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    const marker = join(compilerRoot, 'rsc-child.pid');
    await writeFile(
      join(compilerRoot, 'rsc', 'rsc', 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);\n`,
    );
    invocation = startInvocation(entry, {
      stateFile: join(compilerRoot, 'events.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'mcp/runtime-status',
    });
    childPid = Number(await readWhenPresent(marker));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    invocation.child.kill('SIGTERM');
    const result = await invocation.completed;

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toEqual(Buffer.alloc(0));
    await waitFor(() => !isProcessAlive(childPid as number), 'RSC child remained alive after invocation termination');
  } finally {
    invocation?.child.kill('SIGKILL');
    if (childPid !== undefined && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
    await rm(compilerRoot, { force: true, recursive: true });
  }
}, 6_000);

test('runs an exact generation-contained hook invocation and retains its immutable Flight asset', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-'));
  const controller = new AbortController();
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-invocation-test',
    signal: controller.signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    await expect(session.invoke({
      expectedGenerationId: 'generation-that-does-not-exist',
      input: {},
      surfaceId: 'hook.claude',
      target: 'claude',
    })).rejects.toThrow('generation-that-does-not-exist');
    expect(session.runs(50)).toEqual([]);

    const run = await session.invoke({
      expectedGenerationId: generationId,
      input: {
        cwd: projectRoot,
        hook_event_name: 'PostToolUse',
        session_id: 'session-invocation-test',
        tool_input: { file_path: 'timeline.ts' },
        tool_name: 'Write',
        tool_use_id: 'native-event-1',
      },
      surfaceId: 'hook.claude',
      target: 'claude',
    });

    expect(run).toMatchObject({
      result: {
        flight: { downloadPath: `/api/runtime/runs/${encodeURIComponent(run.id)}/flight` },
        state: { identity: { stateStoreId: 'playground', stateVersion: 1 } },
      },
      status: 'succeeded',
      vector: { runtimeGenerationId: generationId, stateVersion: 1 },
    });
    const flight = await session.readRunFlight(run.id);
    expect(flight?.body.byteLength).toBeGreaterThan(0);
    expect(session.run(run.id)).toEqual(run);
    expect(session.runs(1)).toEqual([run]);
  } finally {
    await session.close();
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

test('closes the provider-owned invocation process group without orphaning its RSC grandchild', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-close-'));
  const controller = new AbortController();
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-close-test',
    signal: controller.signal,
    storageRoot,
  });
  let grandchildPid: number | undefined;

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const marker = join(storageRoot, 'rsc-invocation-grandchild.pid');
    const worker = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'rsc', 'index.js');
    await writeFile(worker, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)']);
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
process.on('SIGTERM', () => undefined);
setInterval(() => undefined, 1000);
`);

    const invocation = session.invoke({
      expectedGenerationId: generationId,
      input: {
        cwd: projectRoot,
        hook_event_name: 'PostToolUse',
        session_id: 'session-close-test',
        tool_input: { file_path: 'timeline.ts' },
        tool_name: 'Write',
        tool_use_id: 'native-event-close',
      },
      surfaceId: 'hook.claude',
      target: 'claude',
    });
    grandchildPid = Number(await readWhenPresent(marker));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    await session.close();
    await expect(invocation).resolves.toMatchObject({ status: 'failed' });
    await waitFor(() => !isProcessAlive(grandchildPid as number), 'RSC invocation grandchild remained alive after provider close');
    expect(session.run('any-run')).toBeUndefined();
    expect(session.runs(1)).toEqual([]);
    await expect(session.readRunFlight('any-run')).resolves.toBeUndefined();
    expect(() => readFileSync(join(storageRoot, 'runs'))).toThrow();
  } finally {
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

test('keeps the newest fifty immutable run artifacts and evicts the oldest completed Flight', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-history-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-history-test',
    signal: new AbortController().signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    const first = await session.invoke({
      expectedGenerationId: generationId,
      input: {},
      surfaceId: 'mcp.runtime_status',
      target,
    });
    if (first.status !== 'succeeded') throw new Error(JSON.stringify(first.diagnostics));
    const firstFlight = await session.readRunFlight(first.id);
    expect(firstFlight?.body.byteLength).toBeGreaterThan(0);
    await session.resetState({ expectedGenerationId: generationId, stateStoreId: 'playground' });
    expect(session.run(first.id)).toEqual(first);

    for (let index = 0; index < 50; index += 1) {
      const run = await session.invoke({
        expectedGenerationId: generationId,
        input: {},
        surfaceId: 'mcp.runtime_status',
        target,
      });
      expect(run.status).toBe('succeeded');
    }

    expect(session.run(first.id)).toBeUndefined();
    await expect(session.readRunFlight(first.id)).resolves.toBeUndefined();
    await expect(session.readRunFlight('../flight.bin')).resolves.toBeUndefined();
    expect(session.runs(50)).toHaveLength(50);
    expect(session.runs(50)[0]!.id).not.toBe(first.id);
    expect(await readdir(join(storageRoot, 'runs'))).toHaveLength(50);
  } finally {
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 45_000);

test('rejects a fifth blocked generation worker and settles every leased worker on close', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-bound-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-bound-test',
    signal: new AbortController().signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const marker = join(storageRoot, 'blocked-workers.txt');
    const worker = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'rsc', 'index.js');
    await writeFile(worker, `
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(marker)}, 'ready\\n');
process.on('SIGTERM', () => undefined);
setInterval(() => undefined, 1000);
`);
    const request = (id: string) => ({
      expectedGenerationId: generationId,
      input: {
        cwd: projectRoot,
        hook_event_name: 'PostToolUse',
        session_id: 'session-bound-test',
        tool_input: { file_path: 'timeline.ts' },
        tool_name: 'Write',
        tool_use_id: id,
      },
      surfaceId: 'hook.claude',
      target: 'claude',
    });
    const workers = ['one', 'two', 'three', 'four'].map((id) => session.invoke(request(id)));
    await waitFor(() => {
      try {
        return readFileSync(marker, 'utf8').trim().split('\n').length === 4;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }, 'Timed out waiting for four blocked invocation workers');
    await expect(session.invoke(request('five'))).rejects.toThrow('limit of 4 concurrent workers');
    await session.close();
    await expect(Promise.all(workers)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'failed' }),
    ]));
    expect(session.runs(1)).toEqual([]);
    expect(() => readFileSync(join(storageRoot, 'runs'))).toThrow();
  } finally {
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

test('contains invocation stdout, stderr, and timeout failures without retaining partial run artifacts', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-output-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-output-test',
    signal: new AbortController().signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    const entry = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'dev', 'invoke.js');
    const request = { expectedGenerationId: generationId, input: {}, surfaceId: 'mcp.runtime_status', target } as const;

    await writeFile(entry, `process.stdout.write('x'.repeat(${(4 * 1024 * 1024) + 1}));`);
    const stdout = await session.invoke(request);
    expect(stdout).toMatchObject({ diagnostics: [expect.objectContaining({ message: expect.stringContaining('stdout exceeded') })], status: 'failed' });

    await writeFile(entry, "process.stderr.write('credential=fixture-credential '.repeat(30000));");
    const stderr = await session.invoke(request);
    expect(stderr).toMatchObject({ diagnostics: [expect.objectContaining({ message: expect.stringContaining('stderr exceeded') })], status: 'failed' });
    if (stderr.status === 'failed') expect(stderr.diagnostics[0]!.message).not.toContain('fixture-credential');

    await writeFile(entry, "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);");
    const startedAt = Date.now();
    const timeout = await session.invoke(request);
    expect(timeout).toMatchObject({ diagnostics: [expect.objectContaining({ message: expect.stringContaining('exceeded 10000 ms') })], status: 'failed' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);
    expect(await readdir(join(storageRoot, 'runs'))).toEqual([]);
  } finally {
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 45_000);
