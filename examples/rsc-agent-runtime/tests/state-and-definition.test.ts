import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
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

  await kernel.recordEdit({ host: 'claude', path: 'first.ts', sessionId: 'session-1', toolName: 'Write' });
  await kernel.recordEdit({ host: 'codex', path: 'second.ts', sessionId: 'session-1', toolName: 'apply_patch' });
  await kernel.recordEdit({ host: 'claude', path: 'third.ts', sessionId: 'session-1', toolName: 'Edit' });

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

  await kernel.recordEdit({ host: 'claude', path: 'complete.ts', sessionId: 'session-1', toolName: 'Write' });
  await appendFile(stateFile, '{"eventId":"partial"', 'utf8');

  await expect(kernel.readSnapshot()).resolves.toMatchObject({
    edits: [{ eventId: 'complete-edit', path: 'complete.ts' }],
    stateVersion: 1,
  });
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
    'apply_patch|Write|Edit',
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
