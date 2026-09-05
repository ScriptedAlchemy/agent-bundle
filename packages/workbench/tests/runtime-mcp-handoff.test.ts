import { expect, it } from '@rstest/core';

import {
  McpPreviewDepartureCoordinator,
  prepareRuntimeMcpHandoffAuthority,
  RuntimeMcpHandoffCoordinator,
  type McpPreviewDepartureOptions,
  type RuntimeHandoffLifecycle,
} from '../src/mcp/runtime-mcp-handoff.ts';
import type { RuntimeAppPreviewProps } from '../src/runtime-view-contracts.ts';

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

const departureCoordinator = () => {
  const commits: string[] = [];
  const rejections: unknown[] = [];
  return Object.freeze({
    commits,
    rejections,
    value: new McpPreviewDepartureCoordinator({
      commit: () => { commits.push('runtime'); },
      reject: (reason) => { rejections.push(reason); },
    }),
  });
};

it('does not commit Runtime navigation until one held Page preview close settles', async () => {
  const state = departureCoordinator();
  const held = deferred<void>();
  let closes = 0;
  state.value.register(() => {
    closes += 1;
    return held.promise;
  });

  expect(state.value.request()).toBe(true);
  expect(state.value.request()).toBe(true);
  expect(closes).toBe(1);
  expect(state.commits).toEqual([]);
  held.resolve();
  await flush();
  expect(state.commits).toEqual(['runtime']);
});

it('retains a rejected Page preview close for one exact retry', async () => {
  const state = departureCoordinator();
  let closes = 0;
  state.value.register(() => {
    closes += 1;
    return closes === 1 ? Promise.reject(new Error('Page preview close rejected')) : Promise.resolve();
  });

  expect(state.value.request()).toBe(true);
  await flush();
  expect(state.rejections).toHaveLength(1);
  expect(state.commits).toEqual([]);
  expect(state.value.request()).toBe(true);
  await flush();
  expect(closes).toBe(2);
  expect(state.commits).toEqual(['runtime']);
});

it('fences a held stale Page close when replacement registration takes ownership', async () => {
  const state = departureCoordinator();
  const held = deferred<void>();
  const staleUnregister = state.value.register(() => held.promise);
  expect(state.value.request()).toBe(true);
  staleUnregister();
  const replacementUnregister = state.value.register(async () => undefined);
  held.resolve();

  await flush();
  expect(state.commits).toEqual([]);
  expect(state.value.request()).toBe(true);
  await flush();
  expect(state.commits).toEqual(['runtime']);
  replacementUnregister();
});

it('serializes every Page departure behind one held close and commits the first destination only', async () => {
  const state = departureCoordinator();
  const held = deferred<void>();
  const destinations: string[] = [];
  let closes = 0;
  state.value.register(() => { closes += 1; return held.promise; });

  expect(state.value.depart({ commit: () => { destinations.push('overview'); }, reject: () => undefined } satisfies McpPreviewDepartureOptions)).toBe(true);
  expect(state.value.depart({ commit: () => { destinations.push('skills'); }, reject: () => undefined } satisfies McpPreviewDepartureOptions)).toBe(true);
  expect(closes).toBe(1);
  expect(destinations).toEqual([]);
  held.resolve();
  await flush();
  expect(destinations).toEqual(['overview']);
});

it('retains the exact Page close facade after rejection and commits only its retry destination', async () => {
  const state = departureCoordinator();
  const rejections: unknown[] = [];
  const destinations: string[] = [];
  let closes = 0;
  state.value.register(() => {
    closes += 1;
    return closes === 1 ? Promise.reject(new Error('Page close rejected')) : Promise.resolve();
  });

  expect(state.value.depart({ commit: () => { destinations.push('overview'); }, reject: (reason) => { rejections.push(reason); } } satisfies McpPreviewDepartureOptions)).toBe(true);
  await flush();
  expect(rejections).toHaveLength(1);
  expect(state.value.depart({ commit: () => { destinations.push('skills'); }, reject: () => undefined } satisfies McpPreviewDepartureOptions)).toBe(true);
  await flush();
  expect(closes).toBe(2);
  expect(destinations).toEqual(['skills']);
});

it('cancels a held Page departure without discarding its facade or admitting a stale destination', async () => {
  const state = departureCoordinator();
  const held = deferred<void>();
  const destinations: string[] = [];
  let closes = 0;
  state.value.register(() => {
    closes += 1;
    return closes === 1 ? held.promise : Promise.resolve();
  });

  expect(state.value.depart({ commit: () => { destinations.push('overview'); }, reject: () => undefined } satisfies McpPreviewDepartureOptions)).toBe(true);
  state.value.cancelDeparture(); // The user returns to the still-mounted MCP page before its close settles.
  held.resolve();
  await flush();
  expect(destinations).toEqual([]);
  expect(state.value.depart({ commit: () => { destinations.push('skills'); }, reject: () => undefined } satisfies McpPreviewDepartureOptions)).toBe(true);
  await flush();
  expect(closes).toBe(2);
  expect(destinations).toEqual(['skills']);
});

