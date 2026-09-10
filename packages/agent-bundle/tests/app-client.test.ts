import { expect, it } from '@rstest/core';

import {
  APP_PROTOCOL_VERSION,
  type AppAbortSignal,
  AppClientError,
  type AppMessageEvent,
  type AppMessageTarget,
  type AppRequestOptions,
  type AppRouteContract,
  type AppRouteId,
  type AppRouteInput,
  type AppRouteResult,
  type AppWindow,
  createAppClient,
} from '../src/app/index.ts';
import type { JsonObject } from '../src/core/strict-json.ts';
import { MCP_APP_PROTOCOL_VERSION } from '../src/dev/mcp-app-profile-descriptors.ts';

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
      readonly 'tool:status/show-status': {
        readonly input: { readonly service: string };
        readonly result: { readonly service: string; readonly status: string };
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
  'tool:hauler/hauler_status' | 'tool:server/status' | 'tool:status/show-status'
>>;
type RouteInputProof = Assert<Equals<
  AppRouteInput<'tool:hauler/hauler_status'>,
  { readonly limit: number }
>>;
type RouteResultProof = Assert<Equals<
  AppRouteResult<'tool:hauler/hauler_status'>,
  { readonly active: number; readonly status: string }
>>;
type UnknownRouteInputProof = Assert<Equals<
  AppRouteInput<'tool:missing/route'>,
  unknown
>>;
type AbortSignalProof = Assert<AbortSignal extends AppAbortSignal ? true : false>;
type MalformedRoutes = {
  readonly 'tool:broken/route': { readonly input: unknown };
};
type MalformedRegistrationProof = Assert<Equals<
  MalformedRoutes extends {
    readonly [Id in keyof MalformedRoutes]: AppRouteContract;
  } ? MalformedRoutes : never,
  never
>>;

interface PostedMessage {
  readonly message: JsonObject;
  readonly targetOrigin: string;
}

const hostOrigin = 'https://host.example';
const codexOrigin = 'codex-sandbox://stable-dashboard-id';
const dynamicHostOrigins = [
  hostOrigin,
  'null',
  'codex-sandbox://x',
  'vscode-webview://x',
  'https://abc.claudemcpcontent.com',
] as const;
const typeProofs: readonly [
  RouteIdProof,
  RouteInputProof,
  RouteResultProof,
  UnknownRouteInputProof,
  AbortSignalProof,
  MalformedRegistrationProof,
] = [true, true, true, true, true, true];

const initializeResult = {
  hostCapabilities: { serverTools: {} },
  hostContext: { toolInfo: { tool: { name: 'status' } } },
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

it('uses one shared protocol version for the App client and MCP App profile', () => {
  expect(APP_PROTOCOL_VERSION).toBe(MCP_APP_PROTOCOL_VERSION);
});

it('connects and calls through arbitrary origins from the exact parent', async () => {
  for (const origin of dynamicHostOrigins) {
    const target = harness();
    const client = createAppClient({ window: target.window });
    await connect(client, target, origin);
    const called = client.call('tool:hauler/hauler_status', { limit: 40 }, { timeoutMs: 50 });
    const request = target.posts.at(-1)!;
    target.emit({
      id: responseId(request),
      jsonrpc: '2.0',
      result: {
        content: [{ text: 'healthy', type: 'text' }],
        structuredContent: { active: 3, status: 'healthy' },
      },
    }, origin === hostOrigin ? 'vscode-webview://response-changed' : hostOrigin);
    await expect(called, origin).resolves.toEqual({ active: 3, status: 'healthy' });
    expect(target.posts.every(({ targetOrigin }) => targetOrigin === '*'), origin).toBe(true);
    client.dispose();
  }
});

it('accepts AbortController signals through the structural app contract', () => {
  const signal: AppAbortSignal = new AbortController().signal;
  const options: AppRequestOptions = { signal };
  expect(options.signal?.aborted).toBe(false);
});

it('ignores a foreign WindowProxy even when its origin matches the exact parent', async () => {
  expect(typeProofs).toEqual([true, true, true, true, true, true]);
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

  let initialized = false;
  void connecting.then(() => { initialized = true; }, () => { initialized = true; });
  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult }, hostOrigin, foreignParent);
  target.emit({ id: 99, jsonrpc: '2.0', result: initializeResult }, hostOrigin);
  await flushListeners();
  expect(initialized).toBe(false);

  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult }, hostOrigin);
  await expect(connecting).resolves.toEqual(initializeResult);
  expect(client.connected).toBe(true);
  expect(target.posts.at(-1)).toEqual({
    message: { jsonrpc: '2.0', method: 'ui/notifications/initialized' },
    targetOrigin: '*',
  });

  const called = client.call('tool:hauler/hauler_status', { limit: 40 }, { timeoutMs: 50 });
  expect(target.posts.at(-1)?.targetOrigin).toBe('*');
  const callId = responseId(target.posts.at(-1)!);
  let settled = false;
  void called.then(() => { settled = true; }, () => { settled = true; });
  const result = {
    id: callId,
    jsonrpc: '2.0',
    result: {
      content: [{ text: 'healthy', type: 'text' }],
      structuredContent: { active: 3, status: 'healthy' },
    },
  } as const;
  target.emit(result, hostOrigin, foreignParent);
  await flushListeners();
  expect(settled).toBe(false);
  target.emit(result, 'vscode-webview://response-changed');
  await expect(called).resolves.toEqual({ active: 3, status: 'healthy' });
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
  let settled = false;
  void connecting.then(() => { settled = true; }, () => { settled = true; });
  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult }, 'null');
  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult }, 'https://other.example');
  await flushListeners();
  expect(settled).toBe(false);
  target.emit({ id: 1, jsonrpc: '2.0', result: initializeResult });
  await expect(connecting).resolves.toEqual(initializeResult);

  const requested = client.request('ping', {});
  const request = target.posts.at(-1)!;
  expect(request.targetOrigin).toBe(hostOrigin);
  let requestSettled = false;
  void requested.then(() => { requestSettled = true; }, () => { requestSettled = true; });
  target.emit({ id: responseId(request), jsonrpc: '2.0', result: { forged: true } }, 'https://other.example');
  await flushListeners();
  expect(requestSettled).toBe(false);
  target.emit({ id: responseId(request), jsonrpc: '2.0', result: { accepted: true } });
  await expect(requested).resolves.toEqual({ accepted: true });

  expect(() => createAppClient({
    targetOrigin: '*',
    window: target.window,
  })).toThrow(/exact trusted origin/u);
  expect(() => createAppClient({
    targetOrigin: 'null',
    window: target.window,
  })).toThrow(/exact trusted origin/u);
  expect(() => createAppClient({
    targetOrigin: 'file:///tmp/host.html',
    window: target.window,
  })).toThrow(/exact trusted http/u);
  expect(() => createAppClient({
    targetOrigin: codexOrigin,
    window: target.window,
  })).toThrow(/exact trusted http/u);
  expect(() => createAppClient({
    targetOrigin: '',
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
      params: {
        _meta: { 'io.agent-bundle/route-id': 'tool:hauler/hauler_status' },
        arguments: { limit: 40 },
        name: 'hauler_status',
      },
    },
    targetOrigin: '*',
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

  const failed = client.call('tool:server/status', {});
  target.emit({
    id: 4,
    jsonrpc: '2.0',
    result: {
      content: [{ text: 'failed', type: 'text' }],
      isError: true,
    },
  });
  await expect(failed).rejects.toMatchObject({
    code: 'rpc',
    data: {
      content: [{ text: 'failed', type: 'text' }],
      isError: true,
    },
  });

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
    targetOrigin: '*',
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
    targetOrigin: '*',
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
  const otherInputs: unknown[] = [];
  const otherResults: unknown[] = [];
  const cancellations: unknown[] = [];
  const offInput = client.onToolInput('tool:server/status', (input) => { inputs.push(input); });
  client.onToolResult('tool:server/status', (result) => { results.push(result); });
  client.onToolInput('tool:hauler/hauler_status', (input) => { otherInputs.push(input); });
  client.onToolResult('tool:hauler/hauler_status', (result) => { otherResults.push(result); });
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
  expect(otherInputs).toEqual([]);
  expect(otherResults).toEqual([]);
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

it('delivers opening tool failures only through the matching route error listener', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  await connect(client, target);
  const errors: AppClientError[] = [];
  const otherErrors: AppClientError[] = [];
  const results: unknown[] = [];
  client.onToolError('tool:server/status', (error) => { errors.push(error); });
  client.onToolError('tool:hauler/hauler_status', (error) => { otherErrors.push(error); });
  client.onToolResult('tool:server/status', (result) => { results.push(result); });

  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: [{ text: 'failed with details', type: 'text' }],
      isError: true,
      structuredContent: { reason: 'failed' },
    },
  });
  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: [{ text: 'failed without details', type: 'text' }],
      isError: true,
    },
  });
  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: [{ text: 'missing structured result', type: 'text' }],
    },
  });
  target.emit({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: [{ text: 'malformed structured result', type: 'text' }],
      structuredContent: [],
    },
  });
  await flushListeners();

  expect(errors.map((error) => error.code)).toEqual([
    'rpc',
    'rpc',
    'invalid-message',
    'invalid-message',
  ]);
  expect(errors.every((error) => error instanceof AppClientError)).toBe(true);
  expect(otherErrors).toEqual([]);
  expect(results).toEqual([]);
});

