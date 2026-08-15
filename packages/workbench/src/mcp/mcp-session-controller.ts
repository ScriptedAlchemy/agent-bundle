import { Client, type Transport } from '@modelcontextprotocol/client';

import type {
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceReplayGap,
} from '../../../agent-bundle/src/dev/mcp-session-protocol.ts';
import { AgentBundleRemoteTransport } from './agent-bundle-remote-transport.ts';
import {
  invocationHistoryFor,
  createMcpBrowserSessionModel,
  reduceMcpBrowserSession,
  type McpBrowserSessionConnection,
  type McpBrowserSessionDiagnostic,
  type McpBrowserSessionEvent,
  type McpBrowserSessionInvocation,
  type McpBrowserSessionModel,
} from './mcp-session-model.ts';
import type {
  McpRouteCatalog,
  McpRouteClient,
  McpRouteConnection,
  McpRouteSession,
  McpRouteSessionBinding,
  McpRouteTrace,
} from './mcp-route-client.ts';

export type McpSessionControllerBinding = McpRouteSessionBinding;

export type McpSessionControllerOperation = Exclude<McpSessionOperation, 'cancel' | 'close' | 'restart'>;

export interface McpSessionControllerRequest {
  readonly id: string;
  readonly operation: McpSessionControllerOperation;
  readonly request: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface McpSessionControllerReplay {
  readonly id: string;
  readonly invocationId: string;
  readonly signal?: AbortSignal;
}

export interface McpSessionControllerRoutes {
  catalog(id: string): Promise<McpRouteCatalog>;
  config(id: string): Promise<unknown>;
  restart(id: string): Promise<McpRouteConnection>;
  stream(id: string, after: number, signal?: AbortSignal): Promise<Response>;
  trace(id: string, after?: number): Promise<McpRouteTrace>;
}

export interface McpSessionControllerTransport extends Transport {
  readonly session: McpRouteSession;
  close(): Promise<void>;
  start(): Promise<void>;
}

export interface McpSessionControllerClient {
  close(): Promise<void>;
  connect(transport: Transport): Promise<void>;
  request(
    request: Readonly<{ readonly method: string; readonly params?: Readonly<Record<string, unknown>> }> ,
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<unknown>;
}

export interface McpSessionControllerOptions {
  readonly clientFactory?: () => McpSessionControllerClient;
  readonly routes: McpSessionControllerRoutes;
  readonly transportFactory?: (options: Readonly<{
    readonly binding: McpSessionControllerBinding;
    readonly routes: McpSessionControllerRoutes;
  }>) => McpSessionControllerTransport;
}

export type McpSessionControllerListener = (model: McpBrowserSessionModel) => void;

export class McpSessionControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSessionControllerError';
  }
}

interface ActiveRequest {
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
}

type ControllerState = 'closed' | 'closing' | 'failed' | 'idle' | 'opening' | 'ready' | 'restarting';

type TraceMessage = McpSessionTraceEntry | McpSessionTraceReplayGap;

