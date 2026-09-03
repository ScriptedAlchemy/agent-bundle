import { expect, it } from '@rstest/core';

import { devContractTarget, matrixClient } from '../src/dev/dev-contract-runner.ts';
import type { McpSessionTraceListener, McpSessionTraceMessage } from '../src/dev/mcp-session/mcp-session-protocol.ts';
import { contractProgressObserver, type ContractMatrixClient } from '../src/test/contract.ts';

const model = (servers: readonly { readonly name: string; readonly targets: readonly string[] }[], targets: readonly string[]) =>
  ({
    model: {
      mcpServers: servers.map((server) => ({ ...server, id: `mcp:${server.name}`, transport: 'stdio' })),
      targets: targets.map((name) => ({ name })),
    },
  }) as unknown as Parameters<typeof devContractTarget>[0];

it('selects a target whose generated manifest carries the configured server, preferring portable when eligible', () => {
  expect(devContractTarget(model([{ name: 'fixture', targets: ['claude', 'portable'] }], ['claude', 'portable']), 'fixture'))
    .toBe('portable');
  // A server restricted to one host is absent from the portable manifest: the matrix must open it there instead.
  expect(devContractTarget(model([{ name: 'fixture', targets: ['claude'] }], ['claude', 'portable']), 'fixture'))
    .toBe('claude');
  expect(devContractTarget(model([{ name: 'fixture', targets: ['codex', 'claude'] }], ['codex', 'claude', 'portable']), 'fixture'))
    .toBe('codex');
  // A server the model does not describe (handwritten registration) falls back to the project targets.
  expect(devContractTarget(model([], ['claude', 'portable']), 'other')).toBe('portable');
});

it('rejects a matrix whose server is emitted for none of the project targets', () => {
  expect(() => devContractTarget(model([{ name: 'fixture', targets: ['cursor'] }], ['claude', 'portable']), 'fixture'))
    .toThrow('Development contract matrix server "fixture" is emitted for none of the project\'s targets.');
  expect(() => devContractTarget(model([], []), 'fixture'))
    .toThrow('Development contract matrix requires at least one generated target.');
});

interface RecordedRequest {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
}

const fakeSession = (timeoutMs: number) => {
  const requests: RecordedRequest[] = [];
  const listeners = new Set<McpSessionTraceListener>();
  let sequence = 0;
  const record = (options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } | undefined) => {
    requests.push({ signal: options?.signal, timeoutMs: options?.timeoutMs });
  };
  const session = {
    callTool: async (options: { readonly signal?: AbortSignal; readonly timeoutMs?: number }) => {
      record(options);
      return { content: [] };
    },
    emitProgress: (progressToken: string) => {
      sequence += 1;
      const entry: McpSessionTraceMessage = {
        kind: 'progress',
        occurredAt: Date.now(),
        payload: { progress: 1, progressToken },
        sequence,
      };
      for (const listener of listeners) listener(entry);
    },
    getPrompt: async (options: { readonly signal?: AbortSignal; readonly timeoutMs?: number }) => {
      record(options);
      return { messages: [] };
    },
    listPrompts: async (options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }) => {
      record(options);
      return [];
    },
    listResources: async (options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }) => {
      record(options);
      return [];
    },
    listTools: async (options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }) => {
      record(options);
      return [];
    },
    readResource: async (options: { readonly signal?: AbortSignal; readonly timeoutMs?: number }) => {
      record(options);
      return { contents: [] };
    },
    requests,
    subscribeTrace: (_options: { readonly afterSequence?: number }, listener: McpSessionTraceListener) => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    timeoutMs,
    trace: () => ({ entries: [] }),
  };
  return session;
};

it('applies the session timeout per matrix request instead of one deadline for the whole matrix', async () => {
  const session = fakeSession(30_000);
  const client = matrixClient(session as unknown as Parameters<typeof matrixClient>[0]);

  await client.listTools();
  await client.callTool({ arguments: {}, name: 'version' });
  await client.readResource({ uri: 'memo://x' }, { timeout: 250 });

  expect(session.requests).toHaveLength(3);
  const signals = session.requests.map((request) => request.signal);
  expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
  expect(new Set(signals).size).toBe(3);
  expect(session.requests[2]?.timeoutMs).toBe(250);
});

it('exposes live progress notifications through the session trace for lifecycle fixtures', () => {
  const session = fakeSession(30_000);
  const client = matrixClient(session as unknown as Parameters<typeof matrixClient>[0]);
  const observe = contractProgressObserver(client);
  const seen: unknown[] = [];
  const stop = observe((notification) => seen.push(notification.params?.progressToken));

  session.emitProgress('token-1');
  stop();
  session.emitProgress('token-2');

  expect(seen).toEqual(['token-1']);
});

it('names the missing notification path for a client that is neither an SDK Client nor exposes observeProgress', () => {
  const bare = {} as ContractMatrixClient;
  expect(() => contractProgressObserver(bare))
    .toThrow('Contract matrix client exposes no progress notification path');

  const handlers = new Map<string, (...arguments_: readonly unknown[]) => void>();
  const sdkLike = { _notificationHandlers: handlers } as unknown as ContractMatrixClient;
  const seen: unknown[] = [];
  const stop = contractProgressObserver(sdkLike)((notification) => seen.push(notification.params?.progressToken));
  handlers.get('notifications/progress')?.({ params: { progressToken: 'sdk' } });
  stop();
  expect(handlers.has('notifications/progress')).toBe(false);
  expect(seen).toEqual(['sdk']);
});
