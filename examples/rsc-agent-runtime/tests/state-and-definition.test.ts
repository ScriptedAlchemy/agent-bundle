import { access, appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';

import { serializeRuntimeDefinition } from '../src/build/serialize-definition.js';
import { runtimeDefinition } from '../src/definition.js';
import { createFileRuntimeKernel } from '../src/runtime/state-file.js';
import { createTestFileRuntimeKernel } from '../src/runtime/state-file-test-support.js';

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

const eagerPromise = <T>(value: T): Promise<T> => ({
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(onfulfilled === undefined || onfulfilled === null ? value as unknown as TResult1 : onfulfilled(value));
  },
}) as Promise<T>;

const startLockOwner = async (stateFile: string, timing: { stale: number; update: number } = { stale: 2_000, update: 1_000 }) => {
  const child = spawn(process.execPath, [
    join(process.cwd(), 'tests/fixtures/state-lock-owner.mjs'),
    stateFile,
    String(timing.stale),
    String(timing.update),
  ], {
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

  expect(reset).toEqual({ edits: [], seed: { reason: 'test' }, stateVersion: 2 });
  const records = (await readFile(stateFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(records).toMatchObject([
    { kind: 'edit', stateVersion: 1 },
    { idempotencyKey: 'test:state:reset-1', kind: 'reset', seed: { reason: 'test' }, stateVersion: 2 },
  ]);
  expect(await createFileRuntimeKernel({ stateFile }).readSnapshot()).toEqual({ edits: [], seed: { reason: 'test' }, stateVersion: 2 });
});

test('preserves reset seeds across immediate, idempotent, reopened, limited, and follow-up snapshots', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const seed = Object.freeze({
    cwd: '/tmp',
    hook_event_name: 'PostToolUse',
    session_id: 'fixture-seed-session',
    tool_input: Object.freeze({ file_path: 'fixture-seed.txt' }),
    tool_name: 'Write',
    tool_use_id: 'fixture-seed-tool',
  });
  const first = createFileRuntimeKernel({
    stateFile,
    createId: () => 'seed-follow-up-edit',
    now: () => new Date('2026-08-15T00:00:00.000Z'),
  });

  await first.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:seed-before-reset',
    path: 'before-reset.ts',
    sessionId: 'fixture-seed-session',
    toolName: 'Write',
  });
  const reset = await first.resetState({ idempotencyKey: 'test:state:seed-reset', seed });
  expect(reset).toEqual({ edits: [], seed, stateVersion: 2 });
  await expect(first.resetState({ idempotencyKey: 'test:state:seed-reset', seed })).resolves.toEqual(reset);

  const reopened = createFileRuntimeKernel({
    stateFile,
    createId: () => 'seed-follow-up-edit',
    now: () => new Date('2026-08-15T00:00:01.000Z'),
  });
  await expect(reopened.readSnapshot({ limit: 1 })).resolves.toEqual(reset);
  await expect(reopened.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:seed-follow-up',
    path: 'after-reset.ts',
    sessionId: 'fixture-seed-session',
    toolName: 'Write',
  })).resolves.toEqual({
    edits: [expect.objectContaining({ eventId: 'seed-follow-up-edit', path: 'after-reset.ts' })],
    seed,
    stateVersion: 3,
  });
  await expect(reopened.readSnapshot({ limit: 1 })).resolves.toEqual({
    edits: [expect.objectContaining({ eventId: 'seed-follow-up-edit', path: 'after-reset.ts' })],
    seed,
    stateVersion: 3,
  });
  await expect(reopened.resetState({
    idempotencyKey: 'test:state:seed-reset',
    seed: { ...seed, session_id: 'conflicting-seed-session' },
  })).rejects.toThrow('idempotency key test:state:seed-reset');
  await expect(reopened.resetState({ idempotencyKey: 'test:state:seed-clear' })).resolves.toEqual({ edits: [], stateVersion: 4 });
  await expect(createFileRuntimeKernel({ stateFile }).readSnapshot()).resolves.toEqual({ edits: [], stateVersion: 4 });
});

