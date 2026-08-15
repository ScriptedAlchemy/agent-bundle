import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

import { serializeRuntimeDefinition } from '../src/build/serialize-definition.js';
import { runtimeDefinition } from '../src/definition.js';
import { createFileRuntimeKernel } from '../src/runtime/state-file.js';

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

const resourceUri = 'ui://rsc-agent-runtime/edit-timeline-v1.html';

const wait = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const startLockOwner = async (stateFile: string) => {
  const child = spawn(process.execPath, [join(process.cwd(), 'tests/fixtures/state-lock-owner.mjs'), stateFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').trim() === '{"ready":true}') {
        resolve();
        return;
      }
      reject(new Error(`Unexpected lock-owner output: ${chunk.toString('utf8')}`));
    });
  });
  return child;
};

const validEditRecord = (stateVersion: number, idempotencyKey: string) => ({
  event: {
    eventId: `event-${stateVersion}`,
    host: 'claude',
    path: `src/${stateVersion}.ts`,
    recordedAt: '2026-08-14T12:00:00.000Z',
    sessionId: 'session-1',
    toolName: 'Write',
  },
  idempotencyKey,
  kind: 'edit',
  stateVersion,
});

const containsFunction = (value: unknown): boolean => {
  if (typeof value === 'function') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(containsFunction);
  }

  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsFunction);
  }

  return false;
};

test('reads an edit recorded by another kernel instance', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const first = createFileRuntimeKernel({
    stateFile,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
    createId: () => 'edit-1',
  });
  const second = createFileRuntimeKernel({ stateFile });

  await first.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:other-kernel',
    path: 'src/runtime/state-file.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });

  expect(await second.readSnapshot()).toMatchObject({
    edits: [{ eventId: 'edit-1', host: 'claude', path: 'src/runtime/state-file.ts' }],
    stateVersion: 1,
  });
});

test('limits snapshots to the newest valid edit events', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let nextId = 0;
  const kernel = createFileRuntimeKernel({
    stateFile,
    createId: () => `edit-${++nextId}`,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  });

  await kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:limit-1',
    path: 'first.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });
  await kernel.recordEdit({
    host: 'codex',
    idempotencyKey: 'test:state:limit-2',
    path: 'second.ts',
    sessionId: 'session-1',
    toolName: 'apply_patch',
  });
  await kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:limit-3',
    path: 'third.ts',
    sessionId: 'session-1',
    toolName: 'Edit',
  });

  await expect(kernel.readSnapshot({ limit: 0 })).rejects.toThrow(RangeError);
  await expect(kernel.readSnapshot({ limit: 51 })).rejects.toThrow(RangeError);
  await expect(kernel.readSnapshot({ limit: 1.5 })).rejects.toThrow(RangeError);
  await expect(kernel.readSnapshot({ limit: 2 })).resolves.toMatchObject({
    edits: [{ eventId: 'edit-2' }, { eventId: 'edit-3' }],
    stateVersion: 3,
  });
});

test('ignores one trailing partial JSONL record', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const kernel = createFileRuntimeKernel({ stateFile, createId: () => 'complete-edit' });

  await kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:partial',
    path: 'complete.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });
  await appendFile(stateFile, '{"eventId":"partial"', 'utf8');

  await expect(kernel.readSnapshot()).resolves.toMatchObject({
    edits: [{ eventId: 'complete-edit', path: 'complete.ts' }],
    stateVersion: 1,
  });
});

test('deduplicates identical state edits and rejects conflicting idempotency-key reuse', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const first = createFileRuntimeKernel({
    stateFile,
    createId: () => 'first-event',
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  });
  const second = createFileRuntimeKernel({
    stateFile,
    createId: () => 'second-event',
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  });
  const edit = {
    host: 'claude' as const,
    idempotencyKey: 'claude:tool:tool-1',
    path: 'src/first.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  };

  const [firstSnapshot, secondSnapshot] = await Promise.all([first.recordEdit(edit), second.recordEdit(edit)]);
  expect(firstSnapshot.stateVersion).toBe(1);
  expect(secondSnapshot.stateVersion).toBe(1);
  expect((await readFile(stateFile, 'utf8')).trim().split('\n')).toHaveLength(1);
  expect(JSON.parse((await readFile(stateFile, 'utf8')).trim())).toMatchObject({
    idempotencyKey: 'claude:tool:tool-1',
    kind: 'edit',
    stateVersion: 1,
  });

  await expect(second.recordEdit({ ...edit, path: 'src/conflict.ts' })).rejects.toThrow(
    'idempotency key claude:tool:tool-1',
  );
});

