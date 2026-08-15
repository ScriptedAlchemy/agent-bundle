import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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

const windowsTest = process.platform === 'win32' ? test : test.skip;

const exampleRoot = process.cwd();
const workspaceNodeModules = join(exampleRoot, '../../node_modules');

const copyExample = async (): Promise<Readonly<{ readonly projectRoot: string; readonly workspaceRoot: string }>> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invocation-copy-'));
  const projectRoot = join(workspaceRoot, 'examples', 'rsc-agent-runtime');
  await cp(exampleRoot, projectRoot, {
    filter: (source) => !['.agent-bundle', 'dist', 'node_modules'].includes(source.split('/').at(-1) ?? ''),
    recursive: true,
  });
  await symlink(workspaceNodeModules, join(workspaceRoot, 'node_modules'), 'dir');
  await symlink(join(exampleRoot, '../../tsconfig.json'), join(workspaceRoot, 'tsconfig.json'));
  return Object.freeze({ projectRoot, workspaceRoot });
};

const startInvocation = (entry: string, request: Record<string, unknown>) => {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const flight = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
  if (flight === null || flight === undefined) throw new Error('Invocation worker Flight stream is unavailable.');
  child.stdin.end(JSON.stringify(request));

  const completed = Promise.all([
    readChildOutput(flight),
    readChildOutput(child.stdout),
    readChildOutput(child.stderr),
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }),
  ]).then(([flight, stdout, stderr, exitCode]) => ({ exitCode, flight, stderr: stderr.toString('utf8'), stdout }));

  return { child, completed };
};

test('streams a raw Flight payload separately from its bounded inspection response', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    const flightBytes = 3 * 1024 * 1024;
    await writeFile(entry, `
const { writeSync } = require('node:fs');
writeSync(3, Buffer.alloc(${flightBytes}, 120));
process.stdout.end(JSON.stringify({
  flightBytes: ${flightBytes},
  inspection: {
    flight: { bytes: ${flightBytes}, preview: '', truncated: true },
    state: { identity: { stateStoreId: 'fixture-state', stateVersion: 0 } },
    trace: [],
    tree: [],
  },
}) + '\\n');
`);
    const result = await invoke(entry, {
      stateFile: join(compilerRoot, 'events.jsonl'),
      stateStoreId: 'fixture-state',
      type: 'mcp/runtime-status',
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.flight.byteLength).toBe(flightBytes);
    expect(result.flight.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.stdout.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(JSON.parse(result.stdout.toString('utf8'))).toMatchObject({
      flightBytes: result.flight.byteLength,
      inspection: expect.any(Object),
    });
  } finally {
    await rm(compilerRoot, { force: true, recursive: true });
  }
}, 30_000);

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
      flightBytes: number;
      inspection: Record<string, unknown>;
    };
    const secondResult = JSON.parse(second.stdout.toString('utf8')) as typeof firstResult;
    expect(inspectionShape(secondResult)).toEqual(inspectionShape(firstResult));
    expect(firstResult.flightBytes).toBe(first.flight.byteLength);
    expect(secondResult.flightBytes).toBe(second.flight.byteLength);
    expect(first.flight.byteLength).toBeGreaterThan(0);
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