test('reconstructs an exact durable snapshot version through edits, resets, and idempotent replays', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const kernel = createFileRuntimeKernel({
    stateFile,
    createId: () => 'exact-version-edit',
    now: () => new Date('2026-08-15T01:00:00.000Z'),
  });
  const readExact = (stateVersion: number) => kernel.readSnapshot({ stateVersion });

  await kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:exact-before-reset',
    path: 'before-reset.ts',
    sessionId: 'exact-version-session',
    toolName: 'Write',
  });
  const seed = Object.freeze({ reason: 'exact-version-reset' });
  await kernel.resetState({ idempotencyKey: 'test:state:exact-reset', seed });
  const afterReset = await kernel.recordEdit({
    host: 'codex',
    idempotencyKey: 'test:state:exact-after-reset',
    path: 'after-reset.ts',
    sessionId: 'exact-version-session',
    toolName: 'apply_patch',
  });
  await expect(kernel.recordEdit({
    host: 'codex',
    idempotencyKey: 'test:state:exact-after-reset',
    path: 'after-reset.ts',
    sessionId: 'exact-version-session',
    toolName: 'apply_patch',
  })).resolves.toEqual(afterReset);

  await expect(readExact(0)).resolves.toEqual({ edits: [], stateVersion: 0 });
  await expect(readExact(1)).resolves.toMatchObject({
    edits: [expect.objectContaining({ path: 'before-reset.ts' })],
    stateVersion: 1,
  });
  await expect(readExact(2)).resolves.toEqual({ edits: [], seed, stateVersion: 2 });
  await expect(readExact(3)).resolves.toMatchObject({
    edits: [expect.objectContaining({ path: 'after-reset.ts' })],
    seed,
    stateVersion: 3,
  });
  await expect(readExact(4)).rejects.toThrow('state version 4 is unavailable');
  await expect(readExact(-1)).rejects.toThrow(RangeError);
  await expect(readExact(1.5)).rejects.toThrow(RangeError);
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
      createTestFileRuntimeKernel({ stateFile }).recordEdit(
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
      createTestFileRuntimeKernel({ stateFile }).recordEdit({
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

test('a non-production short-timing contender cannot steal a production lease', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  await writeFile(stateFile, '', 'utf8');
  const owner = await startLockOwner(stateFile, { stale: 30_000, update: 5_000 });
  try {
    const cancelled = new AbortController();
    setTimeout(() => cancelled.abort(new Error('short contender aborted')), 2_100);
    await expect(
      createTestFileRuntimeKernel({ stateFile }).recordEdit(
        {
          host: 'claude',
          idempotencyKey: 'test:state:short-contender',
          path: 'must-not-write.ts',
          sessionId: 'session-1',
          toolName: 'Write',
        },
        { lockAcquireTimeoutMs: 30_000, signal: cancelled.signal },
      ),
    ).rejects.toThrow('short contender aborted');
    await expect(readFile(stateFile, 'utf8')).resolves.toBe('');
  } finally {
    owner.kill('SIGTERM');
    await new Promise<void>((resolve) => owner.once('close', () => resolve()));
  }
});

test('releases a lease acquired after an expired absolute acquisition deadline', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let releases = 0;
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      prepareStateFile: async ({ stateFile: preparedStateFile }) => preparedStateFile,
      acquireLock: async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(async () => {
            releases += 1;
          }), 30);
        }),
    },
  });

  await expect(
    kernel.recordEdit(
      {
        host: 'claude',
        idempotencyKey: 'test:state:late-lock',
        path: 'late-lock.ts',
        sessionId: 'session-1',
        toolName: 'Write',
      },
      { lockAcquireTimeoutMs: 20 },
    ),
  ).rejects.toThrow('Timed out acquiring runtime state lease');
  await wait(60);
  expect(releases).toBe(1);
});

test('cancels a never-settling active phase at the hard critical-section deadline', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      beforeAppend: () => new Promise<void>(() => undefined),
      criticalSectionMs: 10,
    },
  });

  await expect(
    kernel.recordEdit({
      host: 'claude',
      idempotencyKey: 'test:state:never-settles',
      path: 'never-settles.ts',
      sessionId: 'session-1',
      toolName: 'Write',
    }),
  ).rejects.toThrow('did not settle within 100 ms after cancellation');
  await expect(readFile(stateFile, 'utf8')).resolves.toBe('');
});

