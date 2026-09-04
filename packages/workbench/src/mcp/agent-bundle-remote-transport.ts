import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/client';

import { isRecord, parseStrictResponseJson } from '../client-helpers.ts';
import { readNdjsonResponseFrames } from '../ndjson.ts';
import {
  McpRouteClient,
  type McpRouteConnection,
  type McpRouteOperation,
  type McpRouteSession,
  type McpRouteSessionBinding,
} from './mcp-route-client.ts';

const maxEmptyStreamReconnects = 3;
const browserRoutedMethods = new Set([
  'tools/list', 'resources/list', 'tools/call', 'resources/read', 'tasks/get', 'tasks/result', 'tasks/cancel', 'tasks/list',
] as const);

const taskCreation = (value: unknown): Readonly<{ readonly pollInterval?: number; readonly ttl?: number }> | 'invalid' => {
  if (!isRecord(value)) return 'invalid';
  const { pollInterval, ttl, ...rest } = value;
  if (Object.keys(rest).length > 0) return 'invalid';
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0)) return 'invalid';
  if (pollInterval !== undefined && (typeof pollInterval !== 'number' || !Number.isFinite(pollInterval) || pollInterval <= 0)) return 'invalid';
  return { ...(pollInterval === undefined ? {} : { pollInterval }), ...(ttl === undefined ? {} : { ttl }) };
};

interface JsonRpcRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface AgentBundleRemoteTransportOptions {
  readonly binding: McpRouteSessionBinding;
  readonly routes: McpRouteClient;
  readonly timeoutMs?: number;
}

export class AgentBundleRemoteTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentBundleRemoteTransportError';
  }
}

const invalidTrace = (): AgentBundleRemoteTransportError =>
  new AgentBundleRemoteTransportError('Foreground MCP trace stream contained an invalid entry.');

const request = (value: unknown): JsonRpcRequest | undefined => {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !Object.hasOwn(value, 'id')) return undefined;
  return typeof value.id === 'number' || typeof value.id === 'string'
    ? { ...(value.params === undefined ? {} : { params: value.params }), id: value.id, method: value.method }
    : undefined;
};

const notification = (value: unknown): { readonly method: string; readonly params?: unknown } | undefined =>
  isRecord(value) && value.jsonrpc === '2.0' && typeof value.method === 'string' && !Object.hasOwn(value, 'id')
    ? { ...(value.params === undefined ? {} : { params: value.params }), method: value.method }
    : undefined;

const requestKey = (id: number | string): string => `${typeof id}:${id}`;

const isJsonRpcNotification = (value: unknown): value is JSONRPCMessage =>
  isRecord(value) && value.jsonrpc === '2.0' && typeof value.method === 'string' &&
  !Object.hasOwn(value, 'id') && !Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error');

const asRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined;

type OperationResolution =
  | Readonly<{ readonly kind: 'invalid' }>
  | Readonly<{ readonly kind: 'operation'; readonly operation: McpRouteOperation }>
  | undefined;

const operationFor = (message: JsonRpcRequest): OperationResolution => {
  if (message.method === 'initialize') return { kind: 'operation', operation: { operation: 'initialize' } };
  if (
    message.method === 'tools/list' || message.method === 'resources/list' ||
    message.method === 'resources/templates/list' || message.method === 'prompts/list'
  ) return { kind: 'operation', operation: { operation: message.method } };
  const params = asRecord(message.params);
  if (message.method === 'prompts/get' && typeof params?.name === 'string') {
    if (params.arguments !== undefined && (!isRecord(params.arguments) || Object.values(params.arguments).some((value) => typeof value !== 'string'))) return { kind: 'invalid' };
    return { kind: 'operation', operation: {
      ...(params.arguments === undefined ? {} : { arguments: params.arguments as Record<string, string> }),
      name: params.name,
      operation: 'prompts/get',
    } };
  }
  if (message.method === 'resources/read') {
    return typeof params?.uri === 'string'
      ? { kind: 'operation', operation: { operation: 'resources/read', uri: params.uri } }
      : { kind: 'invalid' };
  }
  if (message.method === 'tools/call') {
    if (typeof params?.name !== 'string' || (params.arguments !== undefined && !isRecord(params.arguments))) return { kind: 'invalid' };
    // MCP 2025-11-25 Tasks (#369): `params.task` asks the server to answer with a task handle.
    const task = params.task === undefined ? undefined : taskCreation(params.task);
    if (task === 'invalid') return { kind: 'invalid' };
    return { kind: 'operation', operation: {
      arguments: params.arguments ?? {},
      name: params.name,
      operation: 'tools/call',
      requestId: requestKey(message.id),
      ...(task === undefined ? {} : { task }),
    } };
  }
  if (message.method === 'tasks/get' || message.method === 'tasks/result' || message.method === 'tasks/cancel') {
    return typeof params?.taskId === 'string' && params.taskId.length > 0
      ? { kind: 'operation', operation: { operation: message.method, taskId: params.taskId } }
      : { kind: 'invalid' };
  }
  if (message.method === 'tasks/list') {
    if (params?.cursor !== undefined && typeof params.cursor !== 'string') return { kind: 'invalid' };
    return { kind: 'operation', operation: { operation: 'tasks/list', ...(typeof params?.cursor === 'string' ? { cursor: params.cursor } : {}) } };
  }
  return message.method === 'prompts/get' ? { kind: 'invalid' } : undefined;
};

