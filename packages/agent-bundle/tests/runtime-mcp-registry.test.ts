import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  RuntimeGenerationStore,
  RuntimeMcpRegistry,
  RuntimeMcpRegistryCloseError,
  type DevRuntimeEventInput,
  type DevRuntimeMcpConnectionState,
  type DevRuntimeMcpOperationRequest,
  type DevRuntimeMcpRegistryReconcileInput,
  type DevRuntimeMcpServerDescriptor,
  type JsonValue,
  type RuntimeGeneration,
  type RuntimeMcpConnection,
  type RuntimeMcpConnector,
  type RuntimeMcpExecutionContext,
  type RuntimeMcpExecutionValue,
} from '../src/dev/index.ts';

const deferred = <T = void>(): Readonly<{
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
}> => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
};

const connectionState: DevRuntimeMcpConnectionState = Object.freeze({
  capabilities: Object.freeze({ tools: Object.freeze({}) }),
  protocolEra: 'modern',
  protocolVersion: '2025-06-18',
  server: Object.freeze({ name: 'fixture', version: '1.0.0' }),
});

const descriptor = (input: Readonly<{
  readonly definitionDigest?: string;
  readonly serverDigest?: string;
  readonly target?: string;
  readonly transportDigest?: string;
}> = {}): DevRuntimeMcpServerDescriptor => Object.freeze({
  definitionDigest: input.definitionDigest ?? 'definition-1',
  name: 'timeline',
  resources: Object.freeze([Object.freeze({ uri: 'timeline://current' })]),
  serverDigest: input.serverDigest ?? 'server-g1',
  target: input.target ?? 'portable',
  tools: Object.freeze([Object.freeze({ name: 'render_timeline' })]),
  transportDigest: input.transportDigest ?? 'transport-1',
});

const registryInput = (input: Readonly<{
  readonly definitionDigest?: string;
  readonly runtimeGenerationId?: string;
  readonly serverDigest?: string;
  readonly transportDigest?: string;
}> = {}): DevRuntimeMcpRegistryReconcileInput => Object.freeze({
  definitionDigest: input.definitionDigest ?? 'definition-1',
  runtimeGenerationId: input.runtimeGenerationId ?? 'g1',
  servers: Object.freeze([descriptor({
    definitionDigest: input.definitionDigest,
    serverDigest: input.serverDigest,
    transportDigest: input.transportDigest,
  })]),
  transportDigest: input.transportDigest ?? 'transport-1',
});

class TestConnection implements RuntimeMcpConnection {
  readonly state = connectionState;
  closed = false;
  relisted = false;
  readonly #close: () => Promise<void>;
  readonly #relist: () => Promise<DevRuntimeMcpConnectionState>;

  constructor(input: Readonly<{
    readonly close?: () => Promise<void>;
    readonly relist?: () => Promise<DevRuntimeMcpConnectionState>;
  }> = {}) {
    this.#close = input.close ?? (async () => undefined);
    this.#relist = input.relist ?? (async () => connectionState);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.#close();
  }

  async relist(): Promise<DevRuntimeMcpConnectionState> {
    this.relisted = true;
    return this.#relist();
  }
}

interface ConnectorHarness {
  readonly connections: TestConnection[];
  readonly connector: RuntimeMcpConnector;
  readonly pending: readonly Readonly<{
    readonly input: Readonly<{
      readonly descriptor: DevRuntimeMcpServerDescriptor;
      readonly sessionId: string;
      readonly signal: AbortSignal;
    }>;
    readonly result: ReturnType<typeof deferred<RuntimeMcpConnection>>;
  }>[];
}

const connectorHarness = (input: Readonly<{
  readonly deferAfter?: number;
  readonly failAfter?: number;
  readonly throwOnClose?: boolean;
}> = {}): ConnectorHarness => {
  const connections: TestConnection[] = [];
  const pending: Array<Readonly<{
    readonly input: Readonly<{
      readonly descriptor: DevRuntimeMcpServerDescriptor;
      readonly sessionId: string;
      readonly signal: AbortSignal;
    }>;
    readonly result: ReturnType<typeof deferred<RuntimeMcpConnection>>;
  }>> = [];
  let calls = 0;
  const connector: RuntimeMcpConnector = Object.freeze({
    connect: async (connectionInput: Parameters<RuntimeMcpConnector['connect']>[0]) => {
      calls += 1;
      if (input.failAfter !== undefined && calls >= input.failAfter) {
        throw new Error('fixture connector failed');
      }
      if (input.deferAfter !== undefined && calls >= input.deferAfter) {
        const result = deferred<RuntimeMcpConnection>();
        pending.push(Object.freeze({ input: connectionInput, result }));
        return result.promise;
      }
      const connection = new TestConnection({
        close: input.throwOnClose ? async () => { throw new Error('fixture close failed'); } : undefined,
      });
      connections.push(connection);
      return connection;
    },
  });
  return Object.freeze({ connections, connector, pending });
};

