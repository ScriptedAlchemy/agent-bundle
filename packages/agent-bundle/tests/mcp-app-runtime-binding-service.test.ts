import { expect, it } from '@rstest/core';

import {
  McpAppRuntimeBindingService,
  type CreateMcpAppRuntimeBindingOptions,
} from '../src/dev/mcp-app-runtime-binding-service.ts';
import type { DevRuntimeMcpSessionView } from '../src/dev/runtime-provider.ts';
import type { DevRuntimeMcpAppRunBinding, DevRuntimeMcpOperationRequest, DevRuntimeMcpSessionSnapshot, RuntimeVector } from '../src/dev/runtime-protocol.ts';
import type { McpAppJsonValue } from '../src/dev/mcp-app-metadata.ts';

interface SessionFixture {
  readonly executeRequests: DevRuntimeMcpOperationRequest[];
  readonly watcherOrder: string[];
  readonly view: DevRuntimeMcpSessionView;
  close(reason?: unknown): Promise<void>;
  setReturnedAuthority(authority: Readonly<{ readonly providerSessionId: string; readonly stateStoreId: string }>): void;
  setReturnedRevision(revision: number): void;
  setReturnedStateVersion(version: number): void;
}

const runBinding: DevRuntimeMcpAppRunBinding = Object.freeze({
  definitionDigest: 'definitions-a',
  registryRevision: 8,
  serverDigest: 'server-a',
  serverName: 'rsc-agent-runtime',
  sessionId: 'mcp-1',
  sessionRevision: 3,
  target: 'portable',
  transportDigest: 'transport-a',
});

const runVector: RuntimeVector = Object.freeze({
  providerSessionId: 'provider-private',
  runtimeGenerationId: 'g7',
  sourceRevision: 'source-a',
  stateStoreId: 'state-private',
  stateVersion: 4,
});

const sessionSnapshot = (): DevRuntimeMcpSessionSnapshot => Object.freeze({
  binding: Object.freeze({ ...runBinding, providerSessionId: 'provider-private', stateStoreId: 'state-private' }),
  connection: Object.freeze({ capabilities: undefined, protocolEra: 'modern', protocolVersion: '2026-01-26', server: undefined }),
  state: 'ready',
});

const createSessionFixture = (options: { readonly closeAtObservation?: boolean } = {}): SessionFixture => {
  const listeners = new Set<(reason?: unknown) => Promise<void> | void>();
  const executeRequests: DevRuntimeMcpOperationRequest[] = [];
  const watcherOrder: string[] = [];
  let closed = false;
  let returnedProviderSessionId = 'provider-private';
  let returnedRevision = 3;
  let returnedStateStoreId = 'state-private';
  let returnedStateVersion = 4;
  return {
    executeRequests,
    watcherOrder,
    view: {
      execute: async (request) => {
        executeRequests.push(request);
        const value: McpAppJsonValue = request.kind === 'read-resource'
          ? { contents: [{ mimeType: 'text/html', text: request.uri, type: 'text' }] }
          : { content: [{ text: 'current implementation', type: 'text' }] };
        return Object.freeze({
          operationId: `op-${executeRequests.length}`,
          sessionId: 'mcp-1',
          sessionRevision: returnedRevision,
          value,
          vector: Object.freeze({
            ...runVector,
            providerSessionId: returnedProviderSessionId,
            runtimeGenerationId: request.kind === 'read-resource' ? 'g7' : 'g8',
            stateStoreId: returnedStateStoreId,
            stateVersion: returnedStateVersion,
          }),
        });
      },
      snapshot: sessionSnapshot,
      watchClosed: (listener) => {
        watcherOrder.push('watch');
        if (options.closeAtObservation) {
          closed = true;
          return { closed: true, unsubscribe: () => watcherOrder.push('unsubscribe') };
        }
        listeners.add(listener);
        return {
          closed,
          unsubscribe: () => {
            watcherOrder.push('unsubscribe');
            listeners.delete(listener);
          },
        };
      },
    },
    close: async (reason = new Error('closed')) => {
      closed = true;
      await Promise.all([...listeners].map((listener) => listener(reason)));
    },
    setReturnedRevision: (revision) => {
      returnedRevision = revision;
    },
    setReturnedAuthority: (authority) => {
      returnedProviderSessionId = authority.providerSessionId;
      returnedStateStoreId = authority.stateStoreId;
    },
    setReturnedStateVersion: (version) => {
      returnedStateVersion = version;
    },
  };
};