test('exits promptly after a timed-out phase settles before its owner-settlement deadline', async () => {
  const buildRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-state-exit-build-'));
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-state-exit-')), 'state.jsonl');
  const rsbuild = await createRsbuild({
    config: {
      output: {
        distPath: { root: buildRoot },
        filename: { js: '[name].js' },
        target: 'node',
      },
      source: { entry: { fixture: './tests/fixtures/state-settlement-exit.ts' } },
    },
    cwd: process.cwd(),
  });
  const build = await rsbuild.build();
  const startedAt = Date.now();
  const child = spawn(process.execPath, [join(buildRoot, 'fixture.js'), stateFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const outcome = await Promise.race([
    new Promise<Readonly<{ exitCode: number | null; type: 'closed' }>>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve({ exitCode, type: 'closed' }));
    }),
    wait(500).then(() => ({ type: 'timeout' as const })),
  ]);
  if (outcome.type === 'timeout') child.kill('SIGKILL');
  await build.close();
  await rm(buildRoot, { force: true, recursive: true });

  expect(outcome.type).toBe('closed');
  if (outcome.type === 'closed') expect(outcome.exitCode).toBe(0);
  expect(stdout).toBe('phase-settled\n');
  expect(Date.now() - startedAt).toBeLessThan(500);
});

test('retains the lease until a timed-out mutation phase actually settles', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let entered!: () => void;
  let settle!: () => void;
  const phaseEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const phaseSettlement = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const first = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      beforeAppend: async () => {
        entered();
        await phaseSettlement;
      },
      criticalSectionMs: 20,
      ownerSettlementMs: 200,
    },
  });
  const second = createTestFileRuntimeKernel({ stateFile });

  const firstMutation = first.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:late-phase-owner',
    path: 'late-phase-owner.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });
  void firstMutation.catch(() => undefined);
  await phaseEntered;
  await wait(30);

  let contenderSettled = false;
  const contender = second.recordEdit(
    {
      host: 'codex',
      idempotencyKey: 'test:state:late-phase-contender',
      path: 'late-phase-contender.ts',
      sessionId: 'session-2',
      toolName: 'apply_patch',
    },
    { lockAcquireTimeoutMs: 500 },
  ).finally(() => {
    contenderSettled = true;
  });
  await wait(40);
  expect(contenderSettled).toBe(false);

  settle();
  await expect(firstMutation).rejects.toThrow('exceeded 20 ms critical-section limit');
  await expect(contender).resolves.toMatchObject({ stateVersion: 1 });
  const settledContents = await readFile(stateFile, 'utf8');
  await wait(30);
  expect(await readFile(stateFile, 'utf8')).toBe(settledContents);
  expect(settledContents).not.toContain('late-phase-owner.ts');
  expect(settledContents).toContain('late-phase-contender.ts');
});

for (const phase of ['truncate', 'append', 'fsync'] as const) {
  test(`does not unlock while a timed-out ${phase} phase is unsettled`, async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
    if (phase === 'truncate') {
      await writeFile(stateFile, '{"incomplete":true', 'utf8');
    }
    let entered!: () => void;
    let settle!: () => void;
    const phaseEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const phaseSettlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const barrier = async () => {
      entered();
      await phaseSettlement;
    };
    const first = createTestFileRuntimeKernel({
      stateFile,
      adapter: {
        ...(phase === 'truncate' ? { beforeRepair: barrier } : {}),
        ...(phase === 'append' ? { beforeAppendWrite: barrier } : {}),
        ...(phase === 'fsync' ? { beforeAppendSync: barrier } : {}),
        criticalSectionMs: 20,
        ownerSettlementMs: 200,
      },
    });
    const second = createTestFileRuntimeKernel({ stateFile });
    const firstMutation = first.recordEdit({
      host: 'claude',
      idempotencyKey: `test:state:${phase}-owner`,
      path: `${phase}-owner.ts`,
      sessionId: 'session-1',
      toolName: 'Write',
    });
    void firstMutation.catch(() => undefined);
    await phaseEntered;
    await wait(30);

    let contenderSettled = false;
    const contender = second.recordEdit(
      {
        host: 'codex',
        idempotencyKey: `test:state:${phase}-contender`,
        path: `${phase}-contender.ts`,
        sessionId: 'session-2',
        toolName: 'apply_patch',
      },
      { lockAcquireTimeoutMs: 500 },
    ).finally(() => {
      contenderSettled = true;
    });
    await wait(40);
    expect(contenderSettled).toBe(false);

    settle();
    await expect(firstMutation).rejects.toThrow('exceeded 20 ms critical-section limit');
    await expect(contender).resolves.toMatchObject({ stateVersion: phase === 'fsync' ? 2 : 1 });
    const contentsAtUnlock = await readFile(stateFile, 'utf8');
    await wait(30);
    expect(await readFile(stateFile, 'utf8')).toBe(contentsAtUnlock);
  });
}

