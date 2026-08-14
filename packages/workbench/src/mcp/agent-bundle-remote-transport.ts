import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/client';

import {
  McpRouteClient,
  type McpRouteConnection,
  type McpRouteOperation,
  type McpRouteSession,
  type McpRouteSessionBinding,
} from './mcp-route-client.ts';

const maxEmptyStreamReconnects = 3;

interface JsonRpcRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

interface TraceFrame {
  readonly direction: 'client' | 'server';
  readonly kind: 'frame';
  readonly message: unknown;
  readonly sequence: number;
}

export interface AgentBundleRemoteTransportOptions {
  readonly binding: McpRouteSessionBinding;
  readonly routes: McpRouteClient;
}

export class AgentBundleRemoteTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentBundleRemoteTransportError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const isJsonRpcMessage = (value: unknown): value is JSONRPCMessage =>
  isRecord(value) && value.jsonrpc === '2.0' &&
  (typeof value.method === 'string' || Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));

const traceFrame = (value: unknown): TraceFrame | undefined =>
  isRecord(value) && value.kind === 'frame' && (value.direction === 'client' || value.direction === 'server') &&
  typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0
    ? { direction: value.direction, kind: 'frame', message: value.message, sequence: value.sequence }
    : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined;

const operationFor = (message: JsonRpcRequest): McpRouteOperation | undefined => {
  if (message.method === 'initialize') return { operation: 'initialize' };
  if (
    message.method === 'tools/list' || message.method === 'resources/list' ||
    message.method === 'resources/templates/list' || message.method === 'prompts/list'
  ) return { operation: message.method };
  const params = asRecord(message.params);
  if (message.method === 'prompts/get' && typeof params?.name === 'string') {
    if (params.arguments !== undefined && (!isRecord(params.arguments) || Object.values(params.arguments).some((value) => typeof value !== 'string'))) return undefined;
    return {
      ...(params.arguments === undefined ? {} : { arguments: params.arguments as Record<string, string> }),
      name: params.name,
      operation: 'prompts/get',
    };
  }
  if (message.method === 'resources/read' && typeof params?.uri === 'string') return { operation: 'resources/read', uri: params.uri };
  if (message.method === 'tools/call' && typeof params?.name === 'string' && isRecord(params.arguments)) {
    return { arguments: params.arguments, name: params.name, operation: 'tools/call', requestId: requestKey(message.id) };
  }
  return undefined;
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
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #lastSequence = 0;
  #session: McpRouteSession | undefined;
  #startPromise: Promise<void> | undefined;
  #streamAbort: AbortController | undefined;
  #sendTail: Promise<void> = Promise.resolve();

  constructor(options: AgentBundleRemoteTransportOptions) {
    this.#binding = Object.freeze({ ...options.binding });
    this.#routes = options.routes;
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
    const next = this.#sendTail.then(() => this.#send(message));
    this.#sendTail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const session = this.#session;
    this.#session = undefined;
    this.#streamAbort?.abort();
    this.#closePromise = (async () => {
      try {
        if (session !== undefined) await this.#routes.close(session.id);
      } catch (error) {
        this.#report(error);
      } finally {
        this.#routes.forgetAuthentication();
        this.#emitClose();
      }
    })();
    return this.#closePromise;
  }

  async #start(): Promise<void> {
    try {
      const session = await this.#routes.create(this.#binding);
      if (
        session.binding.epochId !== this.#binding.epochId || session.binding.serverName !== this.#binding.serverName ||
        session.binding.target !== this.#binding.target
      ) throw new AgentBundleRemoteTransportError('Foreground MCP session binding does not match the requested artifact.');
      if (this.#closed) {
        await this.#routes.close(session.id);
        return;
      }
      this.#session = session;
      this.#streamAbort = new AbortController();
      const stream = await this.#routes.stream(session.id, this.#lastSequence, this.#streamAbort.signal);
      if (this.#closed) return;
      void this.#consumeStreams(stream).catch(async (error: unknown) => this.#fail(error));
    } catch (error) {
      this.#report(error);
      await this.close();
      throw error;
    }
  }

  async #send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) throw new AgentBundleRemoteTransportError('MCP remote transport is closed.');
    const nextRequest = request(message);
    if (nextRequest !== undefined) {
      const operation = operationFor(nextRequest);
      if (operation === undefined) {
        this.#emit({
          error: { code: -32601, message: errorMessage(nextRequest.method) },
          id: nextRequest.id,
          jsonrpc: '2.0',
        });
        return;
      }
      try {
        const result = await this.#routes.operation(this.sessionId, operation);
        this.#emit({ id: nextRequest.id, jsonrpc: '2.0', result: resultFor(nextRequest.method, result) } as JSONRPCMessage);
      } catch (error) {
        this.#report(error);
        this.#emit({
          error: { code: -32603, message: error instanceof Error ? error.message : 'Foreground MCP operation failed.' },
          id: nextRequest.id,
          jsonrpc: '2.0',
        });
      }
      return;
    }
    const nextNotification = notification(message);
    if (nextNotification?.method === 'notifications/initialized') return;
    if (nextNotification?.method === 'notifications/cancelled') {
      const params = asRecord(nextNotification.params);
      if (typeof params?.requestId !== 'number' && typeof params?.requestId !== 'string') {
        this.#report(new AgentBundleRemoteTransportError('MCP cancellation notification has an invalid request id.'));
        return;
      }
      try {
        await this.#routes.cancel(this.sessionId, requestKey(params.requestId));
      } catch (error) {
        this.#report(error);
      }
      return;
    }
    this.#report(new AgentBundleRemoteTransportError('MCP transport received an invalid notification.'));
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
    if (response.body === null) throw new AgentBundleRemoteTransportError('Foreground MCP trace stream did not include a body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let delivered = false;
    try {
      while (!this.#closed) {
        const next = await reader.read();
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (line.length === 0) continue;
          this.#deliverTrace(JSON.parse(line));
          delivered = true;
        }
      }
      buffered += decoder.decode();
      if (buffered.length > 0) this.#deliverTrace(JSON.parse(buffered));
      return delivered || buffered.length > 0;
    } finally {
      reader.releaseLock();
    }
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
    const frame = traceFrame(entry);
    if (frame?.direction === 'server' && isJsonRpcMessage(frame.message)) this.#emit(frame.message);
  }

  async #fail(reason: unknown): Promise<void> {
    if (this.#closed) return;
    this.#report(reason);
    await this.close();
  }

  #emit(message: JSONRPCMessage): void {
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