const optionsFor = (fixture: SessionFixture, extra: Partial<CreateMcpAppRuntimeBindingOptions> = {}): CreateMcpAppRuntimeBindingOptions => ({
  profileId: 'portable',
  runBinding,
  runVector,
  session: fixture.view,
  ...extra,
});

it('derives a binding only from verified run evidence and keeps private provider/state identity out of the serializable snapshot', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppRuntimeBindingService();
  const binding = await service.createBinding(optionsFor(fixture));

  expect(binding).toMatchObject({
    definitionDigest: 'definitions-a',
    evidence: 'simulated',
    profileId: 'portable',
    registryRevision: 8,
    runVector: { runtimeGenerationId: 'g7', stateVersion: 4 },
    serverDigest: 'server-a',
    serverName: 'rsc-agent-runtime',
    sessionId: 'mcp-1',
    sessionRevision: 3,
    target: 'portable',
    transportDigest: 'transport-a',
  });
  expect(binding.profileVersion).toBe('agent-bundle:mcp-apps:2026-01-26');
  expect(JSON.stringify(binding)).not.toContain('provider-private');
  expect(JSON.stringify(binding)).not.toContain('state-private');
  expect(Object.isFrozen(binding)).toBe(true);
  await expect(service.createBinding(optionsFor(fixture, {
    runBinding: { ...runBinding, definitionDigest: 'browser-forged' },
  }))).rejects.toThrow('does not match');
});

it('executes against the stable session revision while retaining the originating run vector and returning the current implementation vector', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppRuntimeBindingService();
  const binding = await service.createBinding(optionsFor(fixture));

  const read = await service.execute(binding.id, { kind: 'read-resource', uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' });
  const call = await service.execute(binding.id, { arguments: {}, kind: 'call-tool', name: 'render_edit_timeline' });

  expect(fixture.executeRequests).toEqual([
    { expectedSessionRevision: 3, kind: 'read-resource', uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' },
    { arguments: {}, expectedSessionRevision: 3, kind: 'call-tool', name: 'render_edit_timeline' },
  ]);
  expect(read.vector.runtimeGenerationId).toBe('g7');
  expect(call.vector.runtimeGenerationId).toBe('g8');
  expect(service.get(binding.id)?.runVector.runtimeGenerationId).toBe('g7');
  expect(JSON.stringify(call.vector)).not.toContain('provider-private');
  expect(JSON.stringify(call.vector)).not.toContain('state-private');
});

it('rejects an operation that returns another session revision', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppRuntimeBindingService();
  const binding = await service.createBinding(optionsFor(fixture));
  fixture.setReturnedRevision(4);

  await expect(service.execute(binding.id, { kind: 'list-tools' })).rejects.toThrow('session revision');
});

it('allows a list operation to report initial state version zero but rejects a foreign provider/state authority', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppRuntimeBindingService();
  const binding = await service.createBinding(optionsFor(fixture));
  fixture.setReturnedStateVersion(0);

  await expect(service.execute(binding.id, { kind: 'list-tools' })).resolves.toMatchObject({
    vector: { stateVersion: 0 },
  });
  fixture.setReturnedAuthority({ providerSessionId: 'provider-other', stateStoreId: 'state-other' });
  await expect(service.execute(binding.id, { kind: 'list-resources' })).rejects.toThrow('provider/state authority');
});

it('does not publish a binding when atomic watchClosed observes a closed session', async () => {
  const fixture = createSessionFixture({ closeAtObservation: true });
  const service = new McpAppRuntimeBindingService();

  await expect(service.createBinding(optionsFor(fixture))).rejects.toThrow('closed before');
  expect(fixture.watcherOrder).toEqual(['watch', 'unsubscribe']);
});

it('invalidates only the exact session revision, drops views when teardown fails, and never owns the broker session close', async () => {
  const first = createSessionFixture();
  const second = createSessionFixture();
  const service = new McpAppRuntimeBindingService();
  const teardownCalls: string[] = [];
  const rev3 = await service.createBinding(optionsFor(first, {
    onTeardown: () => {
      teardownCalls.push('rev3');
      throw new Error('teardown failed');
    },
  }));
  const rev4 = await service.createBinding(optionsFor(second, {
    runBinding: { ...runBinding, sessionRevision: 4 },
    runVector: { ...runVector, providerSessionId: 'provider-private', stateStoreId: 'state-private' },
    session: {
      ...second.view,
      snapshot: () => Object.freeze({
        ...sessionSnapshot(),
        binding: Object.freeze({ ...sessionSnapshot().binding, sessionRevision: 4 }),
      }),
    },
  }));

  await expect(service.invalidateBindings({ sessionId: 'mcp-1', sessionRevision: 3 })).rejects.toThrow('teardown failed');
  expect(service.get(rev3.id)).toBeUndefined();
  expect(service.get(rev4.id)).toBe(rev4);
  expect(teardownCalls).toEqual(['rev3']);
  expect(first.watcherOrder).toEqual(['watch', 'unsubscribe']);
  await expect(service.closeBinding(rev4.id)).resolves.toBe(true);
  await expect(service.closeBinding(rev4.id)).resolves.toBe(false);
  expect(second.watcherOrder).toEqual(['watch', 'unsubscribe']);
});