interface TraceRefresh {
  readonly generation: number;
  readonly live: TraceMessage[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBinding = (value: unknown): value is McpSessionControllerBinding =>
  isRecord(value) && Object.keys(value).length === 3 &&
  typeof value.epochId === 'string' && value.epochId.length > 0 &&
  typeof value.serverName === 'string' && value.serverName.length > 0 &&
  (value.target === 'claude' || value.target === 'codex' || value.target === 'portable');

const sameBinding = (left: McpSessionControllerBinding, right: McpSessionControllerBinding): boolean =>
  left.epochId === right.epochId && left.serverName === right.serverName && left.target === right.target;

const connectionFor = (connection: McpRouteConnection): McpBrowserSessionConnection => Object.freeze({
  ...(connection.protocolVersion === undefined ? {} : { protocolVersion: connection.protocolVersion }),
  ...(connection.capabilities === undefined ? {} : { serverCapabilities: connection.capabilities }),
  ...(connection.server === undefined ? {} : { serverInfo: connection.server }),
});

const invalidTrace = (): McpSessionControllerError =>
  new McpSessionControllerError('Foreground MCP trace stream contained an invalid entry.');

const validSequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

const validCursor = (value: unknown): value is number => validSequence(value) && value > 0;

const traceEntry = (value: unknown): McpSessionTraceEntry | McpSessionTraceReplayGap => {
  if (!isRecord(value)) throw invalidTrace();
  if (value.type === 'replay.gap') {
    if (
      !validCursor(value.earliestAvailableSequence) || !validCursor(value.latestDroppedSequence) ||
      typeof value.requestedAfterSequence !== 'number' || !Number.isSafeInteger(value.requestedAfterSequence) ||
      value.requestedAfterSequence < 0
    ) throw invalidTrace();
    return {
      earliestAvailableSequence: value.earliestAvailableSequence,
      latestDroppedSequence: value.latestDroppedSequence,
      requestedAfterSequence: value.requestedAfterSequence,
      type: 'replay.gap',
    };
  }
  if (!validCursor(value.sequence) || typeof value.occurredAt !== 'number' || !Number.isFinite(value.occurredAt)) throw invalidTrace();
  if (value.kind === 'frame' && (value.direction === 'client' || value.direction === 'server')) {
    return { direction: value.direction, kind: 'frame', message: value.message, occurredAt: value.occurredAt, sequence: value.sequence };
  }
  if (value.kind === 'stderr' && typeof value.text === 'string') {
    return { kind: 'stderr', occurredAt: value.occurredAt, sequence: value.sequence, text: value.text };
  }
  if (value.kind === 'logging' || value.kind === 'progress') {
    return { kind: value.kind, occurredAt: value.occurredAt, payload: value.payload, sequence: value.sequence };
  }
  if (
    value.kind === 'operation' && typeof value.operation === 'string' && typeof value.phase === 'string' &&
    ['callTool', 'cancel', 'close', 'getPrompt', 'initialize', 'listPrompts', 'listResources', 'listResourceTemplates', 'listTools', 'readResource', 'restart'].includes(value.operation) &&
    ['started', 'succeeded', 'failed'].includes(value.phase)
  ) return {
    kind: 'operation',
    occurredAt: value.occurredAt,
    operation: value.operation as McpSessionOperation,
    phase: value.phase as 'failed' | 'started' | 'succeeded',
    sequence: value.sequence,
  };
  throw invalidTrace();
};

const traceOverflow = (value: unknown): McpSessionTraceReplayGap | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !validSequence(value.afterSequence) || !validSequence(value.droppedThroughSequence)) {
    throw invalidTrace();
  }
  if (value.afterSequence < 0 || value.droppedThroughSequence < value.afterSequence) throw invalidTrace();
  return {
    earliestAvailableSequence: value.droppedThroughSequence + 1,
    latestDroppedSequence: value.droppedThroughSequence,
    requestedAfterSequence: value.afterSequence,
    type: 'replay.gap',
  };
};

const isReplayGap = (entry: TraceMessage): entry is McpSessionTraceReplayGap =>
  'type' in entry && entry.type === 'replay.gap';

const traceCursor = (entry: TraceMessage): number =>
  isReplayGap(entry) ? entry.latestDroppedSequence : entry.sequence;

const activeRequest = (): ActiveRequest => {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  return { abort: new AbortController(), settle, settled };
};

const requestFor = (
  operation: McpSessionControllerOperation,
  params: Readonly<Record<string, unknown>>,
): Readonly<{ readonly method: string; readonly params?: Readonly<Record<string, unknown>> }> => {
  if (operation === 'initialize') return { method: 'initialize' };
  if (operation === 'listTools') return { method: 'tools/list' };
  if (operation === 'listResources') return { method: 'resources/list' };
  if (operation === 'listResourceTemplates') return { method: 'resources/templates/list' };
  if (operation === 'listPrompts') return { method: 'prompts/list' };
  if (operation === 'getPrompt') return { method: 'prompts/get', params };
  if (operation === 'readResource') return { method: 'resources/read', params };
  if (operation === 'callTool') return { method: 'tools/call', params };
  throw new McpSessionControllerError(`MCP operation ${JSON.stringify(operation)} is not supported by the session controller.`);
};

const diagnosticFor = (code: string, reason: unknown): McpBrowserSessionDiagnostic => ({
  code,
  message: reason instanceof Error ? reason.message : String(reason),
  severity: 'error',
});

const invocationError = (reason: unknown): unknown => reason instanceof Error
  ? { message: reason.message, name: reason.name }
  : reason;

const defaultClient = (): McpSessionControllerClient =>
  new Client({ name: 'agent-bundle-workbench', version: '0.0.0' }) as unknown as McpSessionControllerClient;

const defaultTransport = (options: Readonly<{
  readonly binding: McpSessionControllerBinding;
  readonly routes: McpSessionControllerRoutes;
}>): McpSessionControllerTransport => new AgentBundleRemoteTransport({
  binding: options.binding,
  routes: options.routes as McpRouteClient,
});

