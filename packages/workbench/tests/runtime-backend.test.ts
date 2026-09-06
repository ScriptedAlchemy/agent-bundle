import { expect, it } from '@rstest/core';

import type {
  DevRuntimeInvocationRequest,
  DevRuntimeRun,
  DevRuntimeSurface,
} from '../../agent-bundle/src/contracts/runtime.ts';
import type { ApplicationLeaf } from '../src/application/application-tree-model.ts';
import { createRuntimeBackend, type RuntimeInvocationClient } from '../src/application/runtime-backend.ts';
import type { RuntimePlaygroundController } from '../src/runtime-controller.ts';

const vector = Object.freeze({
  artifactEpochId: 'epoch-a',
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'state-a',
  stateVersion: 1,
});

const surface = Object.freeze({
  defaultTarget: 'portable',
  fixtures: Object.freeze([]),
  id: 'mcp.search_audible',
  kind: 'mcp-tool' as const,
  label: 'Search Audible',
  readOnly: true,
  targets: Object.freeze(['portable']),
}) satisfies DevRuntimeSurface;

const run = Object.freeze({
  completedAt: '2026-09-05T07:00:01.000Z',
  id: 'runtime-run-a',
  input: Object.freeze({ title: 'Dune' }),
  result: Object.freeze({
    agentVisible: Object.freeze({ count: 1 }),
    state: Object.freeze({
      identity: Object.freeze({ stateStoreId: 'state-a', stateVersion: 1 }),
    }),
    trace: Object.freeze([{
      durationMs: 4,
      id: 'render',
      phase: 'render',
      startedAt: '2026-09-05T07:00:00.000Z',
      status: 'succeeded' as const,
    }]),
    tree: Object.freeze([]),
  }),
  startedAt: '2026-09-05T07:00:00.000Z',
  status: 'succeeded' as const,
  surfaceId: surface.id,
  target: 'portable',
  vector,
}) satisfies DevRuntimeRun;

const document = Object.freeze({
  root: Object.freeze({
    children: Object.freeze([{ kind: 'text' as const, text: 'Found Dune' }]),
    kind: 'result' as const,
  }),
  status: 'success' as const,
  version: 1 as const,
});
const events = Object.freeze([{ document, sequence: 0, type: 'complete' as const }]);

const leaf = Object.freeze({
  config: Object.freeze([]),
  execution: 'invoke' as const,
  key: '/routes/mcp/curator/tool/search_audible',
  label: 'Search Audible',
  ref: Object.freeze({ kind: 'tool' as const, name: 'search_audible', server: 'curator' }),
  routeId: 'tool:curator/search_audible',
  source: 'src/mcp/curator/tools/search_audible.tsx',
}) satisfies ApplicationLeaf;

const fixture = () => {
  const requests: DevRuntimeInvocationRequest[] = [];
  const actions: unknown[] = [];
  let listener: ((model: RuntimePlaygroundController['model']) => void) | undefined;
  const runtimeClient: RuntimeInvocationClient = {
    createRun: async (request) => {
      requests.push(request);
      return run;
    },
    readRun: async () => run,
    readRunDocument: async () => events,
  };
  const model = {
    history: Object.freeze([run]),
    status: Object.freeze({
      activeVector: vector,
      descriptor: Object.freeze({ environmentVariables: Object.freeze([]), id: 'rsc', label: 'RSC', schemaVersion: 1 as const }),
      diagnostics: Object.freeze([]),
      hmrReady: true,
      state: 'active' as const,
    }),
    surfaces: Object.freeze([surface]),
  } as unknown as RuntimePlaygroundController['model'];
  const controller = {
    dispatch: (action: unknown) => { actions.push(action); },
    model,
    subscribe: (next: (value: RuntimePlaygroundController['model']) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
  } as unknown as RuntimePlaygroundController;
  return { actions, controller, listener: () => listener, requests, runtimeClient };
};

it('matches runtime surfaces and maps a completed run into the shared invocation envelope', async () => {
  const setup = fixture();
  const backend = createRuntimeBackend(setup);

  expect(backend.accepts(leaf)).toBe(true);
  expect(backend.accepts({ ...leaf, ref: { kind: 'resource', name: 'search_audible', server: 'curator' } })).toBe(false);
  const invocation = await backend.invoke(leaf, {
    correlationId: 'correlation-a',
    input: { title: 'Dune' },
    routeId: leaf.routeId,
  });

  expect(setup.requests).toEqual([{
    correlationId: 'correlation-a',
    expectedGenerationId: 'generation-a',
    input: { title: 'Dune' },
    surfaceId: surface.id,
    target: 'portable',
  }]);
  expect(setup.actions).toEqual([{ run, type: 'run.received' }]);
  expect(invocation).toMatchObject({
    correlationId: 'correlation-a',
    diagnostics: [],
    document,
    events,
    id: run.id,
    input: run.input,
    kind: 'tool',
    manifestDigest: 'generation-a',
    projection: {},
    providers: [],
    result: { count: 1 },
    routeId: leaf.routeId,
    source: leaf.source,
    sourceRevision: 'source-a',
    status: 'succeeded',
    timings: [{ durationMs: 4, phase: 'render', startedAt: run.startedAt }],
  });
});

it('maps runtime history, reads snapshots, and forwards newly completed runs', async () => {
  const setup = fixture();
  const backend = createRuntimeBackend(setup);
  expect(backend.accepts(leaf)).toBe(true);

  await expect(backend.history(leaf)).resolves.toEqual([
    expect.objectContaining({ id: run.id, routeId: leaf.routeId }),
  ]);
  await expect(backend.read(run.id)).resolves.toMatchObject({ document, id: run.id, routeId: leaf.routeId });

  const received: unknown[] = [];
  const unsubscribe = backend.subscribe((summary) => received.push(summary));
  setup.listener()?.({
    ...setup.controller.model,
    history: Object.freeze([{ ...run, id: 'runtime-run-b' }]),
  });
  expect(received).toEqual([expect.objectContaining({ id: 'runtime-run-b', routeId: leaf.routeId })]);
  unsubscribe();
});

it('keeps the succeeded outcome invariant when a runtime run has no document events', async () => {
  const setup = fixture();
  const backend = createRuntimeBackend({
    ...setup,
    runtimeClient: {
      ...setup.runtimeClient,
      readRunDocument: async () => Object.freeze([]),
    },
  });

  const invocation = await backend.invoke(leaf, {
    input: { title: 'Dune' },
    routeId: leaf.routeId,
  });

  expect(invocation.status).toBe('succeeded');
  expect(invocation.document).toBeUndefined();
  expect(invocation.outcome).toEqual({ kind: 'success' });
});
