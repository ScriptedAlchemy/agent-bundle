import { expect, it } from '@rstest/core';

import { McpAppRuntimePreviewService } from '../src/dev/mcp-app-runtime-preview-service.ts';
import { McpAppRuntimeBindingService } from '../src/dev/mcp-app-runtime-binding-service.ts';
import type { DevRuntimeMcpRegistryMessage, DevRuntimeMcpSessionView, DevRuntimeSession } from '../src/dev/runtime-provider.ts';
import type { DevRuntimeMcpOperationRequest, DevRuntimeMcpSessionSnapshot, DevRuntimeRun, RuntimeVector } from '../src/dev/runtime-protocol.ts';
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
      surfaceId: 'app.weather',
    }),
    protocol: Object.freeze({ content: Object.freeze([{ text: 'Sunny', type: 'text' }]) }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'state-private', stateVersion: 0 }) }),
    trace: Object.freeze([]),
    tree: Object.freeze([]),
  }),
  startedAt: '2026-08-15T00:00:00.000Z',
  status: 'succeeded' as const,
  surfaceId: 'app.weather',
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

const createSessionView = (requests: DevRuntimeMcpOperationRequest[]): DevRuntimeMcpSessionView => ({
  execute: async (request) => {
    requests.push(request);
    const value: JsonValue = request.kind === 'list-tools'
      ? { tools: [
        { _meta: { ui: { resourceUri: 'ui://weather/other.html', visibility: ['app'] } }, name: 'foreign-app' },
        { _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['model'] } }, name: 'model-only-app' },
        { _meta: { ui: { resourceUri: 'ui://weather/forecast.html', visibility: ['app'] } }, name: 'show-weather' },
      ] }
      : request.kind === 'list-resources'
        ? { resources: [{ _meta: { ui: { resourceUri: 'ui://weather/forecast.html' } }, mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' }] }
        : request.kind === 'read-resource'
          ? { contents: [{ _meta: { ui: {} }, mimeType: 'text/html;profile=mcp-app', text: '<main>Weather</main>', uri: request.uri }] }
          : { content: [{ text: 'called', type: 'text' }] };
    return Object.freeze({ operationId: `op-${requests.length}`, sessionId: 'session-a', sessionRevision: 2, value, vector });
  },
  snapshot,
  watchClosed: () => Object.freeze({ closed: false, unsubscribe: () => undefined }),
});

const createRuntimeFixture = (options: Readonly<{ readonly closeProxy?: () => Promise<void> }> = {}) => {
  const requests: DevRuntimeMcpOperationRequest[] = [];
  const controls: string[] = [];
  const emitted: unknown[] = [];
  let listener: ((message: DevRuntimeMcpRegistryMessage) => void) | undefined;
  const view = createSessionView(requests);
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
  const service = new McpAppRuntimePreviewService({
    bindingAuthority: new McpAppRuntimeBindingService(),
    configExtensions: () => Object.freeze({ descriptors: [], extensions: Object.freeze({}), projectRoot: '/project', sourceRevision: 'source-a' }),
    emit: (details) => { emitted.push(details); },
    openRuntimeClientSurface: async (surfaceId) => Object.freeze({ bootstrapUrl: `http://proxy.test/${surfaceId}`, close: options.closeProxy ?? (async () => undefined), origin: 'http://proxy.test', surfaceId, webSocketPath: '/rsbuild-hmr' }),
    runtime,
  });
  return Object.freeze({
    controls,
    emitted,
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

it('derives an Apps preview only from one stored succeeded run and a non-owning stable session view', async () => {
  const { controls, requests, service } = createRuntimeFixture();

  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });

  expect(preview).toMatchObject({
    binding: { sessionId: 'session-a', sessionRevision: 2 },
    clientSurface: { bootstrapUrl: 'http://proxy.test/app.weather', origin: 'http://proxy.test', webSocketPath: '/rsbuild-hmr' },
    kind: 'apps',
    result: { isError: false, modelVisible: { content: [{ text: 'Sunny', type: 'text' }] } },
    session: { state: 'ready' },
  });
  expect(preview.metadata.tool.standard.ui).toEqual({ resourceUri: 'ui://weather/forecast.html', visibility: ['app'] });
  expect(requests).toEqual([
    { expectedSessionRevision: 2, kind: 'list-tools' },
    { expectedSessionRevision: 2, kind: 'list-resources' },
    { expectedSessionRevision: 2, kind: 'read-resource', uri: 'ui://weather/forecast.html' },
  ]);
  expect(controls).toEqual([]);
  expect(JSON.stringify(preview)).not.toContain('provider-private');
  expect(JSON.stringify(preview)).not.toContain('state-private');
  await expect(service.create({ expectedGenerationId: 'generation-b', profileId: 'portable', runId: 'run-a' })).rejects.toThrow('generation');
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

it('retains a failed runtime preview cleanup for an explicit retry and emits one revocation', async () => {
  let closeAttempts = 0;
  const { emitted, service } = createRuntimeFixture({
    closeProxy: async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('proxy close failed');
    },
  });
  const preview = await service.create({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' });
  await expect(service.close(preview.binding.id)).rejects.toThrow('proxy close failed');
  expect(service.get(preview.binding.id)).toBeDefined();
  await expect(service.close(preview.binding.id)).resolves.toBeUndefined();
  expect(closeAttempts).toBe(2);
  expect(service.get(preview.binding.id)).toBeUndefined();
  expect(emitted).toEqual([expect.objectContaining({ bindingId: preview.binding.id, reason: 'manual-close', state: 'revoked' })]);
});