test('keeps contenders excluded until a delayed release settles', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let releaseEntered!: () => void;
  let settleRelease!: () => void;
  const entered = new Promise<void>((resolve) => {
    releaseEntered = resolve;
  });
  const settlement = new Promise<void>((resolve) => {
    settleRelease = resolve;
  });
  const first = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      beforeRelease: async () => {
        releaseEntered();
        await settlement;
      },
      releaseMs: 200,
    },
  });
  const second = createTestFileRuntimeKernel({ stateFile });
  const firstMutation = first.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:delayed-release-owner',
    path: 'release-owner.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });
  await entered;
  let contenderSettled = false;
  const contender = second.recordEdit(
    {
      host: 'codex',
      idempotencyKey: 'test:state:delayed-release-contender',
      path: 'release-contender.ts',
      sessionId: 'session-2',
      toolName: 'apply_patch',
    },
    { lockAcquireTimeoutMs: 500 },
  ).finally(() => {
    contenderSettled = true;
  });
  await wait(40);
  expect(contenderSettled).toBe(false);
  settleRelease();
  await expect(firstMutation).resolves.toMatchObject({ stateVersion: 1 });
  await expect(contender).resolves.toMatchObject({ stateVersion: 2 });
});

test('bounds a stuck release and invokes fatal owner teardown without unlocking', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let fatalError: Error | undefined;
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      acquireLock: async () => async () => new Promise<void>(() => undefined),
      criticalSectionMs: 20,
      fatalOwnerTeardown: (error) => {
        fatalError = error;
      },
      prepareStateFile: async ({ stateFile: preparedStateFile }) => {
        await writeFile(preparedStateFile, '', 'utf8');
        return preparedStateFile;
      },
      releaseMs: 20,
    },
  });

  const outcome = await Promise.race([
    kernel.recordEdit({
      host: 'claude',
      idempotencyKey: 'test:state:stuck-release',
      path: 'stuck-release.ts',
      sessionId: 'session-1',
      toolName: 'Write',
    }).then(() => 'resolved', (error: unknown) => error),
    wait(200).then(() => 'test-timeout'),
  ]);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain('lease release exceeded 20 ms');
  expect(fatalError?.message).toContain('lease release exceeded 20 ms');
  await expect(
    kernel.recordEdit({
      host: 'codex',
      idempotencyKey: 'test:state:after-stuck-release',
      path: 'after-stuck-release.ts',
      sessionId: 'session-2',
      toolName: 'apply_patch',
    }),
  ).rejects.toThrow('permanently poisoned');
});

test('lease compromise cancels its owning mutation while a contender is acquiring', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let allowRead!: () => void;
  let compromiseOwner!: (error: Error) => void;
  let firstRead = true;
  let acquireCount = 0;
  const readBarrier = new Promise<void>((resolve) => {
    allowRead = resolve;
  });
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      acquireLock: async ({ onCompromised }) => {
        acquireCount += 1;
        if (acquireCount === 1) {
          compromiseOwner = onCompromised;
          return async () => undefined;
        }
        return new Promise(() => undefined);
      },
      beforeRead: async () => {
        if (firstRead) {
          firstRead = false;
          await readBarrier;
        }
      },
      criticalSectionMs: 500,
      prepareStateFile: async ({ stateFile: preparedStateFile }) => {
        await writeFile(preparedStateFile, '', 'utf8');
        return preparedStateFile;
      },
    },
  });
  const first = kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:compromise-owner-a',
    path: 'owner-a.ts',
    sessionId: 'session-a',
    toolName: 'Write',
  });
  void first.catch(() => undefined);
  await wait(10);
  const second = kernel.recordEdit(
    {
      host: 'codex',
      idempotencyKey: 'test:state:compromise-contender-b',
      path: 'contender-b.ts',
      sessionId: 'session-b',
      toolName: 'apply_patch',
    },
    { lockAcquireTimeoutMs: 500 },
  );
  void second.catch(() => undefined);
  await wait(10);
  compromiseOwner(new Error('simulated owner compromise'));

  const firstOutcome = await Promise.race([
    first.then(() => 'resolved', (error: unknown) => error),
    wait(100).then(() => 'test-timeout'),
  ]);
  expect(firstOutcome).toBeInstanceOf(Error);
  expect((firstOutcome as Error).message).toContain('permanently poisoned');
  await expect(second).rejects.toThrow('permanently poisoned');
  await expect(readFile(stateFile, 'utf8')).resolves.toBe('');
  allowRead();
});