it('captures and joins the terminal Page close before revoking its facade', async () => {
  const state = departureCoordinator();
  const held = deferred<void>();
  state.value.register(() => held.promise);

  const closing = state.value.close();
  let settled = false;
  void closing.then(() => { settled = true; });
  await flush();
  expect(settled).toBe(false);
  expect(state.value.request()).toBe(false);
  held.resolve();
  await closing;
  expect(settled).toBe(true);
});

it('joins an active Page departure during terminal shutdown without a second close owner', async () => {
  const state = departureCoordinator();
  const held = deferred<void>();
  let closes = 0;
  state.value.register(() => { closes += 1; return held.promise; });

  expect(state.value.depart({ commit: () => undefined, reject: () => undefined } satisfies McpPreviewDepartureOptions)).toBe(true);
  const closing = state.value.close();
  expect(closes).toBe(1);
  held.resolve();
  await closing;
});

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

it('coalesces one generic Runtime departure and commits its exact navigation only after the lifecycle closes', async () => {
  const state = coordinator();
  const current = authority('leave');
  const held = deferred<void>();
  const navigations: string[] = [];
  let closes = 0;
  state.value.register({ close: () => { closes += 1; return held.promise; } }, current);

  expect(state.value.depart({ commit: () => { navigations.push('mcp'); }, reject: () => undefined })).toBe(true);
  expect(state.value.depart({ commit: () => { navigations.push('overview'); }, reject: () => undefined })).toBe(true);
  expect(closes).toBe(1);
  expect(navigations).toEqual([]);
  held.resolve();
  await flush();
  expect(navigations).toEqual(['mcp']);
  expect(state.commits).toEqual([]);
});

it('retains one Runtime lifecycle after generic departure rejection for its exact retry', async () => {
  const state = coordinator();
  const current = authority('leave-retry');
  const rejections: unknown[] = [];
  const navigations: string[] = [];
  let closes = 0;
  state.value.register({
    close: () => {
      closes += 1;
      return closes === 1 ? Promise.reject(new Error('Runtime departure close rejected')) : Promise.resolve();
    },
  }, current);

  expect(state.value.depart({ commit: () => { navigations.push('mcp'); }, reject: (reason) => { rejections.push(reason); } })).toBe(true);
  await flush();
  expect(rejections).toHaveLength(1);
  expect(state.value.canOpen(current)).toBe(true);
  expect(state.value.depart({ commit: () => { navigations.push('mcp'); }, reject: () => undefined })).toBe(true);
  await flush();
  expect(closes).toBe(2);
  expect(navigations).toEqual(['mcp']);
});

it('fences a held generic Runtime departure when a distinct lifecycle replaces its authority', async () => {
  const state = coordinator();
  const a = authority('leave-a');
  const b = authority('leave-b');
  const held = deferred<void>();
  const navigations: string[] = [];
  state.value.register({ close: () => held.promise }, a);

  expect(state.value.depart({ commit: () => { navigations.push('mcp'); }, reject: () => undefined })).toBe(true);
  state.value.register({ close: async () => undefined }, b);
  held.resolve();
  await flush();
  expect(navigations).toEqual([]);
  expect(state.value.canOpen(b)).toBe(true);
});

it('cancels a held Runtime departure without discarding its exact lifecycle or committing stale navigation', async () => {
  const state = coordinator();
  const current = authority('leave-cancel');
  const held = deferred<void>();
  const navigations: string[] = [];
  let closes = 0;
  state.value.register({
    close: () => {
      closes += 1;
      return closes === 1 ? held.promise : Promise.resolve();
    },
  }, current);

  expect(state.value.depart({ commit: () => { navigations.push('mcp'); }, reject: () => undefined })).toBe(true);
  state.value.cancelDeparture();
  held.resolve();
  await flush();
  expect(navigations).toEqual([]);
  expect(state.value.canOpen(current)).toBe(true);
  expect(state.value.depart({ commit: () => { navigations.push('overview'); }, reject: () => undefined })).toBe(true);
  await flush();
  expect(closes).toBe(2);
  expect(navigations).toEqual(['overview']);
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

it('rejects NUL-bearing handoff identity fields that would collide across adjacent tuple positions', () => {
  const withBindingIdentity = (serverDigest: string, serverName: string): RuntimeAppPreviewProps => {
    const current = preview('nul');
    const run = current.run as Extract<typeof current.run, Readonly<{ readonly result: NonNullable<typeof current.run.result>; readonly status: 'succeeded' }>>;
    const app = run.result.app;
    if (app === undefined) throw new Error('NUL collision fixture has no App evidence.');
    return {
      ...current,
      run: {
        ...run,
        result: {
          ...run.result,
          app: {
            ...app,
            mcpBinding: { ...app.mcpBinding, serverDigest, serverName },
          },
        },
      },
    } as RuntimeAppPreviewProps;
  };
  const a = prepareRuntimeMcpHandoffAuthority(withBindingIdentity('server-digest\0server-name', 'tail'), (value) => value === 'portable');
  const b = prepareRuntimeMcpHandoffAuthority(withBindingIdentity('server-digest', 'server-name\0tail'), (value) => value === 'portable');

  expect(a).toBeUndefined();
  expect(b).toBeUndefined();
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