const createGenerationStore = async (retainInactive?: number): Promise<Readonly<{
  readonly close: () => Promise<void>;
  readonly commit: (id: string) => Promise<RuntimeGeneration>;
  readonly root: string;
  readonly store: RuntimeGenerationStore;
}>> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-mcp-registry-'));
  const store = new RuntimeGenerationStore({
    metadataCodec: {
      decode: (value): unknown => value,
      encode: (value): JsonValue => value as JsonValue,
    },
    ...(retainInactive === undefined ? {} : { retainInactive }),
    storageRoot: root,
    validateMetadata: ({ metadata }) => metadata,
  });
  const fixture: Readonly<{
    readonly close: () => Promise<void>;
    readonly commit: (id: string) => Promise<RuntimeGeneration>;
    readonly root: string;
    readonly store: RuntimeGenerationStore;
  }> = {
    close: async () => {
      await store.close().catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    },
    commit: async (id) => {
      const candidate = await store.begin({ id, sourceRevision: `source-${id}` });
      const prepared = await store.prepare(candidate, { assets: [], metadata: Object.freeze({ id }) });
      return store.commit(prepared);
    },
    root,
    store,
  };
  return Object.freeze(fixture);
};

const createRegistry = (input: Readonly<{
  readonly connector?: RuntimeMcpConnector;
  readonly events?: DevRuntimeEventInput[];
  readonly executor?: (context: RuntimeMcpExecutionContext) => Promise<RuntimeMcpExecutionValue>;
  readonly initialRegistry?: DevRuntimeMcpRegistryReconcileInput;
  readonly store: RuntimeGenerationStore;
}>): RuntimeMcpRegistry => new RuntimeMcpRegistry({
  artifactEpochId: () => 'artifact-1',
  connector: input.connector ?? connectorHarness().connector,
  createOperationId: (() => {
    let next = 0;
    return () => `operation-${++next}`;
  })(),
  createSessionId: (() => {
    let next = 0;
    return () => `session-${++next}`;
  })(),
  emit: (event) => { input.events?.push(event); },
  executor: input.executor ?? (async (context) => Object.freeze({
    stateVersion: 7,
    value: Object.freeze({ kind: context.request.kind, generation: context.generation.id }),
  })),
  generationStore: input.store,
  initialRegistry: input.initialRegistry ?? registryInput(),
  providerSessionId: 'provider-1',
  stateStoreId: 'state-1',
});

const request = (kind: DevRuntimeMcpOperationRequest['kind'], revision: number): DevRuntimeMcpOperationRequest => {
  if (kind === 'call-tool') {
    return Object.freeze({
      arguments: Object.freeze({ limit: 10 }),
      expectedSessionRevision: revision,
      kind,
      name: 'render_timeline',
    });
  }
  if (kind === 'read-resource') {
    return Object.freeze({ expectedSessionRevision: revision, kind, uri: 'timeline://current' });
  }
  return Object.freeze({ expectedSessionRevision: revision, kind });
};

