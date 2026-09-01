import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

import { serializeRuntimeDefinition } from '../src/build/serialize-definition.js';
import { runtimeDefinition } from '../src/definition.js';
import { AgentStateError, createFileRuntimeKernel } from '../src/runtime/state-file.js';

/**
 * Durable-state semantics for the example's provider-facing RuntimeKernel,
 * now an adapter over the framework state kernel's workspace-durable
 * `node:sqlite` driver (#98). Locking, transactions, torn-write repair, and
 * lease policing belong to the framework kernel and its conformance suite
 * (`@agent-bundle/runtime` state tests); what stays here is the example's
 * own contract: snapshot shapes, bounded limit views, exact versions,
 * idempotency behavior across kernel instances, and the derived
 * eventId/recordedAt decoration.
 */

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

const resourceUri = 'ui://rsc-agent-runtime/edit-timeline-v1.html';

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

const temporaryStateFile = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-')), 'state.sqlite');

test('reads an edit recorded by another kernel instance', async () => {
  const stateFile = await temporaryStateFile();
  const first = createFileRuntimeKernel({
    stateFile,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  });
  const second = createFileRuntimeKernel({ stateFile });

  await first.recordEdit({
    host: 'claude',
    idempotencyKey: 'test:state:other-kernel',
    path: 'src/runtime/state-file.ts',
    sessionId: 'session-1',
    toolName: 'Write',
  });

  expect(await second.readSnapshot()).toEqual({
    edits: [
      {
        eventId: 'edit-1',
        host: 'claude',
        path: 'src/runtime/state-file.ts',
        recordedAt: '2026-08-14T12:00:00.000Z',
        sessionId: 'session-1',
        toolName: 'Write',
      },
    ],
    stateVersion: 1,
  });
});

test('limits snapshots to the newest edit events', async () => {
  const stateFile = await temporaryStateFile();
  const kernel = createFileRuntimeKernel({
    stateFile,
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

test('deduplicates identical state edits and rejects conflicting idempotency-key reuse', async () => {
  const stateFile = await temporaryStateFile();
  const first = createFileRuntimeKernel({
    stateFile,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  });
  const second = createFileRuntimeKernel({
    stateFile,
    now: () => new Date('2026-08-14T12:00:05.000Z'),
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
  expect(firstSnapshot.edits).toEqual(secondSnapshot.edits);
  expect(await first.readSnapshot()).toMatchObject({ stateVersion: 1 });

  // The committed decoration is stable: replays return the original commit's
  // eventId and recordedAt, never a retry's clock.
  const replayed = await second.recordEdit(edit);
  expect(replayed.edits).toEqual(firstSnapshot.edits);

  await expect(second.recordEdit({ ...edit, path: 'src/conflict.ts' })).rejects.toMatchObject({
    code: 'idempotency-conflict',
    name: 'AgentStateError',
  });
  await expect(first.readSnapshot()).resolves.toMatchObject({ stateVersion: 1 });
});

test('appends reset records without resetting the monotonic durable version', async () => {
  const stateFile = await temporaryStateFile();
  const kernel = createFileRuntimeKernel({
    stateFile,
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
  expect(await createFileRuntimeKernel({ stateFile }).readSnapshot()).toEqual({
    edits: [],
    seed: { reason: 'test' },
    stateVersion: 2,
  });
});

test('preserves reset seeds across immediate, idempotent, reopened, limited, and follow-up snapshots', async () => {
  const stateFile = await temporaryStateFile();
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
    edits: [
      {
        eventId: 'edit-3',
        host: 'claude',
        path: 'after-reset.ts',
        recordedAt: '2026-08-15T00:00:01.000Z',
        sessionId: 'fixture-seed-session',
        toolName: 'Write',
      },
    ],
    seed,
    stateVersion: 3,
  });
  await expect(reopened.readSnapshot({ limit: 1 })).resolves.toMatchObject({
    edits: [expect.objectContaining({ eventId: 'edit-3', path: 'after-reset.ts' })],
    seed,
    stateVersion: 3,
  });
  await expect(reopened.resetState({
    idempotencyKey: 'test:state:seed-reset',
    seed: { ...seed, session_id: 'conflicting-seed-session' },
  })).rejects.toMatchObject({ code: 'idempotency-conflict' });
  await expect(reopened.resetState({ idempotencyKey: 'test:state:seed-clear' })).resolves.toEqual({
    edits: [],
    stateVersion: 4,
  });
  await expect(createFileRuntimeKernel({ stateFile }).readSnapshot()).resolves.toEqual({ edits: [], stateVersion: 4 });
});

test('reconstructs an exact durable snapshot version through edits, resets, and idempotent replays', async () => {
  const stateFile = await temporaryStateFile();
  const kernel = createFileRuntimeKernel({
    stateFile,
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
    edits: [expect.objectContaining({ eventId: 'edit-3', path: 'after-reset.ts' })],
    seed,
    stateVersion: 3,
  });
  await expect(readExact(4)).rejects.toThrow('state version 4 is unavailable');
  await expect(readExact(-1)).rejects.toThrow(RangeError);
  await expect(readExact(1.5)).rejects.toThrow(RangeError);
});

test('serializes concurrent kernel instances into one monotonic history', async () => {
  const stateFile = await temporaryStateFile();
  const kernels = Array.from({ length: 3 }, () =>
    createFileRuntimeKernel({ stateFile, now: () => new Date('2026-08-15T02:00:00.000Z') }),
  );

  const snapshots = await Promise.all(
    kernels.map((kernel, index) =>
      kernel.recordEdit({
        host: 'claude',
        idempotencyKey: `test:state:concurrent-${String(index)}`,
        path: `src/concurrent-${String(index)}.ts`,
        sessionId: 'session-1',
        toolName: 'Write',
      }),
    ),
  );

  expect(snapshots.map((snapshot) => snapshot.stateVersion).sort()).toEqual([1, 2, 3]);
  const settled = await createFileRuntimeKernel({ stateFile }).readSnapshot();
  expect(settled.stateVersion).toBe(3);
  expect(new Set(settled.edits.map((edit) => edit.path)).size).toBe(3);
});

test('fails closed with a typed corrupt error when the state file is not a database', async () => {
  const stateFile = await temporaryStateFile();
  await writeFile(stateFile, 'this is not a sqlite database, and it is long enough to hold a header', 'utf8');

  await expect(createFileRuntimeKernel({ stateFile }).readSnapshot()).rejects.toMatchObject({
    code: 'corrupt',
    name: 'AgentStateError',
  });
  expect(new AgentStateError('corrupt', 'proof of the exported class').name).toBe('AgentStateError');
});

test('treats a valid empty state file as an empty snapshot', async () => {
  const stateFile = await temporaryStateFile();
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
