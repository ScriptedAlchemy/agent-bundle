import { expect, it } from '@rstest/core';

import {
  APP_PROTOCOL_VERSION,
  AppClientError,
  type AppMessageEvent,
  type AppMessageTarget,
  type AppRouteId,
  type AppRouteInput,
  type AppRouteResult,
  type AppWindow,
  createAppClient,
} from '../src/app/index.ts';
import type { JsonObject } from '../src/core/strict-json.ts';

declare module '../src/app/index.ts' {
  interface AppRegister {
    readonly routes: {
      readonly 'tool:hauler/hauler_status': {
        readonly input: { readonly limit: number };
        readonly result: { readonly active: number; readonly status: string };
      };
      readonly 'tool:server/status': {
        readonly input: Readonly<Record<string, unknown>>;
        readonly result: { readonly count?: number };
      };
    };
  }
}

type Equals<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type RouteIdProof = Assert<Equals<
  AppRouteId,
  'tool:hauler/hauler_status' | 'tool:server/status'
>>;
type RouteInputProof = Assert<Equals<
  AppRouteInput<'tool:hauler/hauler_status'>,
  { readonly limit: number }
>>;
type RouteResultProof = Assert<Equals<
  AppRouteResult<'tool:hauler/hauler_status'>,
  { readonly active: number; readonly status: string }
>>;

interface PostedMessage {
  readonly message: JsonObject;
  readonly targetOrigin: string;
}

const hostOrigin = 'https://host.example';
const typeProofs: readonly [RouteIdProof, RouteInputProof, RouteResultProof] = [true, true, true];

const initializeResult = {
  hostCapabilities: { serverTools: {} },
  hostContext: {},
  hostInfo: { name: 'test-host', version: '1.0.0' },
  protocolVersion: APP_PROTOCOL_VERSION,
} as const;

const harness = () => {
  const posts: PostedMessage[] = [];
  const listeners = new Set<(event: AppMessageEvent) => void>();
  const parent: AppMessageTarget = {
    postMessage(message, targetOrigin) {
      posts.push({ message, targetOrigin });
    },
  };
  const window: AppWindow = {
    parent,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    emit(
      data: unknown,
      origin = hostOrigin,
      source: unknown = parent,
    ): void {
      for (const listener of [...listeners]) listener({ data, origin, source });
    },
    listenerCount: (): number => listeners.size,
    parent,
    posts,
    window,
  };
};

const responseId = (entry: PostedMessage): null | number | string => {
  const id = entry.message.id;
  if (id === null || typeof id === 'string' || typeof id === 'number') return id;
  throw new Error('Posted request did not contain an id.');
};

const connect = async (
  client: ReturnType<typeof createAppClient>,
  target: ReturnType<typeof harness>,
  origin = hostOrigin,
): Promise<void> => {
  const connecting = client.connect();
  const request = target.posts.at(-1)!;
  target.emit({
    id: responseId(request),
    jsonrpc: '2.0',
    result: initializeResult,
  }, origin);
  await connecting;
};

const flushListeners = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

it('bootstraps an opaque sandbox only through a matching parent initialize response and pins its origin', async () => {
  expect(typeProofs).toEqual([true, true, true]);
  const target = harness();
  const foreignParent = {};
  const client = createAppClient({
    appInfo: { name: 'dashboard', version: '2.0.0' },
    window: target.window,
  });

  const connecting = client.connect();
  expect(target.posts).toEqual([{
    message: {
      id: 1,
      jsonrpc: '2.0',
      method: 'ui/initialize',
      params: {
        appCapabilities: {},
        appInfo: { name: 'dashboard', version: '2.0.0' },
        protocolVersion: APP_PROTOCOL_VERSION,
      },
    },
    targetOrigin: '*',
  }]);

  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult }, 'https://attacker.example', foreignParent);
  target.emit({ id: 99, jsonrpc: '2.0', result: initializeResult });
  expect(client.connected).toBe(false);

  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult });
  await expect(connecting).resolves.toEqual(initializeResult);
  expect(client.connected).toBe(true);
  expect(target.posts.at(-1)).toEqual({
    message: { jsonrpc: '2.0', method: 'ui/notifications/initialized' },
    targetOrigin: hostOrigin,
  });

  const request = client.request('ping', {});
  expect(target.posts.at(-1)?.targetOrigin).toBe(hostOrigin);
  const pingId = responseId(target.posts.at(-1)!);
  target.emit({ id: pingId, jsonrpc: '2.0', result: {} }, 'https://attacker.example');
  expect(target.posts).toHaveLength(3);
  target.emit({ id: pingId, jsonrpc: '2.0', result: {} });
  await expect(request).resolves.toEqual({});
});

it('uses an exact trusted targetOrigin from the first message and rejects a mismatched response origin', async () => {
  const target = harness();
  const client = createAppClient({
    parent: target.parent,
    targetOrigin: hostOrigin,
    window: target.window,
  });
  const connecting = client.connect({ timeoutMs: 20 });
  expect(target.posts[0]?.targetOrigin).toBe(hostOrigin);
  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult }, 'https://other.example');
  expect(client.connected).toBe(false);
  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult });
  await expect(connecting).resolves.toEqual(initializeResult);

  expect(() => createAppClient({
    targetOrigin: '*',
    window: target.window,
  })).toThrow(/exact trusted origin/u);
});

it('calls a route by its protocol tool name and returns structuredContent directly', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  await connect(client, target);

  const called = client.call('tool:hauler/hauler_status', { limit: 40 });
  const request = target.posts.at(-1)!;
  expect(request).toEqual({
    message: {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { limit: 40 }, name: 'hauler_status' },
    },
    targetOrigin: hostOrigin,
  });
  target.emit({
    id: responseId(request),
    jsonrpc: '2.0',
    result: {
      content: [{ text: 'healthy', type: 'text' }],
      structuredContent: { active: 3, status: 'healthy' },
    },
  });
  await expect(called).resolves.toEqual({ active: 3, status: 'healthy' });
});

