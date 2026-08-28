import { expect, it } from '@rstest/core';

import {
  McpAppRuntimePreviewService,
  type McpAppRuntimeOperationClock,
  type McpAppRuntimePreviewServiceOptions,
} from '../src/dev/mcp-app-runtime-preview-service.ts';
import { McpAppRuntimeBindingService } from '../src/dev/mcp-app-runtime-binding-service.ts';
import type { DevRuntimeClientSurfaceProxyBinding, DevRuntimeMcpRegistryMessage, DevRuntimeMcpSessionView, DevRuntimeSession } from '../src/dev/runtime-provider.ts';
import type { DevRuntimeMcpOperationRequest, DevRuntimeMcpOperationResult, DevRuntimeMcpSessionSnapshot, DevRuntimeRun, RuntimeVector } from '../src/dev/runtime-protocol.ts';
import type { JsonValue } from '../src/dev/types.ts';

const vector: RuntimeVector = Object.freeze({
  providerSessionId: 'provider-private',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'state-private',
  stateVersion: 0,
});

const run = Object.freeze({
  completedAt: '2026-08-15T00:00:01.000Z',
  id: 'run-a',
  input: Object.freeze({ city: 'Paris' }),
  result: Object.freeze({
    app: Object.freeze({
      mcpBinding: Object.freeze({
        definitionDigest: 'definition-a', registryRevision: 3, serverDigest: 'server-a', serverName: 'weather',
        sessionId: 'session-a', sessionRevision: 2, target: 'portable', transportDigest: 'transport-a',
      }),
      resourceUri: 'ui://weather/forecast.html',
      surfaceId: 'mcp.edit-weather',
    }),
    protocol: Object.freeze({ content: Object.freeze([{ text: 'Sunny', type: 'text' }]) }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'state-private', stateVersion: 0 }) }),
    trace: Object.freeze([]),
    tree: Object.freeze([]),
  }),
  startedAt: '2026-08-15T00:00:00.000Z',
  status: 'succeeded' as const,
  surfaceId: 'mcp.render_weather',
  target: 'portable',
  vector,
} satisfies DevRuntimeRun);

const snapshot = (): DevRuntimeMcpSessionSnapshot => Object.freeze({
  binding: Object.freeze({
    ...run.result.app.mcpBinding,
    providerSessionId: 'provider-private',
    stateStoreId: 'state-private',
  }),
  connection: Object.freeze({
    capabilities: Object.freeze({ resources: Object.freeze({}), tools: Object.freeze({}) }),
    protocolEra: 'modern' as const,
    protocolVersion: '2026-01-26',
    server: Object.freeze({ name: 'weather', version: '1.0.0' }),
  }),
  state: 'ready' as const,
});

type SessionViewOptions = Readonly<{
  readonly csp?: JsonValue;
  readonly execute?: (
    request: DevRuntimeMcpOperationRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> | undefined,
    fallback: () => DevRuntimeMcpOperationResult,
  ) => Promise<DevRuntimeMcpOperationResult>;
  readonly permissions?: JsonValue;
}>;

const createSessionView = (
  requests: DevRuntimeMcpOperationRequest[],
  options: SessionViewOptions = {},
): DevRuntimeMcpSessionView => ({
  execute: async (request, operationOptions) => {
    requests.push(request);
    const value: JsonValue = request.kind === 'list-tools'
      ? [
        { _meta: { ui: { resourceUri: 'ui://weather/other.html', visibility: ['app'] } }, name: 'foreign-app' },
        { _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['model'] } }, name: 'model-only-app' },
        { _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['app'] } }, name: 'show-weather' },
      ]
      : request.kind === 'list-resources'
        ? [{ _meta: { ui: { resourceUri: 'ui://weather/forecast.html' } }, mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' }]
        : request.kind === 'read-resource'
          ? { contents: [{ _meta: { ui: {
            ...(options.csp === undefined ? {} : { csp: options.csp }),
            ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
          } }, mimeType: 'text/html;profile=mcp-app', text: '<main>Weather</main>', uri: request.uri }] }
          : { content: [{ text: 'called', type: 'text' }] };
    const fallback = (): DevRuntimeMcpOperationResult => Object.freeze({ operationId: `op-${requests.length}`, sessionId: 'session-a', sessionRevision: 2, value, vector });
    return options.execute === undefined ? fallback() : options.execute(request, operationOptions, fallback);
  },
  snapshot,
  watchClosed: () => Object.freeze({ closed: false, unsubscribe: () => undefined }),
});