test('caps inspection stdout independently after Flight leaves its response envelope', async () => {
  const compilerRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-invoke-'));
  try {
    const entry = await buildInvocationEntry(compilerRoot);
    await writeFile(join(compilerRoot, 'rsc', 'rsc', 'index.js'), oversizedMcpWorker(2_100_000));
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
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => undefined); process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => undefined, 1_000);\n`,
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
      input: {
        cwd: projectRoot,
        hook_event_name: 'PostToolUse',
        session_id: 'session-invocation-test',
        tool_input: { file_path: 'timeline.ts' },
        tool_name: 'Write',
        tool_use_id: 'missing-generation',
      },
      surfaceId: 'hook.claude',
      target: 'claude',
    })).rejects.toThrow('generation-that-does-not-exist');
    expect(session.runs(50)).toEqual([]);

    await expect(session.invoke({
      expectedGenerationId: generationId,
      input: {
        cwd: projectRoot,
        hook_event_name: 'PostToolUse',
        session_id: 'session-invocation-test',
        tool_input: { file_path: 'timeline.ts' },
        tool_name: 'Write',
      },
      surfaceId: 'hook.claude',
      target: 'claude',
    })).rejects.toThrow('tool_use_id or event_id');
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

    const replacedRunDirectory = join(storageRoot, 'replaced-run-directory');
    await mkdir(replacedRunDirectory);
    await writeFile(join(replacedRunDirectory, 'flight.bin'), 'untrusted Flight');
    const trustedFlight = flight!.body;
    await rm(join(storageRoot, 'runs', run.id), { force: true, recursive: true });
    await symlink(replacedRunDirectory, join(storageRoot, 'runs', run.id), 'dir');
    const afterSwap = await session.readRunFlight(run.id);
    expect(afterSwap?.body).toEqual(trustedFlight);
    expect(afterSwap?.body).not.toEqual(Buffer.from('untrusted Flight'));
  } finally {
    await session.close();
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

test('does not spawn an invocation worker when runtime.run.started closes the session', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-started-close-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  let close: Promise<void> | undefined;
  const startedAt = Date.now();
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: (event) => {
      if (event.type === 'runtime.run.started') close ??= session.close();
    },
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-started-close-test',
    signal: new AbortController().signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const marker = join(storageRoot, 'worker-spawned-after-close');
    const entry = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'dev', 'invoke.js');
    await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;

    await expect(session.invoke({ expectedGenerationId: generationId, input: {}, surfaceId: 'mcp.runtime_status', target }))
      .resolves.toMatchObject({ status: 'failed' });
    await close;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(() => readFileSync(marker)).toThrow();
  } finally {
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

test('refuses to adopt an existing or symbolic provider run root', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-run-root-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const external = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-external-runs-'));
  await symlink(external, join(storageRoot, 'runs'), 'dir');

  try {
    await expect(createDevRuntimeProvider().start({
      artifactStatus: () => Object.freeze({ state: 'missing' as const }),
      emit: () => undefined,
      environment: Object.freeze({}),
      projectRoot,
      preparedRuntime: prepared.devRuntime!,
      providerSessionId: 'session-run-root-test',
      signal: new AbortController().signal,
      storageRoot,
    })).rejects.toThrow('invocation root already exists');
    expect(await readdir(external)).toEqual([]);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(external, { force: true, recursive: true });
  }
}, 30_000);

test('refreshes a failed run vector after its generation-contained hook mutates durable state', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-failed-vector-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-failed-vector-test',
    signal: new AbortController().signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const entry = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'dev', 'invoke.js');
    const original = `${entry}.original`;
    await rename(entry, original);
    await writeFile(entry, `
process.stdout.write = () => { process.exitCode = 1; return true; };
require(${JSON.stringify(original)});
`);

    const run = await session.invoke({
      expectedGenerationId: generationId,
      input: {
        cwd: projectRoot,
        hook_event_name: 'PostToolUse',
        session_id: 'session-failed-vector-test',
        tool_input: { file_path: 'failed-vector.ts' },
        tool_name: 'Write',
        tool_use_id: 'failed-vector-hook',
      },
      surfaceId: 'hook.claude',
      target: 'claude',
    });

    expect(run).toMatchObject({ status: 'failed', vector: { runtimeGenerationId: generationId, stateVersion: 1 } });
  } finally {
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

test('pins an overlapping g1 invocation while exact replay stays on g1 and latest replay advances to g2', async () => {
  const copied = await copyExample();
  const storageRoot = join(copied.workspaceRoot, 'runtime-storage');
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot: copied.projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-generation-pinning-test',
    signal: new AbortController().signal,
    storageRoot,
  });
  let blocked: Promise<unknown> | undefined;

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const g1 = session.status().activeVector!.runtimeGenerationId;
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    const completedG1 = await session.invoke({ expectedGenerationId: g1, input: {}, surfaceId: 'mcp.runtime_status', target });
    expect(completedG1).toMatchObject({ status: 'succeeded', vector: { runtimeGenerationId: g1 } });

    const g1Worker = join(storageRoot, 'generation-store', 'generations', g1, 'rsc', 'rsc', 'index.js');
    const originalG1Worker = await readFile(g1Worker);
    const marker = join(storageRoot, 'g1-blocked-worker.txt');
    await writeFile(g1Worker, `
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');
process.on('SIGTERM', () => undefined);
setInterval(() => undefined, 1_000);
`);
    blocked = session.invoke({ expectedGenerationId: g1, input: {}, surfaceId: 'mcp.runtime_status', target });
    await readWhenPresent(marker);

    const workerSource = join(copied.projectRoot, 'src', 'rsc', 'worker.tsx');
    const source = await readFile(workerSource, 'utf8');
    await writeFile(workerSource, source.replace('RSC worker received an invalid event', 'RSC worker received an invalid event generation-two'));
    await waitFor(() => session.status().activeVector?.runtimeGenerationId !== g1, 'Timed out waiting for generation two');
    const g2 = session.status().activeVector!.runtimeGenerationId;
    await writeFile(g1Worker, originalG1Worker);

    const exact = await session.replay({ expectedGenerationId: g1, mode: 'exact', runId: completedG1.id });
    const latest = await session.replay({ expectedGenerationId: g2, mode: 'latest', runId: completedG1.id });
    expect(exact).toMatchObject({ status: 'succeeded', vector: { runtimeGenerationId: g1 } });
    expect(latest).toMatchObject({ status: 'succeeded', vector: { runtimeGenerationId: g2 } });
  } finally {
    await session.close().catch(() => undefined);
    await blocked?.catch(() => undefined);
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 60_000);

test('replays an exact historical surface after generation two removes it', async () => {
  const copied = await copyExample();
  const storageRoot = join(copied.workspaceRoot, 'runtime-storage');
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot: copied.projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-historical-surface-test',
    signal: new AbortController().signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const g1 = session.status().activeVector!.runtimeGenerationId;
    const run = await session.invoke({
      expectedGenerationId: g1,
      input: {
        cwd: copied.projectRoot,
        hook_event_name: 'PostToolUse',
        session_id: 'session-historical-surface-test',
        tool_input: { file_path: 'g1.ts' },
        tool_name: 'Write',
        tool_use_id: 'historical-surface',
      },
      surfaceId: 'hook.claude',
      target: 'claude',
    });
    expect(run).toMatchObject({ status: 'succeeded', vector: { runtimeGenerationId: g1 } });

    const definition = join(copied.projectRoot, 'src', 'definition.ts');
    const source = await readFile(definition, 'utf8');
    await writeFile(definition, source.replace("      host: 'claude',", "      host: 'codex',"));
    await waitFor(() => session.status().activeVector?.runtimeGenerationId !== g1, 'Timed out waiting for generation two');
    const g2 = session.status().activeVector!.runtimeGenerationId;

    await expect(session.replay({ expectedGenerationId: g1, mode: 'exact', runId: run.id }))
      .resolves.toMatchObject({ status: 'succeeded', vector: { runtimeGenerationId: g1 } });
    await expect(session.replay({ expectedGenerationId: g2, mode: 'latest', runId: run.id }))
      .rejects.toThrow('does not exist');
  } finally {
    await session.close().catch(() => undefined);
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 60_000);

test('releases an exact historical lease when four active workers reject its admission', async () => {
  const copied = await copyExample();
  const storageRoot = join(copied.projectRoot, '.agent-bundle', 'runtime-exact-lease-capacity');
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: copied.projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot: copied.projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-exact-lease-capacity',
    signal: new AbortController().signal,
    storageRoot,
  });

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const g1 = session.status().activeVector!.runtimeGenerationId;
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    const historical = await session.invoke({ expectedGenerationId: g1, input: {}, surfaceId: 'mcp.runtime_status', target });
    expect(historical).toMatchObject({ status: 'succeeded', vector: { runtimeGenerationId: g1 } });

    const definition = join(copied.projectRoot, 'src', 'definition.ts');
    await appendFile(definition, '\n// exact-lease-capacity-g2\n');
    await waitFor(() => session.status().activeVector?.runtimeGenerationId !== g1, 'Timed out waiting for generation two');
    const g2 = session.status().activeVector!.runtimeGenerationId;
    const marker = join(storageRoot, 'blocked-exact-lease-workers.txt');
    const worker = join(storageRoot, 'generation-store', 'generations', g2, 'rsc', 'rsc', 'index.js');
    await writeFile(worker, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'ready\\n');
setTimeout(() => process.exit(0), 1_000);
`);
    const workers = Array.from({ length: 4 }, () => session.invoke({
      expectedGenerationId: g2,
      input: {},
      surfaceId: 'mcp.runtime_status',
      target,
    }));
    await waitFor(() => {
      try {
        return readFileSync(marker, 'utf8').trim().split('\n').length === 4;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }, 'Timed out waiting for four capacity workers');

    await expect(session.replay({ expectedGenerationId: g1, mode: 'exact', runId: historical.id }))
      .rejects.toThrow('limit of 4 concurrent workers');
    await Promise.all(workers);

    let active = g2;
    for (let generation = 3; generation <= 8; generation += 1) {
      await appendFile(definition, `// exact-lease-capacity-g${String(generation)}\\n`);
      await waitFor(() => session.status().activeVector?.runtimeGenerationId !== active, `Timed out waiting for generation ${String(generation)}`, 15_000);
      active = session.status().activeVector!.runtimeGenerationId;
    }
    await waitFor(() => !existsSync(join(storageRoot, 'generation-store', 'generations', g1)), 'Exact replay leaked generation one after capacity rejection', 15_000);
  } finally {
    await session.close().catch(() => undefined);
    await rm(copied.workspaceRoot, { force: true, recursive: true });
  }
}, 90_000);

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

