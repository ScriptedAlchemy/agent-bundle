import { expect, it } from '@rstest/core';

import {
  DevRuntimeGenerationConflictError,
  DevRuntimeUnavailableError,
  type DevRuntimeMcpSessionBinding,
  type DevRuntimeRun,
  type DevRuntimeSurface,
} from '../src/dev/index.ts';

const vector = {
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'fixture-a',
  stateVersion: 1,
} as const;

const surface = {
  defaultTarget: 'claude',
  fixtures: [{ id: 'after-edit', label: 'After file edit' }],
  id: 'hook.after-edit',
  kind: 'hook',
  label: 'After file edit',
  readOnly: false,
  targets: ['claude', 'codex'],
} satisfies DevRuntimeSurface;

const binding = {
  definitionDigest: 'definition-a',
  providerSessionId: 'provider-a',
  registryRevision: 3,
  serverDigest: 'server-a',
  serverName: 'timeline',
  sessionId: 'mcp-a',
  sessionRevision: 2,
  stateStoreId: 'fixture-a',
  target: 'portable',
  transportDigest: 'transport-a',
} satisfies DevRuntimeMcpSessionBinding;

const run = {
  completedAt: '2026-08-15T00:00:01.000Z',
  id: 'run-a',
  input: { file: 'notes.md' },
  result: {
    agentVisible: { message: 'updated' },
    state: { identity: { stateStoreId: 'fixture-a', stateVersion: 1 } },
    trace: [],
    tree: [],
  },
  startedAt: '2026-08-15T00:00:00.000Z',
  status: 'succeeded',
  surfaceId: 'hook.after-edit',
  target: 'claude',
  vector,
} satisfies DevRuntimeRun;

const reactLikeNode = {
  $$typeof: Symbol.for('react.element'),
  props: {},
  type: 'div',
};

const invalidReactRun = {
  ...run,
  result: {
    ...run.result,
    agentVisible: reactLikeNode,
  },
};

// @ts-expect-error Runtime result values are JSON only and cannot carry React elements.
const jsonOnlyRun: DevRuntimeRun = invalidReactRun;

const targetlessSurface = {
  fixtures: [],
  id: 'hook.before-tool',
  kind: 'hook',
  label: 'Before tool',
  readOnly: true,
} satisfies Omit<DevRuntimeSurface, 'targets'>;

// @ts-expect-error Every browser surface must explicitly declare its supported targets.
const targetfulSurface: DevRuntimeSurface = targetlessSurface;

const incompleteBinding = {
  providerSessionId: 'provider-a',
  serverName: 'timeline',
  sessionId: 'mcp-a',
  stateStoreId: 'fixture-a',
  target: 'portable',
} satisfies Pick<
  DevRuntimeMcpSessionBinding,
  'providerSessionId' | 'serverName' | 'sessionId' | 'stateStoreId' | 'target'
>;

// @ts-expect-error Stable MCP bindings include registry/session revisions and all three digests.
const completeBinding: DevRuntimeMcpSessionBinding = incompleteBinding;

it('publishes JSON-safe runtime run, surface, and stable MCP binding contracts', () => {
  expect(surface.targets).toEqual(['claude', 'codex']);
  expect(binding.sessionRevision).toBe(2);
  expect(run.status).toBe('succeeded');
  expect(invalidReactRun).toBeDefined();
  expect(jsonOnlyRun).toBeDefined();
  expect(targetlessSurface).toBeDefined();
  expect(targetfulSurface).toBeDefined();
  expect(incompleteBinding).toBeDefined();
  expect(completeBinding).toBeDefined();
});

it('uses stable errors for unavailable and stale runtime generations', () => {
  const unavailable = new DevRuntimeUnavailableError();
  const conflict = new DevRuntimeGenerationConflictError('expected-generation', 'actual-generation');

  expect(unavailable).toMatchObject({
    code: 'AB8201',
    message: 'Development runtime is not available.',
    name: 'DevRuntimeUnavailableError',
  });
  expect(conflict).toMatchObject({
    actualGenerationId: 'actual-generation',
    code: 'AB8204',
    expectedGenerationId: 'expected-generation',
    name: 'DevRuntimeGenerationConflictError',
  });
});