const createRuntimeFixture = (options: Readonly<{
  readonly closeBinding?: () => Promise<void>;
  readonly closeProxy?: () => Promise<void>;
  readonly csp?: JsonValue;
  readonly execute?: SessionViewOptions['execute'];
  readonly failProxyOpen?: boolean;
  readonly openRuntimeClientSurface?: (surfaceId: string, ...policy: readonly unknown[]) => Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  readonly operationClock?: McpAppRuntimeOperationClock;
  readonly permissions?: JsonValue;
}> = {}) => {
  const requests: DevRuntimeMcpOperationRequest[] = [];
  const openedClientSurfaces: string[] = [];
  const openedClientSurfacePolicies: unknown[] = [];
  const controls: string[] = [];
  const emitted: unknown[] = [];
  let listener: ((message: DevRuntimeMcpRegistryMessage) => void) | undefined;
  const view = createSessionView(requests, options);
  const runtime = {
    clientSurface: () => undefined,
    close: async () => { controls.push('close'); },
    invoke: async () => run,
    mcpRegistry: Object.freeze({
      close: async () => undefined,
      closeSession: async () => { controls.push('closeSession'); },
      open: async () => { controls.push('open'); return view as never; },
      reconcile: async () => { throw new Error('unused'); },
      restart: async () => { controls.push('restart'); throw new Error('unused'); },
      session: (id: string) => id === 'session-a' ? view : undefined,
      snapshot: () => undefined,
      subscribe: (_options: unknown, next: (message: DevRuntimeMcpRegistryMessage) => void) => {
        listener = next;
        return Object.freeze({ unsubscribe: () => undefined });
      },
    }),
    providerSessionId: 'provider-private',
    readAsset: async () => undefined,
    readRunFlight: async () => undefined,
    reconcilePreparedRuntime: async () => undefined,
    replay: async () => run,
    resetState: async () => ({ stateStoreId: 'state-private', stateVersion: 0 }),
    run: (id: string) => id === run.id ? run : undefined,
    runs: () => [run],
    status: () => ({ descriptor: { environmentVariables: [], id: 'fixture', label: 'Fixture', schemaVersion: 1 }, diagnostics: [], hmrReady: true, state: 'active' as const }),
    surfaces: () => [],
  } satisfies DevRuntimeSession;
  const bindingAuthority = new McpAppRuntimeBindingService();
  if (options.closeBinding !== undefined) {
    const closeBinding = bindingAuthority.closeBinding.bind(bindingAuthority);
    bindingAuthority.closeBinding = async (bindingId) => {
      await options.closeBinding?.();
      return closeBinding(bindingId);
    };
  }
  const serviceOptions: McpAppRuntimePreviewServiceOptions = {
    bindingAuthority,
    configExtensions: () => Object.freeze({ descriptors: [], extensions: Object.freeze({}), projectRoot: '/project', sourceRevision: 'source-a' }),
    emit: (details) => { emitted.push(details); },
    openRuntimeClientSurface: async (surfaceId, ...policy) => {
      openedClientSurfaces.push(surfaceId);
      openedClientSurfacePolicies.push(policy[0]);
      if (options.failProxyOpen === true) throw new Error('proxy open failed');
      if (options.openRuntimeClientSurface !== undefined) return options.openRuntimeClientSurface(surfaceId, ...policy);
      return Object.freeze({ bootstrapUrl: `http://proxy.test/${surfaceId}`, close: options.closeProxy ?? (async () => undefined), origin: 'http://proxy.test', surfaceId, webSocketPath: '/rsbuild-hmr' });
    },
    runtime,
    ...(options.operationClock === undefined ? {} : { operationClock: options.operationClock }),
  };
  const service = new McpAppRuntimePreviewService(serviceOptions);
  return Object.freeze({
    controls,
    emitted,
    openedClientSurfacePolicies,
    openedClientSurfaces,
    requests,
    service,
    deliver: (message: DevRuntimeMcpRegistryMessage) => listener?.(message),
  });
};

const eventually = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error('Timed out waiting for runtime MCP App preview state.');
};

const deferred = <Value>(): Readonly<{
  readonly promise: Promise<Value>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: Value) => void;
}> => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
};

class ControlledClock {
  #now = 0;
  #next = 0;
  readonly #timers = new Map<number, Readonly<{ readonly callback: () => void; readonly due: number }>>();
  readonly delays: number[] = [];