const resultFor = (method: string, result: unknown): unknown => {
  if (method === 'initialize') {
    const connection = result as McpRouteConnection;
    if (
      connection === undefined || connection.capabilities === undefined || typeof connection.protocolVersion !== 'string' ||
      connection.server === undefined
    ) throw new AgentBundleRemoteTransportError('Foreground MCP session did not provide a complete initialization result.');
    return { capabilities: connection.capabilities, protocolVersion: connection.protocolVersion, serverInfo: connection.server };
  }
  if (method === 'tools/list') return { tools: result };
  if (method === 'resources/list') return { resources: result };
  if (method === 'resources/templates/list') return { resourceTemplates: result };
  if (method === 'prompts/list') return { prompts: result };
  return result;
};

const errorMessage = (method: string): string =>
  `MCP method ${JSON.stringify(method)} is not supported by the Agent Bundle remote transport.`;

const invalidParamsMessage = (method: string): string =>
  `MCP method ${JSON.stringify(method)} has invalid parameters.`;

export interface AgentBundleMcpDispatchResult {
  readonly value: unknown;
  readonly vector?: import('../../../agent-bundle/src/contracts/runtime.ts').RuntimeVector;
}

type AgentBundleMcpRoutedMethod =
  | 'tools/list' | 'resources/list' | 'tools/call' | 'resources/read'
  | 'tasks/get' | 'tasks/result' | 'tasks/cancel' | 'tasks/list';

export const dispatchAgentBundleMcpRequest = async (
  message: JSONRPCMessage,
  options: Readonly<{
    readonly allowedMethods: ReadonlySet<AgentBundleMcpRoutedMethod>;
    readonly connection: McpRouteConnection;
    readonly execute: (operation: McpRouteOperation) => Promise<AgentBundleMcpDispatchResult>;
  }>,
): Promise<JSONRPCMessage | undefined> => {
  const nextRequest = request(message);
  if (nextRequest === undefined) {
    const nextNotification = notification(message);
    if (nextNotification?.method === 'notifications/initialized') return undefined;
    if (nextNotification !== undefined) {
      throw new AgentBundleRemoteTransportError('MCP remote transport received an invalid notification.');
    }
    return undefined;
  }
  if (nextRequest.method === 'initialize') {
    try {
      return { id: nextRequest.id, jsonrpc: '2.0', result: resultFor('initialize', options.connection) } as JSONRPCMessage;
    } catch (error) {
      return {
        error: { code: -32603, message: error instanceof Error ? error.message : 'Foreground MCP operation failed.' },
        id: nextRequest.id,
        jsonrpc: '2.0',
      } as JSONRPCMessage;
    }
  }
  if (nextRequest.method === 'ping') return { id: nextRequest.id, jsonrpc: '2.0', result: {} } as JSONRPCMessage;
  const resolved = operationFor(nextRequest);
  if (resolved === undefined || resolved.kind === 'invalid' || !options.allowedMethods.has(nextRequest.method as AgentBundleMcpRoutedMethod)) {
    return {
      error: resolved === undefined || !options.allowedMethods.has(nextRequest.method as AgentBundleMcpRoutedMethod)
        ? { code: -32601, message: errorMessage(nextRequest.method) }
        : { code: -32602, message: invalidParamsMessage(nextRequest.method) },
      id: nextRequest.id,
      jsonrpc: '2.0',
    } as JSONRPCMessage;
  }
  try {
    const result = await options.execute(resolved.operation);
    return { id: nextRequest.id, jsonrpc: '2.0', result: resultFor(nextRequest.method, result.value) } as JSONRPCMessage;
  } catch (error) {
    return {
      error: { code: -32603, message: error instanceof Error ? error.message : 'Foreground MCP operation failed.' },
      id: nextRequest.id,
      jsonrpc: '2.0',
    } as JSONRPCMessage;
  }
};