test('appends reset records without resetting the monotonic durable version', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const kernel = createFileRuntimeKernel({
    stateFile,
    createId: () => 'event-1',
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  });

  await kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:before-reset',
    path: 'src/before-reset.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });
  const reset = await kernel.resetState({ idempotencyKey: 'test:state:reset-1', seed: { reason: 'test' } });

  expect(reset).toEqual({ edits: [], stateVersion: 2 });
  const records = (await readFile(stateFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(records).toMatchObject([
    { kind: 'edit', stateVersion: 1 },
    { idempotencyKey: 'test:state:reset-1', kind: 'reset', seed: { reason: 'test' }, stateVersion: 2 },
  ]);
  expect(await createFileRuntimeKernel({ stateFile }).readSnapshot()).toEqual({ edits: [], stateVersion: 2 });
});

test('rejects terminated JSONL corruption while preserving only an incomplete final tail for recovery', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const kernel = createFileRuntimeKernel({ stateFile, createId: () => 'complete-edit' });
  await kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:complete',
    path: 'complete.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });

  await appendFile(stateFile, '{"broken":true}\n', 'utf8');
  await expect(kernel.readSnapshot()).rejects.toThrow('Runtime state corruption');

  const recoverableStateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'recoverable.jsonl');
  const recoverable = createFileRuntimeKernel({ stateFile: recoverableStateFile, createId: () => 'recovered-edit' });
  await recoverable.recordEdit({
    host: 'codex',
    idempotencyKey: 'test:state:before-tail',
    path: 'first.ts',
    sessionId: 'session-1',
    toolName: 'apply_patch',
  });
  await appendFile(recoverableStateFile, '{"truncated"', 'utf8');
  await expect(
    recoverable.recordEdit({
      host: 'codex',
      idempotencyKey: 'test:state:after-tail',
      path: 'second.ts',
      sessionId: 'session-1',
      toolName: 'apply_patch',
    }),
  ).resolves.toMatchObject({ stateVersion: 2 });
  await expect(recoverable.readSnapshot()).resolves.toMatchObject({
    edits: [{ path: 'first.ts' }, { path: 'second.ts' }],
    stateVersion: 2,
  });
});

test('rejects malformed middle records and non-monotonic durable versions', async () => {
  const middleStateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'middle.jsonl');
  await writeFile(middleStateFile, `${JSON.stringify(validEditRecord(1, 'test:state:first'))}\n{"invalid":true}\n`, 'utf8');
  await expect(createFileRuntimeKernel({ stateFile: middleStateFile }).readSnapshot()).rejects.toThrow('Runtime state corruption');

  const versionStateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'version.jsonl');
  await writeFile(
    versionStateFile,
    `${JSON.stringify(validEditRecord(1, 'test:state:first'))}\n${JSON.stringify(validEditRecord(1, 'test:state:second'))}\n`,
    'utf8',
  );
  await expect(createFileRuntimeKernel({ stateFile: versionStateFile }).readSnapshot()).rejects.toThrow('monotonic state version');
});

test('excludes a live heartbeat owner and recovers its stale lock only after SIGKILL', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  await writeFile(stateFile, '', 'utf8');
  const owner = await startLockOwner(stateFile);
  try {
    const lockDirectory = `${stateFile}.lock`;
    const firstMtime = (await stat(lockDirectory)).mtimeMs;
    await wait(1_100);
    expect((await stat(lockDirectory)).mtimeMs).toBeGreaterThan(firstMtime);

    const aborted = new AbortController();
    setTimeout(() => aborted.abort(new Error('test abort')), 50);
    await expect(
      createFileRuntimeKernel({
        stateFile,
        testOnlyLockTiming: { staleMs: 2_000, updateMs: 1_000 },
      }).recordEdit(
        {
          host: 'claude',
          idempotencyKey: 'test:state:live-owner',
          path: 'live-owner.ts',
          sessionId: 'session-1',
          toolName: 'Write',
        },
        { lockAcquireTimeoutMs: 500, signal: aborted.signal },
      ),
    ).rejects.toThrow('test abort');

    owner.kill('SIGKILL');
    await new Promise<void>((resolve) => owner.once('close', () => resolve()));
    await wait(2_100);
    await expect(
      createFileRuntimeKernel({ stateFile, testOnlyLockTiming: { staleMs: 2_000, updateMs: 1_000 } }).recordEdit({
        host: 'codex',
        idempotencyKey: 'test:state:stale-recovery',
        path: 'recovered.ts',
        sessionId: 'session-1',
        toolName: 'apply_patch',
      }),
    ).resolves.toMatchObject({ stateVersion: 1 });
  } finally {
    owner.kill('SIGKILL');
  }
});