/** Browser-facing lifecycle owner for one epoch-bound MCP session. */
export class McpSessionController {
  readonly #clientFactory: () => McpSessionControllerClient;
  readonly #listeners = new Set<McpSessionControllerListener>();
  readonly #routes: McpSessionControllerRoutes;
  readonly #transportFactory: (options: Readonly<{
    readonly binding: McpSessionControllerBinding;
    readonly routes: McpSessionControllerRoutes;
  }>) => McpSessionControllerTransport;
  #binding: McpSessionControllerBinding | undefined;
  #client: McpSessionControllerClient | undefined;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #generation = 0;
  #model = createMcpBrowserSessionModel('mcp-session-controller');
  #requests = new Map<string, ActiveRequest>();
  #traceRefresh: TraceRefresh | undefined;
  #session: McpRouteSession | undefined;
  #state: ControllerState = 'idle';
  #traceAbort: AbortController | undefined;
  #traceTask: Promise<void> | undefined;
  #transport: McpSessionControllerTransport | undefined;

  constructor(options: McpSessionControllerOptions) {
    this.#clientFactory = options.clientFactory ?? defaultClient;
    this.#routes = options.routes;
    this.#transportFactory = options.transportFactory ?? defaultTransport;
  }

  get history(): readonly McpBrowserSessionInvocation[] {
    return invocationHistoryFor(this.#model);
  }

  get model(): McpBrowserSessionModel {
    return this.#model;
  }

  subscribe(listener: McpSessionControllerListener): () => void {
    this.#listeners.add(listener);
    listener(this.#model);
    return () => this.#listeners.delete(listener);
  }

  async open(binding: McpSessionControllerBinding): Promise<McpBrowserSessionModel> {
    if (!isBinding(binding)) throw new McpSessionControllerError('MCP session binding must contain only epochId, target, and serverName.');
    if (this.#state === 'closing') throw new McpSessionControllerError('MCP session controller is closing.');
    if (this.#state !== 'idle') throw new McpSessionControllerError('MCP session controller is already open.');
    this.#state = 'opening';
    const generation = ++this.#generation;
    const requested = Object.freeze({ ...binding });
    const transport = this.#transportFactory({ binding: requested, routes: this.#routes });
    const client = this.#clientFactory();
    this.#binding = requested;
    this.#transport = transport;
    this.#client = client;
    try {
      await client.connect(transport);
      if (!this.#current(generation)) return this.#model;
      const session = transport.session;
      if (!sameBinding(session.binding, requested)) {
        throw new McpSessionControllerError('Foreground MCP session binding does not match the requested artifact.');
      }
      this.#session = session;
      this.#model = createMcpBrowserSessionModel(session.id);
      this.#publish({ binding: requested, type: 'open' });
      this.#watchTransport(transport, generation);
      await this.#refresh(session.connection, generation);
      return this.#model;
    } catch (reason) {
      if (this.#current(generation)) await this.#failSession(generation, client, transport, 'mcp.connect.failed', reason);
      throw reason;
    }
  }

  async restart(): Promise<McpBrowserSessionModel> {
    this.#assertReady('restart');
    const session = this.#requireSession();
    const generation = this.#generation;
    this.#state = 'restarting';
    this.#publish({ type: 'restart' });
    try {
      const connection = await this.#routes.restart(session.id);
      if (!this.#current(generation)) return this.#model;
      await this.#refresh(connection, generation);
      return this.#model;
    } catch (reason) {
      if (this.#current(generation)) await this.#failSession(generation, this.#client, this.#transport, 'mcp.restart.failed', reason);
      throw reason;
    }
  }

  async invoke(input: McpSessionControllerRequest): Promise<unknown> {
    return this.#runInvocation(input);
  }

  async replay(input: McpSessionControllerReplay): Promise<unknown> {
    this.#assertReady('invoke');
    const original = this.history.find((entry) => entry.id === input.invocationId);
    if (original === undefined) {
      const error = new McpSessionControllerError(`MCP invocation ${JSON.stringify(input.invocationId)} is not available for replay.`);
      this.#publish({ diagnostic: diagnosticFor('mcp.replay.unavailable', error), type: 'failed' });
      throw error;
    }
    const binding = this.#binding;
    if (binding === undefined || original.binding === undefined || !sameBinding(original.binding as McpSessionControllerBinding, binding)) {
      const error = new McpSessionControllerError(`MCP invocation ${JSON.stringify(input.invocationId)} is bound to a different artifact.`);
      this.#publish({ diagnostic: diagnosticFor('mcp.replay.binding', error), type: 'failed' });
      throw error;
    }
    return this.#runInvocation({
      id: input.id,
      operation: original.operation as McpSessionControllerOperation,
      request: original.request as Readonly<Record<string, unknown>>,
      signal: input.signal,
    }, original.id);
  }

  cancel(id: string): boolean {
    const active = this.#requests.get(id);
    if (active === undefined) return false;
    active.abort.abort();
    return true;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = 'closing';
    this.#closing = true;
    this.#generation += 1;
    this.#publish({ type: 'close' });
    const client = this.#client;
    const transport = this.#transport;
    this.#closePromise = this.#drainResources(client, transport).then(() => {
      this.#clearResources(client, transport);
      this.#state = 'closed';
      this.#publish({ type: 'closed' });
    });
    return this.#closePromise;
  }

  async #refresh(connection: McpRouteConnection, generation: number): Promise<void> {
    const session = this.#requireSession();
    const after = this.#model.timeline.lastSequence;
    const refresh: TraceRefresh = { generation, live: [] };
    this.#traceRefresh = refresh;
    this.#publish({ connection: connectionFor(connection), type: 'connection' });
    try {
      const trace = this.#routes.trace(session.id, after).then((next) => {
        const overflow = traceOverflow(next.overflow);
        const snapshot = Object.freeze([
          ...(overflow === undefined ? [] : [overflow]),
          ...next.entries.map(traceEntry),
        ]);
        if (this.#current(generation)) this.#publishTrace(snapshot);
        return snapshot;
      });
      const [catalog, config] = await Promise.all([
        this.#routes.catalog(session.id),
        this.#routes.config(session.id),
        trace,
      ]);
      if (!this.#current(generation)) return;
      this.#publishTrace(refresh.live);
      this.#traceRefresh = undefined;
      this.#publish(
        { catalogs: catalog, type: 'catalogs' },
        { config: config as McpSessionInspectorConfig, type: 'config' },
      );
      if (!this.#current(generation)) return;
      this.#state = 'ready';
      this.#publish({ type: 'ready' });
      if (this.#traceAbort === undefined) {
        const task = this.#subscribeTrace(session.id, generation);
        this.#traceTask = task;
        void task.finally(() => {
          if (this.#traceTask === task) this.#traceTask = undefined;
        });
      }
    } finally {
      if (this.#traceRefresh === refresh) this.#traceRefresh = undefined;
    }
  }

  async #subscribeTrace(sessionId: string, generation: number): Promise<void> {
    const abort = new AbortController();
    this.#traceAbort = abort;
    try {
      const response = await this.#routes.stream(sessionId, this.#model.timeline.lastSequence, abort.signal);
      if (response.body === null) throw new McpSessionControllerError('Foreground MCP trace stream did not include a body.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      try {
        while (!abort.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          buffered += decoder.decode(next.value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) if (line.length > 0) this.#receiveTrace(traceEntry(JSON.parse(line)), generation);
        }
        buffered += decoder.decode();
        if (buffered.length > 0) this.#receiveTrace(traceEntry(JSON.parse(buffered)), generation);
      } finally {
        reader.releaseLock();
      }
      if (!abort.signal.aborted && this.#current(generation)) {
        this.#publish({
          diagnostic: { code: 'mcp.trace.stream.closed', message: 'Foreground MCP trace stream closed unexpectedly.', severity: 'error' },
          type: 'failed',
        });
      }
    } catch (reason) {
      if (!abort.signal.aborted && this.#current(generation)) this.#publish({
        diagnostic: diagnosticFor('mcp.trace.stream.error', reason),
        type: 'failed',
      });
    }
  }

  #receiveTrace(entry: McpSessionTraceEntry | McpSessionTraceReplayGap, generation: number): void {
    if (!this.#current(generation)) return;
    if (this.#traceRefresh?.generation === generation) {
      this.#traceRefresh.live.push(entry);
      return;
    }
    this.#publishTrace([entry]);
  }

  #current(generation: number): boolean {
    return !this.#closing && this.#generation === generation;
  }

  #assertReady(action: 'invoke' | 'restart'): void {
    if (this.#state === 'closing') throw new McpSessionControllerError('MCP session controller is closing.');
    if (this.#state === 'restarting') throw new McpSessionControllerError('MCP session controller is restarting.');
    if (this.#state === 'opening') throw new McpSessionControllerError('MCP session controller is opening.');
    if (this.#state !== 'ready') throw new McpSessionControllerError(`MCP session controller cannot ${action} while ${this.#state}.`);
  }

  #publishTrace(entries: readonly TraceMessage[]): void {
    const ordered = [...entries].sort((left, right) => traceCursor(left) - traceCursor(right));
    for (const entry of ordered) {
      const cursor = traceCursor(entry);
      if (cursor <= this.#model.timeline.lastSequence) continue;
      this.#publish({ entry, type: 'trace' });
    }
  }

  #watchTransport(transport: McpSessionControllerTransport, generation: number): void {
    const onclose = transport.onclose;
    const onerror = transport.onerror;
    transport.onerror = (reason) => {
      onerror?.(reason);
      void this.#failSession(generation, transport === this.#transport ? this.#client : undefined, transport, 'mcp.transport.error', reason);
    };
    transport.onclose = () => {
      onclose?.();
      void this.#failSession(
        generation,
        transport === this.#transport ? this.#client : undefined,
        transport,
        'mcp.transport.closed',
        new McpSessionControllerError('Foreground MCP transport closed unexpectedly.'),
      );
    };
  }

  async #failSession(
    generation: number,
    client: McpSessionControllerClient | undefined,
    transport: McpSessionControllerTransport | undefined,
    code: string,
    reason: unknown,
  ): Promise<void> {
    if (!this.#current(generation)) return;
    this.#state = 'failed';
    this.#generation += 1;
    this.#publish({ diagnostic: diagnosticFor(code, reason), type: 'failed' });
    if (this.#state === 'closing') return;
    await this.#drainResources(client, transport);
    this.#clearResources(client, transport);
  }

  async #drainResources(
    client: McpSessionControllerClient | undefined,
    transport: McpSessionControllerTransport | undefined,
  ): Promise<void> {
    this.#traceAbort?.abort();
    const active = [...this.#requests.values()];
    for (const request of active) request.abort.abort();
    await Promise.allSettled([
      ...active.map((request) => request.settled),
      ...(this.#traceTask === undefined ? [] : [this.#traceTask]),
    ]);
    await Promise.allSettled([client?.close(), transport?.close()]);
  }

  #clearResources(
    client: McpSessionControllerClient | undefined,
    transport: McpSessionControllerTransport | undefined,
  ): void {
    if (this.#client === client) this.#client = undefined;
    if (this.#transport === transport) this.#transport = undefined;
    if (this.#client === undefined && this.#transport === undefined) {
      this.#binding = undefined;
      this.#session = undefined;
      this.#traceAbort = undefined;
      this.#traceTask = undefined;
      this.#requests.clear();
    }
  }

  #publish(...events: readonly McpBrowserSessionEvent[]): void {
    let next = this.#model;
    for (const event of events) next = reduceMcpBrowserSession(next, event);
    this.#model = next;
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch {
        // A view listener must not affect the session lifecycle.
      }
    }
  }

  #requireClient(): McpSessionControllerClient {
    if (this.#client === undefined) throw new McpSessionControllerError('MCP session controller is not connected.');
    return this.#client;
  }

  #requireSession(): McpRouteSession {
    if (this.#session === undefined) throw new McpSessionControllerError('MCP session controller is not connected.');
    return this.#session;
  }

  async #runInvocation(input: McpSessionControllerRequest, replayOf?: string): Promise<unknown> {
    this.#assertReady('invoke');
    const client = this.#requireClient();
    this.#requireSession();
    if (!isRecord(input.request) || typeof input.id !== 'string' || input.id.length === 0) {
      throw new McpSessionControllerError('MCP invocation requires a non-empty id and an object request.');
    }
    if (this.#requests.has(input.id)) throw new McpSessionControllerError(`MCP invocation ${JSON.stringify(input.id)} is already active.`);
    let operation: Readonly<{ readonly method: string; readonly params?: Readonly<Record<string, unknown>> }>;
    try {
      operation = requestFor(input.operation, input.request);
    } catch (reason) {
      this.#publish({ diagnostic: diagnosticFor('mcp.operation.unsupported', reason), type: 'failed' });
      throw reason;
    }
    const active = activeRequest();
    const onAbort = () => active.abort.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    this.#requests.set(input.id, active);
    this.#publish({
      request: {
        id: input.id,
        operation: input.operation,
        ...(replayOf === undefined ? {} : { replayOf }),
        request: input.request,
        startedAt: Date.now(),
      },
      type: 'request.start',
    });
    try {
      const result = await client.request(operation, { signal: active.abort.signal });
      if (!this.#closing) this.#publish({ completedAt: Date.now(), id: input.id, result, type: 'request.settled' });
      return result;
    } catch (reason) {
      if (!this.#closing) this.#publish({ completedAt: Date.now(), error: invocationError(reason), id: input.id, type: 'request.settled' });
      throw reason;
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      this.#requests.delete(input.id);
      active.settle();
    }
  }
}

export const createMcpSessionController = (options: McpSessionControllerOptions): McpSessionController =>
  new McpSessionController(options);