const settled = async (value: Promise<unknown> | undefined): Promise<void> => {
  await value?.catch(() => undefined);
};

/**
 * SDK Transport over the foreground's deliberately typed, epoch-bound MCP
 * routes. It is not an arbitrary browser-to-process JSON-RPC tunnel.
 */
export class AgentBundleRemoteTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #binding: McpRouteSessionBinding;
  readonly #routes: McpRouteClient;
  readonly #timeoutMs: number | undefined;
  #closed = false;
  #cancellations = new Map<AbortController, Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #lastSequence = 0;
  #operationControllers = new Set<AbortController>();
  #releasedSession: Promise<void> | undefined;
  #session: McpRouteSession | undefined;
  #startPromise: Promise<void> | undefined;
  #streamAbort: AbortController | undefined;
  #streamPromise: Promise<void> | undefined;
  #sendTail: Promise<void> = Promise.resolve();

  constructor(options: AgentBundleRemoteTransportOptions) {
    this.#binding = Object.freeze({ ...options.binding });
    this.#routes = options.routes;
    this.#timeoutMs = options.timeoutMs;
  }

  get session(): McpRouteSession {
    if (this.#closed || this.#session === undefined) throw new AgentBundleRemoteTransportError('MCP remote transport session is not available.');
    return this.#session;
  }

  get sessionId(): string {
    return this.session.id;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new AgentBundleRemoteTransportError('MCP remote transport is closed.');
    if (this.#startPromise === undefined) this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    await this.start();
    if (this.#closed) throw new AgentBundleRemoteTransportError('MCP remote transport is closed.');
    const nextNotification = notification(message);
    if (nextNotification?.method === 'notifications/cancelled') return this.#cancel(nextNotification.params);
    const next = this.#sendTail.then(() => this.#send(message));
    this.#sendTail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#streamAbort?.abort();
    for (const controller of this.#operationControllers) controller.abort();
    for (const controller of this.#cancellations.keys()) controller.abort();
    this.#closePromise = (async () => {
      try {
        await settled(this.#startPromise);
        await settled(this.#sendTail);
        await Promise.all([...this.#cancellations.values()].map(settled));
        await settled(this.#streamPromise);
        const session = this.#session;
        this.#session = undefined;
        if (session !== undefined) await this.#releaseSession(session.id);
      } catch (error) {
        this.#report(error);
      } finally {
        this.#emitClose();
      }
    })();
    return this.#closePromise;
  }

  async #start(): Promise<void> {
    try {
      const session = await this.#routes.create(this.#binding, this.#timeoutMs);
      if (
        session.binding.epochId !== this.#binding.epochId || session.binding.serverName !== this.#binding.serverName ||
        session.binding.target !== this.#binding.target
      ) {
        await this.#releaseSession(session.id);
        throw new AgentBundleRemoteTransportError('Foreground MCP session binding does not match the requested artifact.');
      }
      if (this.#closed) {
        await this.#releaseSession(session.id);
        return;
      }
      this.#session = session;
      this.#streamAbort = new AbortController();
      const stream = await this.#routes.stream(session.id, this.#lastSequence, this.#streamAbort.signal);
      if (this.#closed) return;
      const consuming = this.#consumeStreams(stream);
      this.#streamPromise = consuming;
      void consuming.catch((error: unknown) => { void this.#fail(error); });
    } catch (error) {
      this.#report(error);
      if (!this.#closed) void this.close();
      throw error;
    }
  }

  async #send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) throw new AgentBundleRemoteTransportError('MCP remote transport is closed.');
    const nextRequest = request(message);
    if (
      nextRequest !== undefined && nextRequest.method !== 'initialize' &&
      !['prompts/list', 'resources/templates/list', 'prompts/get'].includes(nextRequest.method)
    ) {
      const response = await dispatchAgentBundleMcpRequest(message, {
        allowedMethods: browserRoutedMethods,
        connection: this.session.connection,
        execute: async (operation) => {
          const controller = new AbortController();
          this.#operationControllers.add(controller);
          try {
            return { value: await this.#routes.operation(this.sessionId, operation, controller.signal) };
          } finally {
            this.#operationControllers.delete(controller);
          }
        },
      });
      if (!this.#closed && response !== undefined) this.#emit(response);
      return;
    }
    if (nextRequest !== undefined) {
      const resolved = operationFor(nextRequest);
      if (resolved === undefined || resolved.kind === 'invalid') {
        this.#emit({
          error: resolved === undefined
            ? { code: -32601, message: errorMessage(nextRequest.method) }
            : { code: -32602, message: invalidParamsMessage(nextRequest.method) },
          id: nextRequest.id,
          jsonrpc: '2.0',
        });
        return;
      }
      const controller = new AbortController();
      this.#operationControllers.add(controller);
      try {
        const result = await this.#routes.operation(this.sessionId, resolved.operation, controller.signal);
        if (!this.#closed) this.#emit({ id: nextRequest.id, jsonrpc: '2.0', result: resultFor(nextRequest.method, result) } as JSONRPCMessage);
      } catch (error) {
        if (!this.#closed) {
          this.#emit({
            error: { code: -32603, message: error instanceof Error ? error.message : 'Foreground MCP operation failed.' },
            id: nextRequest.id,
            jsonrpc: '2.0',
          });
        }
      } finally {
        this.#operationControllers.delete(controller);
      }
      return;
    }
    const nextNotification = notification(message);
    if (nextNotification?.method === 'notifications/initialized') return;
    this.#report(new AgentBundleRemoteTransportError('MCP transport received an invalid notification.'));
  }

  #cancel(value: unknown): Promise<void> {
    const params = asRecord(value);
    const requestId = params?.requestId;
    if (typeof requestId !== 'number' && typeof requestId !== 'string') {
      this.#report(new AgentBundleRemoteTransportError('MCP cancellation notification has an invalid request id.'));
      return Promise.resolve();
    }
    const controller = new AbortController();
    const cancellation = (async () => {
      try {
        await this.#routes.cancel(this.sessionId, requestKey(requestId), controller.signal);
      } catch (error) {
        if (!this.#closed) this.#report(error);
      }
    })();
    this.#cancellations.set(controller, cancellation);
    void cancellation.then(() => this.#cancellations.delete(controller));
    return cancellation;
  }

  async #consumeStreams(first: Response): Promise<void> {
    let response = first;
    let emptyReconnects = 0;
    while (!this.#closed) {
      const delivered = await this.#consumeStream(response);
      if (this.#closed) return;
      emptyReconnects = delivered ? 0 : emptyReconnects + 1;
      if (emptyReconnects > maxEmptyStreamReconnects) {
        throw new AgentBundleRemoteTransportError('Foreground MCP trace stream closed repeatedly without delivering an entry.');
      }
      response = await this.#routes.stream(this.sessionId, this.#lastSequence, this.#streamAbort?.signal);
    }
  }

  async #consumeStream(response: Response): Promise<boolean> {
    const signal = this.#streamAbort?.signal;
    if (signal === undefined) throw new AgentBundleRemoteTransportError('Foreground MCP trace stream is not active.');
    let delivered = false;
    await readNdjsonResponseFrames(response, (bytes) => {
      if (bytes.byteLength === 0) return;
      this.#deliverTrace(parseStrictResponseJson(bytes, invalidTrace));
      delivered = true;
    }, {
      invalidFrameError: invalidTrace,
      missingBodyError: () => new AgentBundleRemoteTransportError('Foreground MCP trace stream did not include a body.'),
      signal,
    });
    return delivered;
  }

  #deliverTrace(entry: unknown): void {
    if (!isRecord(entry) || typeof entry.sequence !== 'number' || !Number.isSafeInteger(entry.sequence) || entry.sequence <= 0) {
      if (isRecord(entry) && entry.type === 'replay.gap') {
        throw new AgentBundleRemoteTransportError('Foreground MCP trace replay has a retention gap.');
      }
      throw new AgentBundleRemoteTransportError('Foreground MCP trace stream contained an invalid entry.');
    }
    if (entry.sequence <= this.#lastSequence) return;
    this.#lastSequence = entry.sequence;
    if (entry.kind === 'frame' && entry.direction === 'server' && isJsonRpcNotification(entry.message)) this.#emit(entry.message);
  }

  async #fail(reason: unknown): Promise<void> {
    if (this.#closed) return;
    this.#report(reason);
    await this.close();
  }

  async #releaseSession(id: string): Promise<void> {
    if (this.#releasedSession === undefined) {
      this.#releasedSession = this.#routes.close(id).then(() => undefined);
    }
    return this.#releasedSession;
  }

  #emit(message: JSONRPCMessage): void {
    if (this.#closed) return;
    try {
      this.onmessage?.(message);
    } catch (error) {
      this.#report(error);
    }
  }

  #report(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try {
      this.onerror?.(error);
    } catch {
      // Consumer error observers must not break the transport lifecycle.
    }
  }

  #emitClose(): void {
    const callback = this.onclose;
    this.onclose = undefined;
    try {
      callback?.();
    } catch {
      // Consumers own their close callbacks.
    }
  }
}