test('poisons a kernel after lease compromise before it can append or mutate again', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let entered!: () => void;
  let continueAppend!: () => void;
  const enteredBeforeAppend = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const allowAppend = new Promise<void>((resolve) => {
    continueAppend = resolve;
  });
  const kernel = createFileRuntimeKernel({
    stateFile,
    testOnlyBeforeAppend: async () => {
      entered();
      await allowAppend;
    },
    testOnlyLockTiming: { staleMs: 2_000, updateMs: 1_000 },
  });
  const pending = kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:compromised',
    path: 'compromised.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });
  await Promise.race([
    enteredBeforeAppend,
    wait(100).then(() => Promise.reject(new Error('test-only append barrier was not reached'))),
  ]);
  await rm(`${stateFile}.lock`, { force: true, recursive: true });
  await wait(1_100);
  continueAppend();
  await expect(pending).rejects.toThrow('permanently poisoned');
  await expect(
    kernel.recordEdit({
      host: 'claude',
      idempotencyKey: 'test:state:after-compromise',
      path: 'after-compromise.ts',
      sessionId: 'session-1',
      toolName: 'Write',
    }),
  ).rejects.toThrow('permanently poisoned');
  await expect(readFile(stateFile, 'utf8')).resolves.toBe('');
});

test('treats a valid empty JSONL file as an empty snapshot', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  await writeFile(stateFile, '', 'utf8');

  await expect(createFileRuntimeKernel({ stateFile }).readSnapshot()).resolves.toEqual({
    edits: [],
    stateVersion: 0,
  });
});

test('exposes the static MCP tools, native hooks, and app resource contract', () => {
  expect(runtimeDefinition.tools.map((tool) => tool.name)).toEqual([
    'recent_edits',
    'render_edit_timeline',
    'runtime_status',
  ]);
  expect(runtimeDefinition.nativeHooks.map((hook) => hook.matcher)).toEqual([
    'Write|Edit',
    'apply_patch',
  ]);
  expect(runtimeDefinition.resources).toMatchObject([
    {
      _meta: {
        'openai/widgetDescription': 'Interactive timeline of file edits recorded by agent hooks.',
        'ui.csp': { connectDomains: [], resourceDomains: [] },
        'ui.prefersBorder': true,
      },
      uri: resourceUri,
    },
  ]);
  expect(runtimeDefinition.tools.map((tool) => tool.annotations)).toEqual([
    readOnlyAnnotations,
    readOnlyAnnotations,
    readOnlyAnnotations,
  ]);

  for (const tool of runtimeDefinition.tools) {
    const metadata = tool._meta as { ui?: { resourceUri?: string }; 'openai/outputTemplate'?: string };

    if (tool.name === 'render_edit_timeline') {
      expect(metadata.ui?.resourceUri).toBe(resourceUri);
      expect(metadata['openai/outputTemplate']).toBe(resourceUri);
    } else {
      expect(metadata.ui?.resourceUri).toBeUndefined();
      expect(metadata['openai/outputTemplate']).toBeUndefined();
    }
  }
});

test('serializes the registry into JSON Schema descriptors without functions', () => {
  const serialized = serializeRuntimeDefinition();

  expect(containsFunction(serialized)).toBe(false);
  expect(serialized.tools).toHaveLength(3);
  for (const tool of serialized.tools) {
    expect(tool.inputSchema).toEqual(expect.any(Object));
    expect(tool.outputSchema).toEqual(expect.any(Object));
    expect(tool.inputSchema.$schema).toBeUndefined();
    expect(tool.outputSchema.$schema).toBeUndefined();
  }
});