test('rechecks a simultaneous owner abort after a phase value wins and releases exactly once', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const controller = new AbortController();
  let appendAttempts = 0;
  let releases = 0;
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      acquireLock: async () => async () => {
        releases += 1;
      },
      beforeAppend: async () => {
        appendAttempts += 1;
      },
      prepareStateFile: async ({ stateFile: preparedStateFile }) => {
        await writeFile(preparedStateFile, '', 'utf8');
        return preparedStateFile;
      },
      readState: () => {
        controller.abort(new Error('simultaneous owner abort'));
        return eagerPromise(Buffer.alloc(0));
      },
    },
  });

  await expect(
    kernel.recordEdit(
      {
        host: 'claude',
        idempotencyKey: 'test:state:simultaneous-abort',
        path: 'simultaneous-abort.ts',
        sessionId: 'session-1',
        toolName: 'Write',
      },
      { signal: controller.signal },
    ),
  ).rejects.toThrow('simultaneous owner abort');
  expect(appendAttempts).toBe(0);
  expect(releases).toBe(1);
});

test('rechecks simultaneous lease poison after a phase value wins and never enters append', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  let appendAttempts = 0;
  let compromise!: (error: Error) => void;
  let fatalTeardowns = 0;
  let releases = 0;
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      acquireLock: async ({ onCompromised }) => {
        compromise = onCompromised;
        return async () => {
          releases += 1;
        };
      },
      beforeAppend: async () => {
        appendAttempts += 1;
      },
      fatalOwnerTeardown: () => {
        fatalTeardowns += 1;
      },
      prepareStateFile: async ({ stateFile: preparedStateFile }) => {
        await writeFile(preparedStateFile, '', 'utf8');
        return preparedStateFile;
      },
      readState: () => {
        compromise(new Error('simultaneous owner compromise'));
        return eagerPromise(Buffer.alloc(0));
      },
    },
  });

  await expect(
    kernel.recordEdit({
      host: 'claude',
      idempotencyKey: 'test:state:simultaneous-poison',
      path: 'simultaneous-poison.ts',
      sessionId: 'session-1',
      toolName: 'Write',
    }),
  ).rejects.toThrow('permanently poisoned');
  expect(appendAttempts).toBe(0);
  expect(fatalTeardowns).toBe(1);
  expect(releases).toBe(0);
});

test('accepts Windows parent-fsync limitations when creating a new state file', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: {
      platform: 'win32',
      syncParent: async () => {
        throw Object.assign(new Error('Windows directory sync unsupported'), { code: 'EPERM' });
      },
    },
  });
  await expect(
    kernel.recordEdit({
      host: 'claude',
      idempotencyKey: 'test:state:windows-parent-sync',
      path: 'windows.ts',
      sessionId: 'session-1',
      toolName: 'Write',
    }),
  ).resolves.toMatchObject({ stateVersion: 1 });
});

test('rejects oversized snapshots before parsing or allocating their full file size', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'oversized.jsonl');
  await writeFile(stateFile, Buffer.alloc(16 * 1024 * 1024 + 1));
  await expect(createFileRuntimeKernel({ stateFile }).readSnapshot()).rejects.toThrow('exceeds 16777216 byte limit');
});

test('rejects invalid writes before creating their state file', async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.jsonl');
  await expect(
    createFileRuntimeKernel({ stateFile }).recordEdit({
      host: 'claude',
      idempotencyKey: 'test:state:invalid-write',
      path: '',
      sessionId: 'session-1',
      toolName: 'Write',
    }),
  ).rejects.toThrow('every event field');
  await expect(access(stateFile)).rejects.toThrow();
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
  const kernel = createTestFileRuntimeKernel({
    stateFile,
    adapter: { beforeAppend: async () => {
      entered();
      await allowAppend;
    } },
  });
  const pending = kernel.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:compromised',
    path: 'compromised.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });
  void pending.catch(() => undefined);
  await Promise.race([
    enteredBeforeAppend,
    wait(100).then(() => Promise.reject(new Error('test-only append barrier was not reached'))),
  ]);
  await rm(`${stateFile}.lock`, { force: true, recursive: true });
  await wait(1_100);
  continueAppend();
  await expect(pending).rejects.toThrow('lease was compromised');
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