it('rejects old pending work on rebind and establishes a fresh exact-origin connection', async () => {
  const first = harness();
  const second = harness();
  const secondOrigin = 'https://replacement.example';
  const client = createAppClient({ window: first.window });
  await connect(client, first, 'null');
  const oldRequest = client.request('slow', {});
  const oldRequestId = responseId(first.posts.at(-1)!);
  const oldFailure = expect(oldRequest).rejects.toMatchObject({ code: 'connection-rebound' });

  const rebound = client.rebind({
    parent: second.parent,
    targetOrigin: secondOrigin,
    window: second.window,
  });
  expect(first.listenerCount()).toBe(0);
  expect(second.listenerCount()).toBe(1);
  expect(first.posts.at(-1)).toEqual({
    message: {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { reason: 'connection-rebound', requestId: oldRequestId },
    },
    targetOrigin: '*',
  });
  expect(second.posts[0]?.targetOrigin).toBe(secondOrigin);
  let reboundSettled = false;
  void rebound.then(() => { reboundSettled = true; }, () => { reboundSettled = true; });
  second.emit({
    id: responseId(second.posts[0]!),
    jsonrpc: '2.0',
    result: initializeResult,
  }, secondOrigin, first.parent);
  await flushListeners();
  expect(reboundSettled).toBe(false);
  second.emit({
    id: responseId(second.posts[0]!),
    jsonrpc: '2.0',
    result: initializeResult,
  }, secondOrigin);
  await expect(rebound).resolves.toEqual(initializeResult);
  await oldFailure;
  expect(client.connected).toBe(true);
  expect(second.posts.at(-1)?.targetOrigin).toBe(secondOrigin);
});