  clearTimeout(id: ReturnType<typeof setTimeout>): void { this.#timers.delete(id as unknown as number); }

  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
    const id = ++this.#next;
    this.delays.push(milliseconds);
    this.#timers.set(id, Object.freeze({ callback, due: this.#now + milliseconds }));
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  advance(milliseconds: number): void {
    const deadline = this.#now + milliseconds;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.due <= deadline)
        .sort(([left], [right]) => left - right)[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.#now = timer.due;
      timer.callback();
    }
    this.#now = deadline;
  }
}

it('derives an Apps preview only from one stored succeeded run and opens its distinct client surface', async () => {
  const { controls, openedClientSurfaces, requests, service } = createRuntimeFixture();

  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

  expect(preview).toMatchObject({
    binding: { sessionId: 'session-a', sessionRevision: 2 },
    clientSurface: { bootstrapUrl: 'http://proxy.test/mcp.edit-weather', origin: 'http://proxy.test', webSocketPath: '/rsbuild-hmr' },
    kind: 'apps',
    result: { isError: false, modelVisible: { content: [{ text: 'Sunny', type: 'text' }] } },
    session: { state: 'ready' },
  });
  if (preview.profile.kind !== 'apps') throw new Error('Expected an admitted Apps host profile.');
  expect(preview.metadata.tool.standard.ui).toEqual({ resourceUri: 'ui://weather/forecast.html', visibility: ['app'] });
  expect(preview.profile.hostContext.platform).toBe('web');
  expect(requests).toEqual([
    { expectedSessionRevision: 2, kind: 'list-tools' },
    { expectedSessionRevision: 2, kind: 'list-resources' },
    { expectedSessionRevision: 2, kind: 'read-resource', uri: 'ui://weather/forecast.html' },
  ]);
  expect(controls).toEqual([]);
  expect(openedClientSurfaces).toEqual(['mcp.edit-weather']);
  expect(JSON.stringify(preview)).not.toContain('provider-private');
  expect(JSON.stringify(preview)).not.toContain('state-private');
  await expect(service.create({ expectedGenerationId: 'generation-b', profileId: 'portable', runId: 'run-a' })).rejects.toThrow('generation');
});

it('derives one closed child CSP before proxy acquisition while retaining declared permissions as unapproved evidence', async () => {
  const { openedClientSurfacePolicies, service } = createRuntimeFixture({
    csp: { connectDomains: ['https://api.weather.test', 'not-a-canonical-origin'] },
    permissions: { camera: {} },
  });

  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  expect(openedClientSurfacePolicies).toEqual([{
    contentSecurityPolicy: "default-src 'none'; base-uri 'self'; connect-src https://api.weather.test; frame-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  }]);
  if (preview.kind !== 'apps') throw new Error('Expected an admitted Apps preview.');
  expect(preview.documentPolicy).toMatchObject({ allow: '', approvedPermissions: {}, revision: 1 });
  expect(preview.documentPolicy.warnings).toEqual([{ code: 'csp-source-rejected', value: 'not-a-canonical-origin' }]);
});

it('subscribes to registry invalidations, revokes exactly once, and fails closed after a replay gap', async () => {
  const { controls, deliver, emitted, service } = createRuntimeFixture();
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

  deliver(Object.freeze({
    action: 'sessions-restarted' as const,
    invalidatedBindings: Object.freeze([{ sessionId: 'session-a', sessionRevision: 2 }]),
    registryRevision: 4,
    restartedSessionIds: Object.freeze(['session-a']),
    runtimeGenerationId: 'generation-b',
    sequence: 1,
  }));
  await eventually(() => service.get(preview.binding.id) === undefined);
  expect(emitted).toEqual([{
    bindingId: preview.binding.id,
    reason: 'session-restarted',
    sessionId: 'session-a',
    sessionRevision: 2,
    state: 'revoked',
  }]);
  expect(controls).toEqual([]);

  deliver(Object.freeze({ earliestAvailableSequence: 4, latestDroppedSequence: 3, requestedAfterSequence: 0, type: 'replay.gap' as const }));
  await eventually(() => emitted.length === 1);
  await expect(service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' })).rejects.toThrow('not available');
});

it('binds a call-tool consent grant to one exact operation and rejects a browser-selected document scope', async () => {
  const { requests, service } = createRuntimeFixture();
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  await expect(service.operate(preview.binding.id, { kind: 'tools/call', name: 'show-weather' })).rejects.toThrow('requires an approved consent');
  await expect(service.createConsent(preview.binding.id, {
    actionFingerprint: 'browser-non-authority', capability: 'call-tool', details: { arguments: {}, name: 'show-weather' }, scope: 'document', summary: 'forged scope',
  })).rejects.toThrow('consent request is invalid');

  const created = await service.createConsent(preview.binding.id, {
    actionFingerprint: 'browser-non-authority', capability: 'call-tool', details: { arguments: {}, name: 'show-weather' }, scope: 'action', summary: 'forged summary is not authority',
  });
  expect(created.documentPolicy.revision).toBe(1);
  const decision = await service.decideConsent(preview.binding.id, created.challenge.id, 'allow-once');
  expect(decision.grant).toMatchObject({ bindingId: preview.binding.id, capability: 'call-tool', scope: 'action' });
  await expect(service.operate(preview.binding.id, {
    consentId: decision.grant?.authorizationId,
    kind: 'tools/call',
    name: 'show-weather',
  })).resolves.toMatchObject({ result: { operationId: 'op-4' } });
  await expect(service.operate(preview.binding.id, {
    consentId: decision.grant?.authorizationId,
    kind: 'tools/call',
    name: 'show-weather',
  })).rejects.toThrow('requires an approved consent');
  expect(requests.at(-1)).toEqual({ arguments: {}, expectedSessionRevision: 2, kind: 'call-tool', name: 'show-weather' });
});

it('times out and releases hung Runtime App operations without waiting for late provider settlement', async () => {
  const clock = new ControlledClock();
  const signals: Array<AbortSignal | undefined> = [];
  const late = Array.from({ length: 5 }, () => deferred<DevRuntimeMcpOperationResult>());
  let initial = 0;
  let pending = 0;
  const { service } = createRuntimeFixture({
    execute: async (_request, options, fallback) => {
      if (initial < 3) {
        initial += 1;
        return fallback();
      }
      const held = late[pending]!;
      pending += 1;
      signals.push(options?.signal);
      return held.promise;
    },
    operationClock: clock,
  });
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  const operations = Array.from({ length: 4 }, () => service.operate(preview.binding.id, {
    kind: 'resources/read' as const,
    uri: 'ui://weather/forecast.html',
  }));

  await eventually(() => signals.length === 4);
  expect(clock.delays).toEqual([30_000, 30_000, 30_000, 30_000]);
  await expect(service.operate(preview.binding.id, {
    kind: 'resources/read', uri: 'ui://weather/forecast.html',
  })).rejects.toThrow('operation limit reached');

  clock.advance(30_000);
  for (const operation of operations) {
    await expect(operation).rejects.toMatchObject({
      code: 'AB8023',
      message: 'Runtime MCP App operation exceeded its 30 second deadline.',
      status: 502,
    });
  }
  expect(signals).toEqual([expect.any(AbortSignal), expect.any(AbortSignal), expect.any(AbortSignal), expect.any(AbortSignal)]);
  expect(signals.every((signal) => signal?.aborted === true)).toBe(true);

  const reclaimed = service.operate(preview.binding.id, { kind: 'resources/read', uri: 'ui://weather/forecast.html' });
  await eventually(() => signals.length === 5);
  await expect(service.close(preview.binding.id)).resolves.toBeUndefined();
  await expect(reclaimed).rejects.toThrow('cancelled');
  expect(signals.every((signal) => signal?.aborted === true)).toBe(true);

  late[0]!.reject(new Error('late provider rejection'));
  for (const held of late.slice(1)) held.resolve(Object.freeze({
    operationId: 'late-operation', sessionId: 'session-a', sessionRevision: 2, value: Object.freeze({ content: [] }), vector,
  }));
  await Promise.allSettled(late.map((held) => held.promise));
  expect(service.get(preview.binding.id)).toBeUndefined();
});

it('reclaims a hung Runtime App operation when its caller aborts', async () => {
  const clock = new ControlledClock();
  const held = Array.from({ length: 2 }, () => deferred<DevRuntimeMcpOperationResult>());
  const signals: AbortSignal[] = [];
  let aborts = 0;
  let initial = 0;
  let pending = 0;
  const { service } = createRuntimeFixture({
    execute: async (_request, options, fallback) => {
      if (initial < 3) {
        initial += 1;
        return fallback();
      }
      const signal = options?.signal;
      if (signal === undefined) throw new Error('Runtime App operation did not receive a cancellation signal.');
      signals.push(signal);
      signal.addEventListener('abort', () => { aborts += 1; }, { once: true });
      return held[pending++]!.promise;
    },
    operationClock: clock,
  });
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  const caller = new AbortController();
  const operation = service.operate(preview.binding.id, {
    kind: 'resources/read', uri: 'ui://weather/forecast.html',
  }, Object.freeze({ signal: caller.signal }));
  await eventually(() => signals.length === 1);
  const reason = new DOMException('Caller cancelled the Runtime App operation.', 'AbortError');
  caller.abort(reason);
  await expect(operation).rejects.toBe(reason);
  expect(aborts).toBe(1);

  const reclaimed = service.operate(preview.binding.id, { kind: 'resources/read', uri: 'ui://weather/forecast.html' });
  await eventually(() => signals.length === 2);
  await expect(service.close(preview.binding.id)).resolves.toBeUndefined();
  await expect(reclaimed).rejects.toThrow('cancelled');
  expect(aborts).toBe(2);

  held[0]!.resolve(Object.freeze({ operationId: 'late-cancelled', sessionId: 'session-a', sessionRevision: 2, value: Object.freeze({ content: [] }), vector }));
  held[1]!.reject(new Error('late cancelled provider rejection'));
  await Promise.allSettled(held.map((pendingOperation) => pendingOperation.promise));
});

it('retains only the frozen App-visible catalog and rejects hidden actions before provider execution', async () => {
  const { requests, service } = createRuntimeFixture();
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

  await expect(service.operate(preview.binding.id, { kind: 'tools/list' })).resolves.toMatchObject({
    result: { value: { tools: [{ name: 'show-weather' }] } },
  });
  await expect(service.operate(preview.binding.id, { kind: 'resources/list' })).resolves.toMatchObject({
    result: { value: { resources: [{ uri: 'ui://weather/forecast.html' }] } },
  });
  await expect(service.operate(preview.binding.id, {
    kind: 'resources/read', uri: 'ui://weather/other.html',
  })).rejects.toThrow('not in the binding catalog');

  for (let attempt = 0; attempt < 9; attempt += 1) {
    await expect(service.createConsent(preview.binding.id, {
      actionFingerprint: `server-fingerprint-${attempt}`, capability: 'call-tool', details: { arguments: {}, name: 'foreign-app' }, scope: 'action', summary: 'foreign App tool',
    })).rejects.toThrow('not in the binding catalog');
  }
  await expect(service.createConsent(preview.binding.id, {
    actionFingerprint: 'visible-after-hidden', capability: 'call-tool', details: { arguments: {}, name: 'show-weather' }, scope: 'action', summary: 'visible App tool',
  })).resolves.toMatchObject({ challenge: { request: { capability: 'call-tool' } } });
  expect(requests).toHaveLength(3);
});

it('persists only effective declared document policy approvals in the binding snapshot', async () => {
  const undeclared = createRuntimeFixture();
  const undeclaredPreview = await undeclared.service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  const ignored = await undeclared.service.createConsent(undeclaredPreview.binding.id, {
    actionFingerprint: 'ignored-camera', capability: 'camera', details: {}, scope: 'document', summary: 'undeclared camera',
  });
  const ignoredDecision = await undeclared.service.decideConsent(undeclaredPreview.binding.id, ignored.challenge.id, 'allow-once');
  expect(ignoredDecision.documentPolicy.revision).toBe(1);
  expect(undeclared.service.get(undeclaredPreview.binding.id)).toMatchObject({ documentPolicy: { revision: 1 } });

  const declared = createRuntimeFixture({ permissions: { camera: {} } });
  const declaredPreview = await declared.service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  const accepted = await declared.service.createConsent(declaredPreview.binding.id, {
    actionFingerprint: 'accepted-camera', capability: 'camera', details: {}, scope: 'document', summary: 'declared camera',
  });
  const acceptedDecision = await declared.service.decideConsent(declaredPreview.binding.id, accepted.challenge.id, 'allow-once');
  expect(acceptedDecision.documentPolicy).toMatchObject({ revision: 2 });
  expect(declared.service.get(declaredPreview.binding.id)).toMatchObject({ documentPolicy: { revision: 2 } });
});

it('awaits matching session-close App cleanup after publishing its terminal invalidation', async () => {
  let releaseProxy: (() => void) | undefined;
  const { emitted, service } = createRuntimeFixture({
    closeProxy: async () => {
      await new Promise<void>((resolvePromise) => { releaseProxy = resolvePromise; });
    },
  });
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

  let settled = false;
  const closing = service.closeSession('session-a', 2).then(() => { settled = true; });
  await eventually(() => releaseProxy !== undefined);
  expect(settled).toBe(false);
  expect(service.get(preview.binding.id)).toBeUndefined();
  expect(emitted).toEqual([expect.objectContaining({ bindingId: preview.binding.id, reason: 'session-closed', state: 'revoked' })]);
  releaseProxy?.();
  await closing;
  expect(settled).toBe(true);
});

it('joins a late runtime client-surface acquisition before manual session cleanup returns', async () => {
  let resolveProxy: ((proxy: DevRuntimeClientSurfaceProxyBinding) => void) | undefined;
  let proxyCloseCalls = 0;
  let surfaceOpenCalls = 0;
  const { service } = createRuntimeFixture({
    openRuntimeClientSurface: async () => new Promise<DevRuntimeClientSurfaceProxyBinding>((resolvePromise) => {
      surfaceOpenCalls += 1;
      resolveProxy = resolvePromise;
    }),
  });
  const creating = service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  await eventually(() => surfaceOpenCalls === 1 && resolveProxy !== undefined);

  let closed = false;
  const closing = service.closeSession('session-a', 2).then(() => { closed = true; });
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  expect(closed).toBe(false);

  resolveProxy?.(Object.freeze({
    bootstrapUrl: 'http://proxy.test/app.weather',
    close: async () => { proxyCloseCalls += 1; },
    origin: 'http://proxy.test',
    surfaceId: 'app.weather',
    webSocketPath: '/rsbuild-hmr',
  }));
  await closing;
  await expect(creating).rejects.toThrow('stable session changed');
  expect(proxyCloseCalls).toBe(1);
  await expect(service.closeAll()).resolves.toBeUndefined();
  expect(proxyCloseCalls).toBe(1);
});

it('logically revokes before retaining failed runtime preview cleanup for an explicit retry', async () => {
  let closeAttempts = 0;
  const { emitted, service } = createRuntimeFixture({
    closeProxy: async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('proxy close failed');
    },
  });
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  await expect(service.close(preview.binding.id)).rejects.toBeInstanceOf(AggregateError);
  expect(service.get(preview.binding.id)).toBeUndefined();
  expect(service.isRevoked(preview.binding.id)).toBe(true);
  expect(emitted).toEqual([expect.objectContaining({ bindingId: preview.binding.id, reason: 'manual-close', state: 'revoked' })]);
  await expect(service.close(preview.binding.id)).resolves.toBeUndefined();
  expect(closeAttempts).toBe(2);
  expect(service.get(preview.binding.id)).toBeUndefined();
  expect(emitted).toHaveLength(1);
});

it('aggregates binding and proxy cleanup failures while retaining both for retry', async () => {
  let bindingAttempts = 0;
  let proxyAttempts = 0;
  const { service } = createRuntimeFixture({
    closeBinding: async () => {
      bindingAttempts += 1;
      if (bindingAttempts === 1) throw new Error('binding close failed');
    },
    closeProxy: async () => {
      proxyAttempts += 1;
      if (proxyAttempts === 1) throw new Error('proxy close failed');
    },
  });
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

  let failure: unknown;
  try {
    await service.close(preview.binding.id);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ message: 'binding close failed' }),
    expect.objectContaining({ message: 'proxy close failed' }),
  ]);
  await expect(service.close(preview.binding.id)).resolves.toBeUndefined();
  expect({ bindingAttempts, proxyAttempts }).toEqual({ bindingAttempts: 2, proxyAttempts: 2 });
});

it('retains a provisional create cleanup after both creation and release fail', async () => {
  let closeAttempts = 0;
  const { service } = createRuntimeFixture({
    closeBinding: async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('binding cleanup failed');
    },
    failProxyOpen: true,
  });

  await expect(service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' }))
    .rejects.toBeInstanceOf(AggregateError);
  await expect(service.closeAll()).resolves.toBeUndefined();
  expect(closeAttempts).toBe(2);
});

it('closeAll retains every runtime preview cleanup cause instead of the first rejection', async () => {
  let closeAttempts = 0;
  const { service } = createRuntimeFixture({
    closeProxy: async () => {
      closeAttempts += 1;
      throw new Error(`proxy cleanup ${closeAttempts}`);
    },
  });
  await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

  let failure: unknown;
  try {
    await service.closeAll();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ message: 'proxy cleanup 1' }),
    expect.objectContaining({ message: 'proxy cleanup 2' }),
  ]);
});