it('maps RPC capability, consent, and general failures to the single AppClientError class', async () => {
  const cases = [
    [-32601, 'capability-unavailable'],
    [-32001, 'consent-required'],
    [-32000, 'rpc'],
  ] as const;
  for (const [rpcCode, code] of cases) {
    const target = harness();
    const client = createAppClient({ window: target.window });
    await connect(client, target);
    const request = client.request('tools/call', { name: 'status' });
    const id = responseId(target.posts.at(-1)!);
    target.emit({
      error: { code: rpcCode, data: { reason: code }, message: `failed: ${code}` },
      id,
      jsonrpc: '2.0',
    });
    await expect(request).rejects.toMatchObject({
      code,
      data: { reason: code },
      name: 'AppClientError',
      rpcCode,
    });
    client.dispose();
  }
});

it('rejects malformed envelopes and tool results without retaining hostile values', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  const connecting = client.connect();
  target.emit({
    extra: true,
    id: 1,
    jsonrpc: '2.0',
    result: initializeResult,
  });
  await expect(connecting).rejects.toMatchObject({ code: 'invalid-message' });

  const retry = client.connect();
  target.emit({ id: 2, jsonrpc: '2.0', result: initializeResult });
  await retry;
  const called = client.call('tool:server/status', {});
  target.emit({
    id: 3,
    jsonrpc: '2.0',
    result: {
      content: [{ text: 'missing structured data', type: 'text' }],
    },
  });
  await expect(called).rejects.toMatchObject({ code: 'invalid-message' });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expect(client.call('tool:server/status', cyclic)).rejects.toMatchObject({
    code: 'invalid-message',
  });
  await expect(client.call('prompt:server/status' as AppRouteId, {}))
    .rejects.toThrow(/tool:<server>\/<name>/u);
});

it('times out and aborts pending connected requests while notifying the host of cancellation', async () => {
  const target = harness();
  const client = createAppClient({ timeoutMs: 50, window: target.window });
  await connect(client, target);

  const timedOut = client.request('slow', {}, { timeoutMs: 5 });
  await expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
  expect(target.posts.at(-1)).toEqual({
    message: {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { reason: 'timeout', requestId: 2 },
    },
    targetOrigin: hostOrigin,
  });

  const controller = new AbortController();
  const aborted = client.request('slower', {}, { signal: controller.signal });
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
  expect(target.posts.at(-1)).toEqual({
    message: {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { reason: 'aborted', requestId: 3 },
    },
    targetOrigin: hostOrigin,
  });

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const before = target.posts.length;
  await expect(client.request('never-sent', {}, { signal: alreadyAborted.signal }))
    .rejects.toMatchObject({ code: 'aborted' });
  expect(target.posts).toHaveLength(before);
});

it('delivers typed tool lifecycle notifications and supports listener removal', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  await connect(client, target);
  const inputs: unknown[] = [];
  const results: unknown[] = [];
  const cancellations: unknown[] = [];
  const offInput = client.onToolInput('tool:server/status', (input) => { inputs.push(input); });
  client.onToolResult('tool:server/status', (result) => { results.push(result); });
  client.onToolCancelled((event) => { cancellations.push(event); });

  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-input',
    params: { arguments: { limit: 2 } },
  });
  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: [{ text: 'done', type: 'text' }],
      structuredContent: { count: 2 },
    },
  });
  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-cancelled',
    params: { reason: 'host stopped' },
  });
  await flushListeners();
  expect(inputs).toEqual([{ limit: 2 }]);
  expect(results).toEqual([{ count: 2 }]);
  expect(cancellations).toEqual([{ reason: 'host stopped' }]);

  offInput();
  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-input',
    params: { arguments: { limit: 3 } },
  });
  await flushListeners();
  expect(inputs).toEqual([{ limit: 2 }]);
});

it('rejects old pending work on rebind and establishes a fresh exact-origin connection', async () => {
  const first = harness();
  const second = harness();
  const secondOrigin = 'https://replacement.example';
  const client = createAppClient({ window: first.window });
  await connect(client, first);
  const oldRequest = client.request('slow', {});
  const oldFailure = expect(oldRequest).rejects.toMatchObject({ code: 'connection-rebound' });

  const rebound = client.rebind({
    parent: second.parent,
    targetOrigin: secondOrigin,
    window: second.window,
  });
  expect(first.listenerCount()).toBe(0);
  expect(second.listenerCount()).toBe(1);
  expect(second.posts[0]?.targetOrigin).toBe(secondOrigin);
  second.emit({
    id: responseId(second.posts[0]!),
    jsonrpc: '2.0',
    result: initializeResult,
  }, secondOrigin);
  await expect(rebound).resolves.toEqual(initializeResult);
  await oldFailure;
  expect(client.connected).toBe(true);
});

it('acknowledges host teardown before disposing and makes disposal idempotent', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  await connect(client, target);

  target.emit({
    id: 'close-1',
    jsonrpc: '2.0',
    method: 'ui/resource-teardown',
    params: {},
  });
  expect(target.posts.at(-1)).toEqual({
    message: { id: 'close-1', jsonrpc: '2.0', result: {} },
    targetOrigin: hostOrigin,
  });
  expect(client.disposed).toBe(true);
  expect(client.connected).toBe(false);
  expect(target.listenerCount()).toBe(0);
  client.dispose();
  await expect(client.connect()).rejects.toBeInstanceOf(AppClientError);
  await expect(client.connect()).rejects.toMatchObject({ code: 'disposed' });
});