it('rebinds an unconfigured client to a new exact parent and resets its generation', async () => {
  const first = harness();
  const second = harness();
  const client = createAppClient({ window: first.window });
  await connect(client, first, 'vscode-webview://first');

  const rebound = client.rebind({ window: second.window });
  expect(second.posts[0]?.targetOrigin).toBe('*');
  const reboundId = responseId(second.posts[0]!);
  let settled = false;
  void rebound.then(() => { settled = true; }, () => { settled = true; });
  second.emit({ id: reboundId, jsonrpc: '2.0', result: initializeResult }, codexOrigin, first.parent);
  await flushListeners();
  expect(settled).toBe(false);
  second.emit({ id: reboundId, jsonrpc: '2.0', result: initializeResult }, hostOrigin);
  await expect(rebound).resolves.toEqual(initializeResult);
  expect(second.posts.at(-1)?.targetOrigin).toBe('*');
});

it('validates a rebind origin before changing the live connection', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  await connect(client, target);
  const pending = client.request('slow', {});
  const pendingId = responseId(target.posts.at(-1)!);
  const postCount = target.posts.length;

  await expect(client.rebind({ targetOrigin: '*' })).rejects.toThrow(/exact trusted origin/u);
  expect(client.connected).toBe(true);
  expect(target.posts).toHaveLength(postCount);

  target.emit({ id: pendingId, jsonrpc: '2.0', result: { kept: true } });
  await expect(pending).resolves.toEqual({ kept: true });
});