it('releases a runtime binding when the non-owning session view closes and closes all remaining views on broker shutdown', async () => {
  const first = createSessionFixture();
  const second = createSessionFixture();
  const service = new McpAppRuntimeBindingService();
  const firstBinding = await service.createBinding(optionsFor(first));
  const secondBinding = await service.createBinding(optionsFor(second));

  await first.close();
  expect(service.get(firstBinding.id)).toBeUndefined();
  expect(service.get(secondBinding.id)).toBe(secondBinding);
  await service.close();
  expect(service.get(secondBinding.id)).toBeUndefined();
});

it('waits for an in-flight operation before invalidation delivers teardown and rejects its stale result', async () => {
  let resolveOperation: ((value: { readonly operationId: string; readonly sessionId: string; readonly sessionRevision: number; readonly value: McpAppJsonValue; readonly vector: RuntimeVector }) => void) | undefined;
  let teardownDelivered = false;
  const service = new McpAppRuntimeBindingService();
  const binding = await service.createBinding({
    onTeardown: () => {
      teardownDelivered = true;
    },
    profileId: 'portable',
    runBinding,
    runVector,
    session: {
      execute: async () => new Promise((resolve) => {
        resolveOperation = resolve;
      }),
      snapshot: sessionSnapshot,
      watchClosed: () => ({ closed: false, unsubscribe: () => undefined }),
    },
  });

  const operation = service.execute(binding.id, { kind: 'list-tools' });
  const invalidation = service.invalidateBindings({ sessionId: 'mcp-1', sessionRevision: 3 });
  await Promise.resolve();
  expect(teardownDelivered).toBe(false);
  resolveOperation?.({
    operationId: 'op-in-flight',
    sessionId: 'mcp-1',
    sessionRevision: 3,
    value: { content: [] },
    vector: { ...runVector, runtimeGenerationId: 'g8' },
  });
  await expect(operation).rejects.toThrow('closed');
  await invalidation;
  expect(teardownDelivered).toBe(true);
});

it('joins concurrent session-close, invalidation, and service-close releases through one teardown failure', async () => {
  const fixture = createSessionFixture();
  let rejectTeardown: ((error: Error) => void) | undefined;
  let teardownStarted = false;
  const service = new McpAppRuntimeBindingService();
  await service.createBinding(optionsFor(fixture, {
    onTeardown: () => new Promise<void>((_resolve, reject) => {
      teardownStarted = true;
      rejectTeardown = reject;
    }),
  }));

  const sessionClose = fixture.close();
  await Promise.resolve();
  expect(teardownStarted).toBe(true);
  let invalidationSettled = false;
  let shutdownSettled = false;
  const invalidation = service.invalidateBindings({ sessionId: 'mcp-1', sessionRevision: 3 }).finally(() => {
    invalidationSettled = true;
  });
  const shutdown = service.close().finally(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();
  expect(invalidationSettled).toBe(false);
  expect(shutdownSettled).toBe(false);
  rejectTeardown?.(new Error('teardown failed'));
  await expect(sessionClose).rejects.toThrow('teardown failed');
  await expect(invalidation).rejects.toThrow('teardown failed');
  await expect(shutdown).rejects.toThrow('teardown failed');
  await expect(service.closeBinding('missing-binding')).resolves.toBe(false);
});

it('forgets failed release entries after concurrent joiners settle', async () => {
  const fixture = createSessionFixture();
  const service = new McpAppRuntimeBindingService();
  const binding = await service.createBinding(optionsFor(fixture, {
    onTeardown: () => {
      throw new Error('teardown failed');
    },
  }));

  const first = service.closeBinding(binding.id);
  const second = service.invalidateBindings({ sessionId: 'mcp-1', sessionRevision: 3 });
  await expect(first).rejects.toThrow('teardown failed');
  await expect(second).rejects.toThrow('teardown failed');
  await expect(service.closeBinding(binding.id)).resolves.toBe(false);
  await expect(service.invalidateBindings({ sessionId: 'mcp-1', sessionRevision: 3 })).resolves.toBeUndefined();
});