it('opens only static registered descriptors and rejects stale server, target, and revision selectors', async () => {
  const fixture = await createGenerationStore();
  const registry = createRegistry({ store: fixture.store });
  try {
    await fixture.commit('g1');

    const session = await registry.open({
      expectedRegistryRevision: 1,
      serverName: 'timeline',
      target: 'portable',
    });
    expect(session.snapshot().binding).toMatchObject({
      registryRevision: 1,
      serverName: 'timeline',
      sessionRevision: 1,
      target: 'portable',
    });
    await expect(registry.open({ serverName: 'missing', target: 'portable' })).rejects.toThrow('Unknown runtime MCP server');
    await expect(registry.open({ serverName: 'timeline', target: 'claude' })).rejects.toThrow('Unknown runtime MCP server');
    await expect(registry.open({ expectedRegistryRevision: 2, serverName: 'timeline', target: 'portable' }))
      .rejects.toThrow('registry revision');
    expect(() => new RuntimeMcpRegistry({
      artifactEpochId: () => undefined,
      connector: connectorHarness().connector,
      emit: () => undefined,
      executor: async () => ({ stateVersion: 0, value: null }),
      generationStore: fixture.store,
      initialRegistry: Object.freeze({ ...registryInput(), servers: Object.freeze([descriptor(), descriptor()]) }),
      providerSessionId: 'provider-1',
      stateStoreId: 'state-1',
    })).toThrow('duplicate');
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('leases a generation per blocked operation while implementation updates preserve the ready connection and bindings', async () => {
  const fixture = await createGenerationStore(0);
  const connector = connectorHarness();
  const entered = deferred<void>();
  const release = deferred<void>();
  const registry = createRegistry({
    connector: connector.connector,
    executor: async (context) => {
      if (context.request.kind === 'call-tool') {
        entered.resolve();
        await release.promise;
      }
      return Object.freeze({ stateVersion: 3, value: Object.freeze({ generation: context.generation.id }) });
    },
    store: fixture.store,
  });
  try {
    await fixture.commit('g1');
    const session = await registry.open({ serverName: 'timeline', target: 'portable' });
    const before = session.snapshot();
    const first = session.execute(request('call-tool', before.binding.sessionRevision));
    await entered.promise;
    await fixture.commit('g2');

    const updated = await registry.reconcile(registryInput({ runtimeGenerationId: 'g2', serverDigest: 'server-g2' }));
    expect(updated.action).toBe('implementation-updated');
    expect(session.snapshot().binding).toMatchObject({
      registryRevision: before.binding.registryRevision,
      serverDigest: 'server-g2',
      sessionId: before.binding.sessionId,
      sessionRevision: before.binding.sessionRevision,
    });
    expect(connector.connections).toHaveLength(1);

    release.resolve();
    expect((await first).vector).toMatchObject({ runtimeGenerationId: 'g1', sourceRevision: 'source-g1' });
    expect((await session.execute(request('list-tools', before.binding.sessionRevision))).vector.runtimeGenerationId).toBe('g2');
    await expect(fixture.store.lease('g1')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('returns static lists and complete leased vectors for every MCP operation', async () => {
  const fixture = await createGenerationStore();
  const observed: RuntimeMcpExecutionContext[] = [];
  const registry = createRegistry({
    executor: async (context) => {
      observed.push(context);
      return Object.freeze({ stateVersion: 42, value: Object.freeze({ result: context.request.kind }) });
    },
    store: fixture.store,
  });
  try {
    await fixture.commit('g1');
    const session = await registry.open({ serverName: 'timeline', target: 'portable' });
    const revision = session.snapshot().binding.sessionRevision;
    const results = await Promise.all([
      session.execute(request('list-tools', revision)),
      session.execute(request('list-resources', revision)),
      session.execute(request('read-resource', revision)),
      session.execute(request('call-tool', revision)),
    ]);
    expect(results[0]!.value).toEqual([Object.freeze({ name: 'render_timeline' })]);
    expect(results[1]!.value).toEqual([Object.freeze({ uri: 'timeline://current' })]);
    expect(results[2]!.value).toEqual({ result: 'read-resource' });
    expect(results[3]!.value).toEqual({ result: 'call-tool' });
    for (const result of results) {
      expect(result).toMatchObject({
        operationId: expect.any(String),
        sessionId: session.snapshot().binding.sessionId,
        sessionRevision: revision,
        vector: {
          artifactEpochId: 'artifact-1',
          providerSessionId: 'provider-1',
          runtimeGenerationId: 'g1',
          sourceRevision: 'source-g1',
          stateStoreId: 'state-1',
          stateVersion: expect.any(Number),
        },
      });
    }
    expect(observed.map((entry) => entry.request.kind).sort()).toEqual(['call-tool', 'read-resource']);
    await expect(session.execute(Object.freeze({
      arguments: Object.freeze({}),
      expectedSessionRevision: revision,
      kind: 'call-tool',
      name: 'undeclared',
    }))).rejects.toThrow('not declared');
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('makes public definition restarts visible before awaiting replacement connection and invalidates old bindings', async () => {
  const fixture = await createGenerationStore();
  const events: DevRuntimeEventInput[] = [];
  const connector = connectorHarness({ deferAfter: 2 });
  const registry = createRegistry({ connector: connector.connector, events, store: fixture.store });
  try {
    await fixture.commit('g1');
    const session = await registry.open({ serverName: 'timeline', target: 'portable' });
    const before = session.snapshot();
    const reconciling = registry.reconcile(registryInput({ definitionDigest: 'definition-2' }));
    expect(session.snapshot()).toMatchObject({
      binding: { registryRevision: 2, sessionRevision: 2 },
      state: 'restarting',
    });
    expect(events.map((event) => event.type)).toContain('runtime.mcp.restarting');
    await expect(session.execute(request('list-tools', 2))).rejects.toThrow('restarting');
    expect(connector.pending).toHaveLength(1);
    const replacement = new TestConnection();
    connector.pending[0]!.result.resolve(replacement);
    const result = await reconciling;
    expect(result).toMatchObject({
      action: 'sessions-restarted',
      invalidatedBindings: [{
        sessionId: before.binding.sessionId,
        sessionRevision: before.binding.sessionRevision,
      }],
      registryRevision: 2,
      restartedSessionIds: [before.binding.sessionId],
    });
    expect(session.snapshot().state).toBe('ready');
    expect(replacement.relisted).toBe(true);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['runtime.mcp.restarting', 'runtime.mcp.ready']));
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('keeps a failed controlled restart on its new binding revision and emits a failed result', async () => {
  const fixture = await createGenerationStore();
  const events: DevRuntimeEventInput[] = [];
  const connector = connectorHarness({ failAfter: 2 });
  const registry = createRegistry({ connector: connector.connector, events, store: fixture.store });
  try {
    await fixture.commit('g1');
    const session = await registry.open({ serverName: 'timeline', target: 'portable' });
    const before = session.snapshot();
    const result = await registry.reconcile(registryInput({ transportDigest: 'transport-2' }));
    expect(result).toMatchObject({
      action: 'restart-failed',
      invalidatedBindings: [{
        sessionId: before.binding.sessionId,
        sessionRevision: before.binding.sessionRevision,
      }],
      registryRevision: 2,
    });
    expect(session.snapshot()).toMatchObject({
      binding: { registryRevision: 2, sessionRevision: 2 },
      state: 'failed',
    });
    await expect(session.execute(request('list-tools', 1))).rejects.toThrow('revision');
    expect(events.map((event) => event.type)).toContain('runtime.mcp.failed');
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('replays the last 64 sequenced results before ordered live delivery and reports cursor gaps', async () => {
  const fixture = await createGenerationStore();
  const registry = createRegistry({ store: fixture.store });
  try {
    await fixture.commit('g1');
    for (let index = 0; index < 66; index += 1) {
      await registry.reconcile(registryInput({ serverDigest: `server-${index}` }));
    }
    const replay: Array<unknown> = [];
    const gapSubscription = registry.subscribe({ afterSequence: 0 }, (message) => { replay.push(message); });
    expect(replay[0]).toMatchObject({
      earliestAvailableSequence: 3,
      latestDroppedSequence: 2,
      requestedAfterSequence: 0,
      type: 'replay.gap',
    });
    expect(replay).toHaveLength(65);
    gapSubscription.unsubscribe();

    const live: Array<{ readonly sequence: number }> = [];
    const subscription = registry.subscribe({ afterSequence: 66 }, (message) => {
      if ('sequence' in message) live.push(message);
    });
    await registry.reconcile(registryInput({ serverDigest: 'server-live' }));
    subscription.unsubscribe();
    expect(live).toEqual([expect.objectContaining({ sequence: 67 })]);
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('manually restarts and closes a revision-checked owned session while session views only observe closure', async () => {
  const fixture = await createGenerationStore();
  const registry = createRegistry({ store: fixture.store });
  try {
    await fixture.commit('g1');
    const session = await registry.open({ serverName: 'timeline', target: 'portable' });
    const before = session.snapshot();
    const view = registry.session(before.binding.sessionId);
    if (view === undefined) throw new Error('Expected a non-owning session view.');
    let watched = 0;
    const observation = view.watchClosed(() => { watched += 1; });
    expect(observation.closed).toBe(false);
    const restarted = await registry.restart({
      expectedSessionRevision: before.binding.sessionRevision,
      sessionId: before.binding.sessionId,
    });
    expect(restarted).toMatchObject({ action: 'sessions-restarted', registryRevision: before.binding.registryRevision });
    expect(session.snapshot().binding.sessionRevision).toBe(before.binding.sessionRevision + 1);
    await expect(registry.closeSession({
      expectedSessionRevision: before.binding.sessionRevision,
      sessionId: before.binding.sessionId,
    })).rejects.toThrow('revision');
    await registry.closeSession({
      expectedSessionRevision: before.binding.sessionRevision + 1,
      sessionId: before.binding.sessionId,
    });
    expect(watched).toBe(1);
    expect(view.watchClosed(() => undefined).closed).toBe(true);
    observation.unsubscribe();
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('closes idempotently, rejects new work, and aggregates connector cleanup failures', async () => {
  const fixture = await createGenerationStore();
  const connector = connectorHarness({ throwOnClose: true });
  const registry = createRegistry({ connector: connector.connector, store: fixture.store });
  try {
    await fixture.commit('g1');
    await registry.open({ serverName: 'timeline', target: 'portable' });
    const first = registry.close();
    const second = registry.close();
    expect(second).toBe(first);
    await expect(first).rejects.toBeInstanceOf(RuntimeMcpRegistryCloseError);
    await expect(registry.open({ serverName: 'timeline', target: 'portable' })).rejects.toThrow('closed');
  } finally {
    await fixture.close();
  }
});

it('settles an aborted pending open before registry close resolves', async () => {
  const fixture = await createGenerationStore();
  const connector = connectorHarness({ deferAfter: 1 });
  const registry = createRegistry({ connector: connector.connector, store: fixture.store });
  try {
    await fixture.commit('g1');
    const opening = registry.open({ serverName: 'timeline', target: 'portable' });
    await Promise.resolve();
    expect(connector.pending).toHaveLength(1);
    let closed = false;
    const closing = registry.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(closed).toBe(false);
    connector.pending[0]!.result.resolve(new TestConnection());
    await expect(opening).rejects.toThrow('closed');
    await closing;
    expect(closed).toBe(true);
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('settles an aborted private activation preparation before registry close resolves', async () => {
  const fixture = await createGenerationStore();
  const connector = connectorHarness({ deferAfter: 2 });
  const registry = createRegistry({ connector: connector.connector, store: fixture.store });
  try {
    await fixture.commit('g1');
    await registry.open({ serverName: 'timeline', target: 'portable' });
    const staging = registry.prepareActivationReconcile(registryInput({ definitionDigest: 'definition-2' }));
    await Promise.resolve();
    expect(connector.pending).toHaveLength(1);
    let closed = false;
    const closing = registry.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(closed).toBe(false);
    connector.pending[0]!.result.resolve(new TestConnection());
    await expect(staging).rejects.toThrow('closed');
    await closing;
    expect(closed).toBe(true);
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});

it('prepares private activation without public visibility, commits synchronously with buffered publish, and aborts without changes', async () => {
  const fixture = await createGenerationStore();
  const connector = connectorHarness({ deferAfter: 2 });
  const events: DevRuntimeEventInput[] = [];
  const entered = deferred<void>();
  const release = deferred<void>();
  const registry = createRegistry({
    connector: connector.connector,
    events,
    executor: async (context) => {
      if (context.request.kind === 'call-tool') {
        entered.resolve();
        await release.promise;
      }
      return Object.freeze({ stateVersion: 9, value: Object.freeze({ generation: context.generation.id }) });
    },
    store: fixture.store,
  });
  try {
    await fixture.commit('g1');
    await fixture.commit('g2');
    const session = await registry.open({ serverName: 'timeline', target: 'portable' });
    const before = session.snapshot();
    const running = session.execute(request('call-tool', before.binding.sessionRevision));
    await entered.promise;
    const staged = registry.prepareActivationReconcile(registryInput({
      definitionDigest: 'definition-2',
      runtimeGenerationId: 'g2',
    }));
    expect(session.snapshot()).toEqual(before);
    expect(events).toEqual([]);
    expect((await session.execute(request('list-tools', before.binding.sessionRevision))).vector.runtimeGenerationId).toBe('g1');
    expect(connector.pending).toHaveLength(1);
    connector.pending[0]!.result.resolve(new TestConnection());
    const prepared = await staged;
    expect(session.snapshot()).toEqual(before);
    await expect(registry.open({ serverName: 'timeline', target: 'portable' })).rejects.toThrow('reserved');
    const committed = registry.commitActivationReconcile(prepared);
    expect(session.snapshot()).toMatchObject({
      binding: { registryRevision: 2, sessionRevision: 2 },
      state: 'ready',
    });
    expect(events).toEqual([]);
    committed.publish();
    expect(events.map((event) => event.type)).toContain('runtime.mcp.ready');
    release.resolve();
    expect(await running).toMatchObject({
      sessionRevision: before.binding.sessionRevision,
      vector: { runtimeGenerationId: 'g1' },
    });
    await committed.finalize();

    const abort = await registry.prepareActivationReconcile(registryInput({
      definitionDigest: 'definition-2',
      runtimeGenerationId: 'g1',
      serverDigest: 'server-g1',
    }));
    await registry.abortActivationReconcile(abort);
    expect(session.snapshot().binding.serverDigest).toBe('server-g1');
  } finally {
    await registry.close().catch(() => undefined);
    await fixture.close();
  }
});