test('hard-kills the invocation process group when its leader exits before an RSC grandchild', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-leader-exit-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-leader-exit-test',
    signal: new AbortController().signal,
    storageRoot,
  });
  let grandchildPid: number | undefined;

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const marker = join(storageRoot, 'rsc-invocation-leader-exit-grandchild.pid');
    const worker = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'rsc', 'index.js');
    await writeFile(worker, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
process.exit(0);
`);
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    const run = await session.invoke({ expectedGenerationId: generationId, input: {}, surfaceId: 'mcp.runtime_status', target });
    grandchildPid = Number(await readWhenPresent(marker));

    expect(run).toMatchObject({ status: 'failed' });
    await waitFor(() => !isProcessAlive(grandchildPid as number), 'RSC grandchild remained alive after invocation leader exit');
  } finally {
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

test('settles a successful invocation only after its TERM-resistant RSC grandchild exits', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-success-tree-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-success-tree-test',
    signal: new AbortController().signal,
    storageRoot,
  });
  let grandchildPid: number | undefined;

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const marker = join(storageRoot, 'rsc-invocation-success-grandchild.pid');
    const entry = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'dev', 'invoke.js');
    await writeFile(entry, `
const { spawn } = require('node:child_process');
const { writeFileSync, writeSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
child.unref();
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
writeSync(3, Buffer.from('x'));
process.stdout.end(JSON.stringify({
  flightBytes: 1,
  inspection: {
    flight: { bytes: 1, preview: 'eA==', truncated: false },
    modelVisible: [],
    protocol: [],
    state: { identity: { stateStoreId: 'playground', stateVersion: 0 } },
    trace: [],
    tree: [],
  },
}) + '\\n');
`);
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    const run = await session.invoke({ expectedGenerationId: generationId, input: {}, surfaceId: 'mcp.runtime_status', target });
    grandchildPid = Number(await readWhenPresent(marker));

    expect(run).toMatchObject({ status: 'succeeded' });
    await waitFor(() => !isProcessAlive(grandchildPid as number), 'RSC invocation grandchild remained alive after successful invocation');
  } finally {
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

windowsTest('keeps a detached successful worker grandchild in its Windows Job Object until it dies', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-session-windows-job-'));
  const projectRoot = process.cwd();
  const prepared = await new ProjectService({ includeDevRuntime: true, mode: 'development', root: projectRoot }).prepare('dev');
  const session = await createDevRuntimeProvider().start({
    artifactStatus: () => Object.freeze({ state: 'missing' as const }),
    emit: () => undefined,
    environment: Object.freeze({}),
    projectRoot,
    preparedRuntime: prepared.devRuntime!,
    providerSessionId: 'session-windows-job-test',
    signal: new AbortController().signal,
    storageRoot,
  });
  let grandchildPid: number | undefined;

  try {
    await waitFor(() => session.status().activeVector !== undefined, 'Timed out waiting for an active runtime generation', 15_000);
    const generationId = session.status().activeVector!.runtimeGenerationId;
    const marker = join(storageRoot, 'rsc-invocation-windows-job-grandchild.pid');
    const entry = join(storageRoot, 'generation-store', 'generations', generationId, 'rsc', 'dev', 'invoke.js');
    await writeFile(entry, `
const { spawn } = require('node:child_process');
const { writeFileSync, writeSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)'], { detached: true, stdio: 'ignore' });
child.unref();
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
writeSync(3, Buffer.from('x'));
process.stdout.end(JSON.stringify({
  flightBytes: 1,
  inspection: {
    flight: { bytes: 1, preview: 'eA==', truncated: false },
    modelVisible: [],
    protocol: [],
    state: { identity: { stateStoreId: 'playground', stateVersion: 0 } },
    trace: [],
    tree: [],
  },
}) + '\\n');
`);
    const target = session.surfaces().find((surface) => surface.id === 'mcp.runtime_status')!.targets[0]!;
    const run = await session.invoke({ expectedGenerationId: generationId, input: {}, surfaceId: 'mcp.runtime_status', target });
    grandchildPid = Number(await readWhenPresent(marker));

    expect(run).toMatchObject({ status: 'succeeded' });
    const flight = await session.readRunFlight(run.id);
    expect(flight?.body).toEqual(Buffer.from('x'));
    await waitFor(() => !isProcessAlive(grandchildPid as number), 'Windows Job Object left a detached RSC grandchild alive after invocation');
    await session.close();
    expect(isProcessAlive(grandchildPid as number)).toBe(false);
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
    expect((await readdir(join(storageRoot, 'runs'))).filter((entry) => entry !== '.agent-bundle-runtime-owner')).toHaveLength(50);
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
    const fifth = session.invoke(request('five'));
    await waitFor(() => {
      try {
        return readFileSync(marker, 'utf8').trim().split('\n').length >= 4;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }, 'Timed out waiting for four blocked invocation workers');
    await expect(fifth).rejects.toThrow('limit of 4 concurrent workers');
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(4);
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

    await writeFile(entry, `
require('node:fs').writeSync(3, Buffer.from('x'));
process.stdout.end(JSON.stringify({
  flightBytes: 1,
  inspection: {
    flight: { bytes: 1, preview: 'eA==', truncated: false },
    modelVisible: 'token=worker-response-secret',
    protocol: [],
    state: { identity: { stateStoreId: 'playground', stateVersion: 0 } },
    trace: [],
    tree: [],
  },
}) + '\\n');
`);
    const credential = await session.invoke(request);
    expect(credential).toMatchObject({ diagnostics: [expect.objectContaining({ message: expect.stringContaining('credentials') })], status: 'failed' });
    if (credential.status === 'failed') expect(credential.diagnostics[0]!.message).not.toContain('worker-response-secret');

    const malformed = async (inspection: Record<string, unknown>) => {
      await writeFile(entry, `
require('node:fs').writeSync(3, Buffer.from('x'));
process.stdout.end(${JSON.stringify(`${JSON.stringify({ flightBytes: 1, inspection })}\n`)});
`);
      const run = await session.invoke(request);
      expect(run).toMatchObject({ status: 'failed' });
      await expect(session.readRunFlight(run.id)).resolves.toBeUndefined();
    };
    const validInspection = {
      flight: { bytes: 1, preview: 'eA==', truncated: false },
      modelVisible: [],
      protocol: [],
      state: { identity: { stateStoreId: 'playground', stateVersion: 0 } },
      trace: [],
      tree: [],
    };
    await malformed({ ...validInspection, tree: [{ children: {}, id: 'node', kind: 'element', label: 'bad' }] });
    await malformed({ ...validInspection, tree: [{ children: [], id: 'node', kind: 'element', label: 'bad', props: [] }] });
    await malformed({ ...validInspection, tree: [{ children: [], id: 'node', kind: 'element', label: 'bad', props: null }] });
    await malformed({ ...validInspection, trace: [{ id: '', phase: 'render', startedAt: 'not-a-date', status: 'unknown' }] });
    await malformed({ ...validInspection, trace: [{ details: null, id: 'trace', phase: 'render', startedAt: '2026-08-15T00:00:00.000Z', status: 'succeeded' }] });
    await malformed({ ...validInspection, trace: [{ details: [], id: 'trace', phase: 'render', startedAt: '2026-08-15T00:00:00.000Z', status: 'succeeded' }] });
    await malformed({ ...validInspection, app: { mcpBinding: {}, resourceUri: 'ui://unsafe', surfaceId: 'mcp.timeline' } });
    expect(await readdir(join(storageRoot, 'runs'))).toEqual(['.agent-bundle-runtime-owner']);
  } finally {
    await session.close().catch(() => undefined);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 45_000);
