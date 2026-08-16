import { expect, it } from '@rstest/core';

import {
  prepareRuntimeMcpHandoffAuthority,
  RuntimeMcpHandoffCoordinator,
  type RuntimeHandoffLifecycle,
} from '../src/mcp/runtime-mcp-handoff.ts';
import type { RuntimeAppPreviewProps } from '../src/runtime-stage.tsx';

const deferred = <Value>() => {
  let reject: (reason?: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const preview = (id: string): RuntimeAppPreviewProps => ({
  profile: { claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' },
  profileId: 'portable',
  run: {
    id: `run-${id}`,
    result: {
      app: {
        mcpBinding: {
          definitionDigest: `definition-${id}`,
          registryRevision: 1,
          serverDigest: `server-${id}`,
          serverName: `server-${id}`,
          sessionId: `session-${id}`,
          sessionRevision: 1,
          target: 'portable',
          transportDigest: `transport-${id}`,
        },
        resourceUri: `ui://runtime/${id}.html`,
        surfaceId: `mcp.client-${id}`,
      },
      content: { id },
    },
    status: 'succeeded',
    surfaceId: `mcp.render-${id}`,
    vector: {
      providerSessionId: `provider-${id}`,
      runtimeGenerationId: `generation-${id}`,
      sourceRevision: `source-${id}`,
      stateStoreId: `store-${id}`,
      stateVersion: 1,
    },
  },
  surface: { id: `mcp.render-${id}` },
} as unknown as RuntimeAppPreviewProps);

const authority = (id: string) => {
  const prepared = prepareRuntimeMcpHandoffAuthority(preview(id), (value) => value === 'portable');
  if (prepared === undefined) throw new Error('Fixture handoff authority was rejected.');
  return prepared;
};

const coordinator = () => {
  const commits: unknown[] = [];
  const rejections: unknown[] = [];
  return Object.freeze({
    commits,
    rejections,
    value: new RuntimeMcpHandoffCoordinator({
      commit: (handoff) => { commits.push(handoff); },
      reject: (reason) => { rejections.push(reason); },
    }),
  });
};

it('keeps a replayed same-handle registration after its deferred prior unregister', async () => {
  const state = coordinator();
  const current = authority('same');
  const handle: RuntimeHandoffLifecycle = { close: async () => undefined };
  const unregisterFirst = state.value.register(handle, current);
  unregisterFirst();
  const unregisterSecond = state.value.register(handle, current);

  await flush();
  expect(state.value.canOpen(current)).toBe(true);
  unregisterSecond();
  await flush();
  expect(state.value.canOpen(current)).toBe(false);
});

it('fences a held A close when distinct B registers, leaving B eligible', async () => {
  const state = coordinator();
  const a = authority('a');
  const b = authority('b');
  const held = deferred<void>();
  let aCloses = 0;
  state.value.register({ close: () => { aCloses += 1; return held.promise; } }, a);
  state.value.open(a);
  state.value.register({ close: async () => undefined }, b);
  held.resolve();

  await flush();
  expect(aCloses).toBe(1);
  expect(state.commits).toEqual([]);
  expect(state.value.canOpen(b)).toBe(true);
  state.value.open(b);
  await flush();
  expect(state.commits).toHaveLength(1);
});

it('retains the exact authority after a rejected close and commits one retry', async () => {
  const state = coordinator();
  const current = authority('retry');
  let closes = 0;
  state.value.register({
    close: () => {
      closes += 1;
      return closes === 1 ? Promise.reject(new Error('close rejected')) : Promise.resolve();
    },
  }, current);

  state.value.open(current);
  await flush();
  expect(state.rejections).toHaveLength(1);
  expect(state.value.canOpen(current)).toBe(true);
  state.value.open(current);
  await flush();
  expect(closes).toBe(2);
  expect(state.commits).toHaveLength(1);
});

it('does not let a registered App endpoint and resource authorize a distinct handoff authority', () => {
  const aProps = preview('endpoint');
  const aRun = aProps.run as Extract<typeof aProps.run, Readonly<{ readonly result: NonNullable<typeof aProps.run.result>; readonly status: 'succeeded' }>>;
  const aApp = aRun.result.app;
  if (aApp === undefined) throw new Error('Endpoint authority fixture has no App evidence.');
  const bProps = {
    ...aProps,
    run: {
      ...aRun,
      result: {
        ...aRun.result,
        app: {
          ...aApp,
          resourceUri: 'ui://runtime/endpoint-b.html',
          surfaceId: 'mcp.client-endpoint-b',
        },
      },
    },
  } as RuntimeAppPreviewProps;
  const a = prepareRuntimeMcpHandoffAuthority(aProps, (value) => value === 'portable');
  const b = prepareRuntimeMcpHandoffAuthority(bProps, (value) => value === 'portable');
  if (a === undefined || b === undefined) throw new Error('Endpoint authority fixture was rejected.');
  const state = coordinator();

  state.value.register({ close: async () => undefined }, a);
  expect(a.key).not.toBe(b.key);
  expect(state.value.canOpen(b)).toBe(false);
  state.value.register({ close: async () => undefined }, b);
  expect(state.value.canOpen(b)).toBe(true);
});

it('serializes double open and fences held completion after reset or navigation cancellation', async () => {
  const state = coordinator();
  const current = authority('cancel');
  const held = deferred<void>();
  let closes = 0;
  state.value.register({ close: () => { closes += 1; return held.promise; } }, current);
  state.value.open(current);
  state.value.open(current);
  expect(closes).toBe(1);
  state.value.cancel();
  held.resolve();

  await flush();
  expect(state.commits).toEqual([]);
  expect(state.value.canOpen(current)).toBe(false);
});

it('detaches and freezes complete handoff evidence before later model mutation', () => {
  const mutable = preview('seed') as unknown as {
    profile: { label: string };
    run: { result: { app: { mcpBinding: { sessionId: string } }; content: { id: string } } };
    surface: { id: string };
  };
  const prepared = prepareRuntimeMcpHandoffAuthority(mutable as unknown as RuntimeAppPreviewProps, (value) => value === 'portable');
  if (prepared === undefined) throw new Error('Mutable authority fixture was rejected.');
  mutable.profile.label = 'mutated';
  mutable.run.result.app.mcpBinding.sessionId = 'mutated';
  mutable.run.result.content.id = 'mutated';
  mutable.surface.id = 'mutated';

  const evidence = prepared.handoff.initialPreview.preview;
  const run = evidence.run as unknown as { readonly result: { readonly app: { readonly mcpBinding: { readonly sessionId: string } }; readonly content: { readonly id: string } } };
  expect(evidence.profile.label).toBe('Portable MCP Apps');
  expect(run.result.app.mcpBinding.sessionId).toBe('session-seed');
  expect(run.result.content).toEqual({ id: 'seed' });
  expect(evidence.surface.id).toBe('mcp.render-seed');
  expect(Object.isFrozen(evidence.run)).toBe(true);
  expect(Object.getPrototypeOf(evidence.run)).toBeNull();
});

it('rejects an outer accessor without evaluating its profile, run, surface, or profile id', () => {
  let reads = 0;
  const unsafe = Object.create(null) as Record<string, unknown>;
  for (const key of ['profile', 'profileId', 'run', 'surface']) {
    Object.defineProperty(unsafe, key, {
      enumerable: true,
      get: () => {
        reads += 1;
        return undefined;
      },
    });
  }

  expect(prepareRuntimeMcpHandoffAuthority(unsafe as unknown as RuntimeAppPreviewProps, () => true)).toBeUndefined();
  expect(reads).toBe(0);
});

it('admits descriptor-owned authority evidence while ignoring the live lifecycle callback', () => {
  const callback = (): (() => void) => () => undefined;
  const prepared = prepareRuntimeMcpHandoffAuthority(Object.freeze({
    ...preview('callback'),
    registerLifecycle: callback,
  }), (value) => value === 'portable');

  if (prepared === undefined) throw new Error('Lifecycle callback must not reject authority evidence.');
  expect(Object.keys(prepared.handoff.initialPreview.preview)).toEqual(['profile', 'profileId', 'run', 'surface']);
  expect('registerLifecycle' in prepared.handoff.initialPreview.preview).toBe(false);
  expect(Object.getPrototypeOf(prepared.handoff.initialPreview.preview)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(prepared.handoff.source.binding)).toBe(Object.prototype);
});

it('fails closed without throwing for detached but structurally malformed evidence', () => {
  const malformed = Object.freeze({
    profile: Object.freeze({ id: 'portable', version: 'agent-bundle:mcp-apps:2026-01-26' }),
    profileId: 'portable',
    run: Object.freeze({ result: null, status: 'succeeded', vector: null }),
    surface: Object.freeze({}),
  });

  expect(() => prepareRuntimeMcpHandoffAuthority(malformed as unknown as RuntimeAppPreviewProps, () => true)).not.toThrow();
  expect(prepareRuntimeMcpHandoffAuthority(malformed as unknown as RuntimeAppPreviewProps, () => true)).toBeUndefined();
});

it('admits an initial runtime vector at state version zero', () => {
  const initial = preview('initial') as unknown as { run: { vector: { stateVersion: number } } } & RuntimeAppPreviewProps;
  initial.run.vector.stateVersion = 0;

  expect(prepareRuntimeMcpHandoffAuthority(initial, (value) => value === 'portable')).toEqual(expect.objectContaining({
    handoff: expect.any(Object),
  }));
});