it('keeps one fresh handshake when rebinding during connect and inherits targetOrigin', async () => {
  const first = harness();
  const second = harness();
  const client = createAppClient({
    targetOrigin: hostOrigin,
    window: first.window,
  });
  const stale = client.connect();
  const staleFailure = expect(stale).rejects.toMatchObject({ code: 'connection-rebound' });

  const rebound = client.rebind({ window: second.window });
  expect(second.posts).toHaveLength(1);
  expect(second.posts[0]?.targetOrigin).toBe(hostOrigin);
  await staleFailure;

  const sameConnection = client.connect();
  expect(second.posts).toHaveLength(1);
  second.emit({
    id: responseId(second.posts[0]!),
    jsonrpc: '2.0',
    result: initializeResult,
  });
  await expect(Promise.all([rebound, sameConnection])).resolves.toEqual([
    initializeResult,
    initializeResult,
  ]);
  expect(second.posts.filter((entry) => entry.message.method === 'ui/initialize')).toHaveLength(1);
  expect(second.posts.filter(
    (entry) => entry.message.method === 'ui/notifications/initialized',
  )).toHaveLength(1);
});

it('keeps wildcard initialization cancellation local on dispose', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  const connecting = client.connect();
  const failure = expect(connecting).rejects.toMatchObject({ code: 'disposed' });
  expect(target.posts).toHaveLength(1);
  expect(target.posts[0]?.targetOrigin).toBe('*');

  client.dispose();
  await failure;
  expect(target.posts).toHaveLength(1);
});

it('acknowledges host teardown before disposing and makes disposal idempotent', async () => {
  const target = harness();
  const client = createAppClient({ window: target.window });
  await connect(client, target, 'null');
  const pending = client.request('slow', {});
  const pendingId = responseId(target.posts.at(-1)!);
  const pendingFailure = expect(pending).rejects.toMatchObject({ code: 'disposed' });

  target.emit({
    id: 'foreign-close',
    jsonrpc: '2.0',
    method: 'ui/resource-teardown',
    params: {},
  }, hostOrigin, {});
  expect(client.disposed).toBe(false);

  target.emit({
    id: 'close-1',
    jsonrpc: '2.0',
    method: 'ui/resource-teardown',
    params: {},
  }, 'vscode-webview://teardown-origin-changed');
  expect(target.posts.slice(-2)).toEqual([
    {
      message: { id: 'close-1', jsonrpc: '2.0', result: {} },
      targetOrigin: '*',
    },
    {
      message: {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { reason: 'disposed', requestId: pendingId },
      },
      targetOrigin: '*',
    },
  ]);
  await pendingFailure;
  expect(client.disposed).toBe(true);
  expect(client.connected).toBe(false);
  expect(target.listenerCount()).toBe(0);
  const postCount = target.posts.length;
  client.dispose();
  expect(target.posts).toHaveLength(postCount);
  await expect(client.connect()).rejects.toBeInstanceOf(AppClientError);
  await expect(client.connect()).rejects.toMatchObject({ code: 'disposed' });
});
