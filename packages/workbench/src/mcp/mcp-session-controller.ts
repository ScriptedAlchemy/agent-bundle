import { Client, type JSONRPCMessage, type Transport, type TransportSendOptions } from '@modelcontextprotocol/client';

import type {
  McpSessionBinding,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceReplayGap,
} from '../../../agent-bundle/src/dev/mcp-session-protocol.ts';
import type {
  DevRuntimeMcpAppRunBinding,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpOperationResult,
  DevRuntimeMcpSessionControlRequest,
  DevRuntimeMcpSessionRequest,
} from '../../../agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonObject } from '../../../agent-bundle/src/dev/types.ts';
import type { McpAppBoundOperationResult } from '../../../agent-bundle/src/dev/mcp-app-runtime-binding-service.ts';
import type { McpAppJsonValue } from '../../../agent-bundle/src/dev/mcp-app-metadata.ts';
import type { McpAppBindingOperation } from '../../../agent-bundle/src/dev/mcp-app-runtime-preview-service.ts';
import { AgentBundleRemoteTransport, dispatchAgentBundleMcpRequest, type AgentBundleMcpDispatchResult } from './agent-bundle-remote-transport.ts';
import {
  invocationHistoryFor,
  createMcpBrowserSessionModel,
  reduceMcpBrowserSession,
  type McpBrowserSessionConnection,
  type McpBrowserSessionDiagnostic,
  type McpBrowserSessionEvent,
  type McpBrowserSessionInvocation,
  type McpBrowserSessionBinding,
  type McpBrowserSessionModel,
} from './mcp-session-model.ts';
import {
  McpRouteClientError,
  type McpRouteCatalog,
  type McpRouteClient,
  type McpRouteConnection,
  type McpRouteOperation,
  type McpRouteRuntimeRestart,
  type McpRouteRuntimeSession,
  type McpRouteSession,
  type McpRouteSessionBinding,
  type McpRouteTrace,
} from './mcp-route-client.ts';

export type McpSessionControllerBinding =
  | Readonly<{ readonly kind: 'artifact'; readonly binding: McpRouteSessionBinding }>
  | Readonly<{
      readonly kind: 'runtime';
      readonly binding: DevRuntimeMcpAppRunBinding;
      readonly session: McpRouteRuntimeSession;
    }>;

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
  closeRuntime?(request: DevRuntimeMcpSessionControlRequest): Promise<void>;
  executeRuntime?(sessionId: string, request: DevRuntimeMcpOperationRequest, signal?: AbortSignal): Promise<DevRuntimeMcpOperationResult>;
  openRuntime?(request: DevRuntimeMcpSessionRequest): Promise<McpRouteRuntimeSession>;
  restartRuntime?(request: DevRuntimeMcpSessionControlRequest): Promise<McpRouteRuntimeRestart>;
}

export interface McpSessionControllerRuntimeRoutes {
  openRuntime(request: DevRuntimeMcpSessionRequest): Promise<McpRouteRuntimeSession>;
  restartRuntime(request: DevRuntimeMcpSessionControlRequest): Promise<McpRouteRuntimeRestart>;
  closeRuntime(request: DevRuntimeMcpSessionControlRequest): Promise<void>;
  executeRuntime(sessionId: string, request: DevRuntimeMcpOperationRequest, signal?: AbortSignal): Promise<DevRuntimeMcpOperationResult>;
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

export interface McpSessionControllerAppAccess {
  readonly client: Client;
  readonly sessionId: string;
  readonly sessionRevision: number;
  close(): Promise<void>;
}

/** One opaque runtime App authority. It has no access to the stable runtime session lifecycle. */
export interface McpSessionControllerAppAttachment {
  readonly bindingId: string;
  execute(operation: McpAppBindingOperation, signal?: AbortSignal): Promise<McpAppBoundOperationResult>;
  /** Invoked only after the controller has revalidated the current session identity. */
  onResult?(operation: McpAppBindingOperation, result: McpAppBoundOperationResult): void;
}

export interface McpSessionControllerOptions {
  readonly appClientFactory?: () => Client;
  readonly clientFactory?: () => McpSessionControllerClient;
  readonly routes: McpSessionControllerRoutes;
  readonly transportFactory?: (options: Readonly<{
    readonly binding: McpRouteSessionBinding;
    readonly routes: McpSessionControllerRoutes;
    readonly timeoutMs?: number;
  }>) => McpSessionControllerTransport;
}

export type McpSessionControllerListener = (model: McpBrowserSessionModel) => void;

export class McpSessionControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSessionControllerError';
  }
}

export type McpSessionControllerCloseResource = 'app-client' | 'app-transport' | 'client' | 'runtime' | 'trace' | 'transport' | `request:${string}`;

export interface McpSessionControllerCloseFailure {
  readonly reason: unknown;
  readonly resource: McpSessionControllerCloseResource;
}

const reasonMessage = (reason: unknown): string => {
  try {
    if (!(reason instanceof Error)) return String(reason);
    const message: unknown = reason.message;
    return typeof message === 'string' ? message : String(message);
  } catch {
    return 'Unknown error';
  }
};

const isOperationRouteFailure = (reason: unknown): boolean =>
  reason instanceof McpRouteClientError && reason.code === 'AB8019' && reason.message === 'MCP session operation could not be completed.';

const frozenCloseFailures = (
  failures: readonly McpSessionControllerCloseFailure[],
): readonly McpSessionControllerCloseFailure[] => Object.freeze(failures.map(({ reason, resource }) => Object.freeze({ reason, resource })));

export class McpSessionControllerCloseError extends McpSessionControllerError {
  readonly failures: readonly McpSessionControllerCloseFailure[];

  constructor(failures: readonly McpSessionControllerCloseFailure[]) {
    super(`MCP session controller close failed for ${failures.map(({ resource }) => resource).join(', ')}.`);
    this.name = 'McpSessionControllerCloseError';
    this.failures = frozenCloseFailures(failures);
    Object.freeze(this);
  }
}

export class McpSessionControllerFailureError extends McpSessionControllerError {
  readonly failures: readonly McpSessionControllerCloseFailure[];
  readonly primary: unknown;

  constructor(primary: unknown, failures: readonly McpSessionControllerCloseFailure[]) {
    super(failures.length === 0
      ? `MCP session controller failed: ${reasonMessage(primary)}.`
      : `MCP session controller failed: ${reasonMessage(primary)}. Cleanup failed for ${failures.map(({ resource }) => resource).join(', ')}.`);
    this.name = 'McpSessionControllerFailureError';
    this.failures = frozenCloseFailures(failures);
    this.primary = primary;
    Object.freeze(this);
  }
}

interface ActiveRequest {
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
}

interface ConstructionDrain {
  readonly settled: Promise<void>;
  settle(): void;
}

interface CleanupTask {
  readonly resource: McpSessionControllerCloseResource;
  run(): unknown;
}

interface AttachedApp {
  readonly authority: McpSessionControllerAppAttachment;
  readonly binding: Extract<McpSessionControllerBinding, { readonly kind: 'runtime' }>;
  readonly client: Client;
  readonly transport: RuntimeAttachedMcpTransport;
  clientClosePromise?: Promise<void>;
  closePromise?: Promise<void>;
  transportClosePromise?: Promise<void>;
}

interface RuntimeSessionAdoption {
  readonly binding: Extract<McpSessionControllerBinding, { readonly kind: 'runtime' }>;
  readonly promise: Promise<McpBrowserSessionModel>;
}

type ControllerState = 'closed' | 'closing' | 'failed' | 'idle' | 'opening' | 'ready' | 'restarting';

type TraceMessage = McpSessionTraceEntry | McpSessionTraceReplayGap;

interface TraceRefresh {
  readonly generation: number;
  readonly live: TraceMessage[];
}

const constructionDrain = (): ConstructionDrain => {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  return { settled, settle };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDataDescriptor = (value: PropertyDescriptor | undefined): value is PropertyDescriptor & { readonly value: unknown } =>
  value !== undefined && Object.hasOwn(value, 'value') && !Object.hasOwn(value, 'get') && !Object.hasOwn(value, 'set');

const artifactBindingSnapshot = (value: unknown): McpRouteSessionBinding | undefined => {
  try {
    if (!isRecord(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const prototype = Object.getPrototypeOf(value);
    if (
      keys.length !== 3 ||
      keys.some((key) => key !== 'epochId' && key !== 'serverName' && key !== 'target') ||
      (prototype !== Object.prototype && prototype !== null)
    ) return undefined;
    const epochId = descriptors.epochId;
    const serverName = descriptors.serverName;
    const target = descriptors.target;
    if (!isDataDescriptor(epochId) || !isDataDescriptor(serverName) || !isDataDescriptor(target)) return undefined;
    if (
      typeof epochId.value !== 'string' || epochId.value.length === 0 ||
      typeof serverName.value !== 'string' || serverName.value.length === 0 ||
      (target.value !== 'claude' && target.value !== 'codex' && target.value !== 'portable')
    ) return undefined;
    return Object.freeze({ epochId: epochId.value, serverName: serverName.value, target: target.value });
  } catch {
    return undefined;
  }
};

const isRuntimeBinding = (value: unknown): value is DevRuntimeMcpAppRunBinding =>
  isRecord(value) && Object.keys(value).length === 8 &&
  typeof value.definitionDigest === 'string' && value.definitionDigest.length > 0 &&
  typeof value.registryRevision === 'number' && Number.isSafeInteger(value.registryRevision) && value.registryRevision > 0 &&
  typeof value.serverDigest === 'string' && value.serverDigest.length > 0 &&
  typeof value.serverName === 'string' && value.serverName.length > 0 &&
  typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
  typeof value.sessionRevision === 'number' && Number.isSafeInteger(value.sessionRevision) && value.sessionRevision > 0 &&
  typeof value.target === 'string' && value.target.length > 0 &&
  typeof value.transportDigest === 'string' && value.transportDigest.length > 0;

const isRuntimeConnection = (value: unknown): value is McpRouteConnection => {
  if (!isRecord(value)) return false;
  if (value.protocolEra !== undefined && value.protocolEra !== 'legacy' && value.protocolEra !== 'modern') return false;
  if (value.protocolVersion !== undefined && typeof value.protocolVersion !== 'string') return false;
  if (value.server !== undefined && (!isRecord(value.server) || typeof value.server.name !== 'string' || typeof value.server.version !== 'string')) return false;
  return true;
};

const isRuntimeSession = (value: unknown): value is McpRouteRuntimeSession =>
  isRecord(value) && Object.keys(value).length === 3 && isRuntimeBinding(value.binding) && isRuntimeConnection(value.connection) &&
  (value.state === 'connecting' || value.state === 'ready' || value.state === 'restarting' || value.state === 'failed' || value.state === 'closed');

const sameRuntimeBinding = (left: DevRuntimeMcpAppRunBinding, right: DevRuntimeMcpAppRunBinding): boolean =>
  left.definitionDigest === right.definitionDigest && left.registryRevision === right.registryRevision &&
  left.serverDigest === right.serverDigest && left.serverName === right.serverName && left.sessionId === right.sessionId &&
  left.sessionRevision === right.sessionRevision && left.target === right.target && left.transportDigest === right.transportDigest;

type RuntimeSessionAdoptionLane = 'implementation' | 'restart';

const runtimeSessionAdoptionLane = (
  previous: DevRuntimeMcpAppRunBinding,
  next: DevRuntimeMcpAppRunBinding,
): RuntimeSessionAdoptionLane | undefined => {
  if (
    next.sessionId !== previous.sessionId ||
    next.serverName !== previous.serverName ||
    next.target !== previous.target
  ) return undefined;
  if (
    next.sessionRevision > previous.sessionRevision &&
    next.registryRevision > previous.registryRevision
  ) return 'restart';
  if (
    next.sessionRevision === previous.sessionRevision &&
    next.registryRevision === previous.registryRevision &&
    next.definitionDigest === previous.definitionDigest &&
    next.transportDigest === previous.transportDigest &&
    next.serverDigest !== previous.serverDigest
  ) return 'implementation';
  return undefined;
};

const runtimeControllerBinding = (value: unknown): Extract<McpSessionControllerBinding, { readonly kind: 'runtime' }> | undefined => {
  if (!isRuntimeSession(value)) return undefined;
  const binding = controllerBinding(Object.freeze({ binding: value.binding, kind: 'runtime' as const, session: value }));
  return binding?.kind === 'runtime' ? binding : undefined;
};

const controllerBinding = (value: unknown): McpSessionControllerBinding | undefined => {
  const artifact = artifactBindingSnapshot(value);
  if (artifact !== undefined) return Object.freeze({ kind: 'artifact', binding: artifact });
  try {
    if (!isRecord(value) || (value.kind !== 'artifact' && value.kind !== 'runtime')) return undefined;
    if (value.kind === 'artifact') {
      const snapshot = artifactBindingSnapshot(value.binding);
      return snapshot === undefined ? undefined : Object.freeze({ kind: 'artifact', binding: snapshot });
    }
    if (isRuntimeBinding(value.binding) && isRuntimeSession(value.session) && sameRuntimeBinding(value.binding, value.session.binding)) {
      const runtimeBinding = Object.freeze({ ...value.binding });
      return Object.freeze({
        kind: 'runtime',
        binding: runtimeBinding,
        session: Object.freeze({
          binding: runtimeBinding,
          connection: value.session.connection,
          state: value.session.state,
        }),
      });
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const sameBinding = (left: McpSessionControllerBinding, right: McpSessionControllerBinding): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'artifact' && right.kind === 'artifact') {
    return left.binding.epochId === right.binding.epochId && left.binding.serverName === right.binding.serverName && left.binding.target === right.binding.target;
  }
  if (left.kind === 'runtime' && right.kind === 'runtime') {
    return sameRuntimeBinding(left.binding, right.binding);
  }
  return false;
};

const modelBindingFor = (binding: McpSessionControllerBinding): McpBrowserSessionBinding =>
  binding.kind === 'artifact' ? binding.binding : Object.freeze({ kind: 'runtime', binding: binding.binding });

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
  if (!isRecord(value) || !validSequence(value.afterSequence) || !validSequence(value.droppedThroughSequence) ||
    value.droppedThroughSequence >= Number.MAX_SAFE_INTEGER) {
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

const runtimeRouteOperationFor = (
  operation: McpSessionControllerOperation,
  request: Readonly<Record<string, unknown>>,
  requestId: string,
): McpRouteOperation => {
  if (operation === 'listTools') return { operation: 'tools/list' };
  if (operation === 'listResources') return { operation: 'resources/list' };
  if (operation === 'readResource' && typeof request.uri === 'string') return { operation: 'resources/read', uri: request.uri };
  if (operation === 'callTool' && typeof request.name === 'string' && (request.arguments === undefined || isRecord(request.arguments))) {
    return { arguments: request.arguments ?? {}, name: request.name, operation: 'tools/call', requestId };
  }
  throw new McpSessionControllerError(`MCP operation ${JSON.stringify(operation)} is not routed for runtime App access.`);
};

const appBindingOperationFor = (operation: McpRouteOperation): McpAppBindingOperation => {
  if (operation.operation === 'tools/list') return Object.freeze({ kind: 'tools/list' });
  if (operation.operation === 'resources/list') return Object.freeze({ kind: 'resources/list' });
  if (operation.operation === 'resources/read') return Object.freeze({ kind: 'resources/read', uri: operation.uri });
  if (operation.operation === 'tools/call') return Object.freeze({
    arguments: operation.arguments as McpAppJsonValue,
    kind: 'tools/call',
    name: operation.name,
  });
  throw new McpSessionControllerError(`MCP operation ${JSON.stringify(operation.operation)} is not routed for runtime App access.`);
};

const appAttachment = (value: McpSessionControllerAppAttachment): McpSessionControllerAppAttachment => {
  try {
    if (
      value === null || typeof value !== 'object' ||
      typeof value.bindingId !== 'string' || value.bindingId.length === 0 || value.bindingId.length > 4_096 || value.bindingId.includes('\0') ||
      typeof value.execute !== 'function' || (value.onResult !== undefined && typeof value.onResult !== 'function')
    ) throw new McpSessionControllerError('MCP App attachment requires one valid opaque binding authority and executor.');
    return Object.freeze({
      bindingId: value.bindingId,
      execute: value.execute,
      ...(value.onResult === undefined ? {} : { onResult: value.onResult }),
    });
  } catch (reason) {
    if (reason instanceof McpSessionControllerError) throw reason;
    throw new McpSessionControllerError('MCP App attachment requires one valid opaque binding authority and executor.');
  }
};

const sameAppAttachment = (left: McpSessionControllerAppAttachment, right: McpSessionControllerAppAttachment): boolean =>
  left.bindingId === right.bindingId && left.execute === right.execute;

const controllerOperationForRuntimeRoute = (operation: McpRouteOperation): McpSessionControllerOperation => {
  if (operation.operation === 'tools/list') return 'listTools';
  if (operation.operation === 'resources/list') return 'listResources';
  if (operation.operation === 'resources/read') return 'readResource';
  if (operation.operation === 'tools/call') return 'callTool';
  throw new McpSessionControllerError(`MCP operation ${JSON.stringify(operation.operation)} is not routed for runtime App access.`);
};

const controllerRequestForRuntimeRoute = (operation: McpRouteOperation): Readonly<Record<string, unknown>> => {
  if (operation.operation === 'resources/read') return Object.freeze({ uri: operation.uri });
  if (operation.operation === 'tools/call') return Object.freeze({ arguments: operation.arguments, name: operation.name });
  return Object.freeze({});
};

const runtimeRequestForRoute = (
  operation: McpRouteOperation,
  revision: number,
): DevRuntimeMcpOperationRequest => {
  if (operation.operation === 'tools/list') return Object.freeze({ expectedSessionRevision: revision, kind: 'list-tools' });
  if (operation.operation === 'resources/list') return Object.freeze({ expectedSessionRevision: revision, kind: 'list-resources' });
  if (operation.operation === 'resources/read') return Object.freeze({ expectedSessionRevision: revision, kind: 'read-resource', uri: operation.uri });
  if (operation.operation === 'tools/call') return Object.freeze({
    arguments: operation.arguments as JsonObject,
    expectedSessionRevision: revision,
    kind: 'call-tool',
    name: operation.name,
  });
  throw new McpSessionControllerError(`MCP operation ${JSON.stringify(operation.operation)} is not routed for runtime App access.`);
};

const diagnosticFor = (code: string, reason: unknown): McpBrowserSessionDiagnostic => ({
  code,
  message: reasonMessage(reason),
  severity: 'error',
});

const invocationError = (reason: unknown): unknown => reason instanceof Error
  ? { message: reason.message, name: reason.name }
  : reason;

const defaultClient = (): McpSessionControllerClient =>
  new Client({ name: 'agent-bundle-workbench', version: '0.0.0' }) as unknown as McpSessionControllerClient;

const defaultAppClient = (): Client => new Client({ name: 'agent-bundle-workbench', version: '0.0.0' });

const defaultTransport = (options: Readonly<{
  readonly binding: McpRouteSessionBinding;
  readonly routes: McpSessionControllerRoutes;
  readonly timeoutMs?: number;
}>): McpSessionControllerTransport => new AgentBundleRemoteTransport({
  binding: options.binding,
  routes: options.routes as McpRouteClient,
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
});

class RuntimeAttachedMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #connection: McpRouteConnection;
  readonly #execute: (operation: McpRouteOperation) => Promise<AgentBundleMcpDispatchResult>;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #sendTail: Promise<void> = Promise.resolve();
  #started = false;

  constructor(options: Readonly<{
    readonly connection: McpRouteConnection;
    readonly execute: (operation: McpRouteOperation) => Promise<AgentBundleMcpDispatchResult>;
  }>) {
    this.#connection = options.connection;
    this.#execute = options.execute;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new McpSessionControllerError('Attached runtime MCP transport is closed.');
    this.#started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.#started) await this.start();
    if (this.#closed) throw new McpSessionControllerError('Attached runtime MCP transport is closed.');
    const next = this.#sendTail.then(() => this.#dispatch(message));
    this.#sendTail = next.catch(() => undefined);
    return next;
  }

  async #dispatch(message: JSONRPCMessage): Promise<void> {
    const response = await dispatchAgentBundleMcpRequest(message, {
      allowedMethods: new Set(['tools/list', 'resources/list', 'tools/call', 'resources/read'] as const),
      connection: this.#connection,
      execute: this.#execute,
    });
    if (response === undefined || this.#closed) return;
    try {
      this.onmessage?.(response);
    } catch (reason) {
      this.#report(reason);
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#sendTail.then(() => {
      const callback = this.onclose;
      this.onclose = undefined;
      try {
        callback?.();
      } catch (reason) {
        this.#report(reason);
      }
    });
    return this.#closePromise;
  }

  #report(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try {
      this.onerror?.(error);
    } catch {
      // The SDK owns its error observer.
    }
  }
}

/** Browser-facing lifecycle owner for one epoch-bound MCP session. */
export class McpSessionController {
  readonly #appClientFactory: () => Client;
  readonly #clientFactory: () => McpSessionControllerClient;
  readonly #listeners = new Set<McpSessionControllerListener>();
  readonly #routes: McpSessionControllerRoutes;
  readonly #transportFactory: (options: Readonly<{
    readonly binding: McpRouteSessionBinding;
    readonly routes: McpSessionControllerRoutes;
    readonly timeoutMs?: number;
  }>) => McpSessionControllerTransport;
  #binding: McpSessionControllerBinding | undefined;
  #attachedApp: AttachedApp | undefined;
  #attachingApp: AttachedApp | undefined;
  #attachmentPromise: Promise<McpSessionControllerAppAccess> | undefined;
  #attachedRequestIndex = 0;
  #client: McpSessionControllerClient | undefined;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #cleanupCloseReentry: Promise<void> | undefined;
  #constructing = false;
  #constructionDrain: ConstructionDrain | undefined;
  #generation = 0;
  #model = createMcpBrowserSessionModel('mcp-session-controller');
  #requests = new Map<string, ActiveRequest>();
  #runtimeAdoption: RuntimeSessionAdoption | undefined;
  #traceRefresh: TraceRefresh | undefined;
  #session: McpRouteSession | undefined;
  #state: ControllerState = 'idle';
  #traceAbort: AbortController | undefined;
  #traceTask: Promise<void> | undefined;
  #transport: McpSessionControllerTransport | undefined;

  constructor(options: McpSessionControllerOptions) {
    this.#appClientFactory = options.appClientFactory ?? defaultAppClient;
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

  get session(): McpRouteSession | undefined {
    return this.#session;
  }

  subscribe(listener: McpSessionControllerListener): () => void {
    this.#listeners.add(listener);
    listener(this.#model);
    return () => this.#listeners.delete(listener);
  }

  async open(
    binding: McpSessionBinding | McpSessionControllerBinding | McpRouteSessionBinding,
    timeoutMs?: number,
  ): Promise<McpBrowserSessionModel> {
    const requested = controllerBinding(binding);
    if (requested === undefined) throw new McpSessionControllerError('MCP session binding must contain only epochId, target, and serverName.');
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new McpSessionControllerError('MCP session timeout must be a positive finite number.');
    }
    if (this.#state === 'closing') throw new McpSessionControllerError('MCP session controller is closing.');
    if (this.#state !== 'idle' || this.#constructing) throw new McpSessionControllerError('MCP session controller is already open.');
    if (requested.kind === 'runtime') {
      this.#state = 'opening';
      this.#generation += 1;
      this.#binding = requested;
      this.#model = createMcpBrowserSessionModel(requested.binding.sessionId);
      this.#publish({ binding: modelBindingFor(requested), type: 'open' });
      this.#publish({ connection: connectionFor(requested.session.connection), type: 'connection' });
      this.#publish({ catalogs: { prompts: [], resourceTemplates: [], resources: [], tools: [] }, type: 'catalogs' });
      this.#state = 'ready';
      this.#publish({ type: 'ready' });
      return this.#model;
    }
    let transport: McpSessionControllerTransport | undefined;
    let client: McpSessionControllerClient | undefined;
    let constructionFailed = false;
    let constructionReason: unknown;
    let generation: number;
    const drain = constructionDrain();
    this.#constructionDrain = drain;
    this.#constructing = true;
    try {
      transport = this.#transportFactory({
        binding: requested.binding,
        routes: this.#routes,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (this.#state === 'idle' && !this.#closing) client = this.#clientFactory();
    } catch (reason) {
      constructionFailed = true;
      constructionReason = reason;
    } finally {
      this.#constructing = false;
    }
    try {
      if (constructionFailed) throw await this.#failConstruction(client, transport, constructionReason);
      if (this.#state !== 'idle' || this.#closing || client === undefined || transport === undefined) throw await this.#failConstruction(
        client,
        transport,
        new McpSessionControllerError('MCP session controller was closed while opening'),
      );
      this.#state = 'opening';
      generation = ++this.#generation;
      this.#binding = requested;
      this.#transport = transport;
      this.#client = client;
    } finally {
      this.#finishConstruction(drain);
    }
    if (client === undefined || transport === undefined) {
      throw new McpSessionControllerError('MCP session construction did not produce a client and transport.');
    }
    return this.#connect(client, transport, requested, generation);
  }

  async #connect(
    client: McpSessionControllerClient,
    transport: McpSessionControllerTransport,
    requested: McpSessionControllerBinding,
    generation: number,
  ): Promise<McpBrowserSessionModel> {
    try {
      await client.connect(transport);
      if (!this.#current(generation)) return this.#model;
      const session = transport.session;
      if (!sameBinding({ binding: session.binding, kind: 'artifact' }, requested)) {
        throw new McpSessionControllerError('Foreground MCP session binding does not match the requested artifact.');
      }
      this.#session = session;
      this.#model = createMcpBrowserSessionModel(session.id);
      this.#publish({ binding: modelBindingFor(requested), type: 'open' });
      this.#watchTransport(transport, generation);
      await this.#refresh(session.connection, generation);
      return this.#model;
    } catch (reason) {
      if (this.#current(generation)) throw await this.#failSession(generation, client, transport, 'mcp.connect.failed', reason);
      throw reason;
    }
  }

  async restart(): Promise<McpBrowserSessionModel> {
    this.#assertReady('restart');
    const binding = this.#binding;
    if (binding?.kind === 'runtime') {
      const routes = this.#runtimeRoutes();
      const generation = ++this.#generation;
      this.#state = 'restarting';
      this.#publish({ type: 'restart' });
      try {
        const attachment = this.#attachedApp ?? this.#attachingApp;
        const failures = await this.#drainAttachedRuntimeWork(attachment);
        if (failures.length > 0) throw new McpSessionControllerCloseError(failures);
        if (!this.#runtimeCurrent(binding, generation)) return this.#model;
        const restarted = await routes.restartRuntime({ expectedSessionRevision: binding.binding.sessionRevision, sessionId: binding.binding.sessionId });
        const { reconcile: reconciled, session } = restarted;
        if (reconciled.action !== 'sessions-restarted' || !reconciled.restartedSessionIds.includes(binding.binding.sessionId)) {
          throw new McpSessionControllerError('Runtime MCP session restart did not produce a replacement session revision.');
        }
        if (
          !reconciled.invalidatedBindings.some((current) => current.sessionId === binding.binding.sessionId && current.sessionRevision === binding.binding.sessionRevision) ||
          session.state !== 'ready' || session.binding.sessionId !== binding.binding.sessionId ||
          session.binding.sessionRevision !== binding.binding.sessionRevision + 1 || session.binding.registryRevision !== reconciled.registryRevision
        ) throw new McpSessionControllerError('Runtime MCP session restart returned a snapshot that does not match its reconciliation evidence.');
        if (!this.#current(generation)) return this.#model;
        const nextBinding = Object.freeze({
          kind: 'runtime' as const,
          binding: session.binding,
          session,
        });
        this.#binding = nextBinding;
        this.#publish(
          { binding: modelBindingFor(nextBinding), type: 'binding' },
          { connection: connectionFor(session.connection), type: 'connection' },
        );
        this.#state = 'ready';
        this.#publish({ type: 'ready' });
        return this.#model;
      } catch (reason) {
        if (this.#current(generation)) throw await this.#failSession(generation, undefined, undefined, 'mcp.restart.failed', reason);
        throw reason;
      }
    }
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
      if (this.#current(generation)) throw await this.#failSession(generation, this.#client, this.#transport, 'mcp.restart.failed', reason);
      throw reason;
    }
  }

  adoptRuntimeSession(session: McpRouteRuntimeSession): Promise<McpBrowserSessionModel> {
    const next = runtimeControllerBinding(session);
    if (next === undefined || next.session.state !== 'ready') {
      return Promise.reject(new McpSessionControllerError('Runtime MCP session adoption requires a current ready runtime session snapshot.'));
    }
    const pending = this.#runtimeAdoption;
    if (pending !== undefined) {
      if (sameRuntimeBinding(pending.binding.binding, next.binding)) return pending.promise;
      return Promise.reject(new McpSessionControllerError('MCP runtime session adoption is already running for a different session authority.'));
    }
    try {
      this.#assertReady('restart');
    } catch (reason) {
      return Promise.reject(reason);
    }
    const previous = this.#binding;
    if (previous?.kind !== 'runtime' || previous.session.state !== 'ready') {
      return Promise.reject(new McpSessionControllerError('MCP session controller does not have a ready runtime session to adopt.'));
    }
    if (runtimeSessionAdoptionLane(previous.binding, next.binding) === undefined) {
      return Promise.reject(new McpSessionControllerError('Runtime MCP session adoption does not advance the current stable session authority.'));
    }

    const generation = ++this.#generation;
    this.#state = 'restarting';
    this.#publish({ type: 'restart' });
    const promise = (async (): Promise<McpBrowserSessionModel> => {
      try {
        const attachment = this.#attachedApp ?? this.#attachingApp;
        const failures = await this.#drainAttachedRuntimeWork(attachment);
        if (failures.length > 0) throw new McpSessionControllerCloseError(failures);
        if (!this.#runtimeCurrent(previous, generation)) return this.#model;
        this.#binding = next;
        this.#publish(
          { binding: modelBindingFor(next), type: 'binding' },
          { connection: connectionFor(next.session.connection), type: 'connection' },
        );
        this.#state = 'ready';
        this.#publish({ type: 'ready' });
        return this.#model;
      } catch (reason) {
        if (this.#runtimeCurrent(previous, generation)) {
          this.#state = 'ready';
          this.#publish({ type: 'ready' });
        }
        throw reason;
      }
    })();
    const adoption = { binding: next, promise };
    this.#runtimeAdoption = adoption;
    void promise.then(
      () => { if (this.#runtimeAdoption === adoption) this.#runtimeAdoption = undefined; },
      () => { if (this.#runtimeAdoption === adoption) this.#runtimeAdoption = undefined; },
    );
    return promise;
  }

  async invoke(input: McpSessionControllerRequest): Promise<unknown> {
    return this.#runInvocation(input);
  }

  async attachApp(input: McpSessionControllerAppAttachment): Promise<McpSessionControllerAppAccess> {
    const authority = appAttachment(input);
    this.#assertReady('invoke');
    const binding = this.#binding;
    if (binding?.kind !== 'runtime') throw new McpSessionControllerError('MCP App access requires a runtime session binding.');
    if (binding.session.state !== 'ready' || !sameRuntimeBinding(binding.binding, binding.session.binding)) {
      throw new McpSessionControllerError('MCP App access requires the current ready runtime session snapshot.');
    }
    const current = this.#attachedApp;
    if (current !== undefined) {
      if (!sameAppAttachment(current.authority, authority)) {
        throw new McpSessionControllerError('MCP App access is already attached to a different runtime App binding authority.');
      }
      return this.#appAccess(current, binding.binding);
    }
    if (this.#attachmentPromise !== undefined) {
      if (this.#attachingApp === undefined || !sameAppAttachment(this.#attachingApp.authority, authority)) {
        throw new McpSessionControllerError('MCP App attachment is already opening with a different runtime App binding authority.');
      }
      return this.#attachmentPromise;
    }
    if (this.#attachingApp !== undefined) {
      throw new McpSessionControllerError('MCP App attachment cleanup is incomplete.');
    }
    const client = this.#appClientFactory();
    const transport = new RuntimeAttachedMcpTransport({
      connection: binding.session.connection,
      execute: (operation) => this.#runRuntimeAppOperation(`app:${this.#nextAppRequestId()}`, authority, operation),
    });
    const attachment: AttachedApp = { authority, binding, client, transport };
    this.#attachingApp = attachment;
    const opening = this.#connectAttached(attachment, binding);
    this.#attachmentPromise = opening;
    try {
      return await opening;
    } finally {
      if (this.#attachmentPromise === opening) this.#attachmentPromise = undefined;
    }
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
    const originalBinding = original.binding === undefined ? undefined : controllerBinding(original.binding as McpSessionControllerBinding | McpRouteSessionBinding);
    if (binding === undefined || originalBinding === undefined || !sameBinding(originalBinding, binding)) {
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

  close(): Promise<void> {
    if (this.#cleanupCloseReentry !== undefined) return this.#cleanupCloseReentry;
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = 'closing';
    this.#closing = true;
    this.#generation += 1;
    const client = this.#client;
    const transport = this.#transport;
    const binding = this.#binding;
    const attached = this.#attachedApp ?? this.#attachingApp;
    const drain = this.#constructionDrain;
    const resources = drain === undefined
      ? this.#drainResources(client, transport, binding, attached)
      : drain.settled.then(() => this.#drainResources(client, transport, binding, attached));
    this.#closePromise = resources.then((failures) => {
      this.#clearResources(client, transport, attached, !this.#hasAttachmentCleanupFailure(failures));
      if (failures.length > 0) {
        this.#state = 'failed';
        const error = new McpSessionControllerCloseError(failures);
        this.#publishTerminalFailure('mcp.close.failed', error);
        throw error;
      }
      this.#state = 'closed';
      this.#publish({ type: 'close' }, { type: 'closed' });
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

  #runtimeCurrent(
    binding: Extract<McpSessionControllerBinding, { readonly kind: 'runtime' }>,
    generation: number,
  ): boolean {
    return this.#current(generation) && this.#binding === binding;
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
      const operationRouteFailure = isOperationRouteFailure(reason);
      onerror?.(reason);
      if (operationRouteFailure) return;
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
  ): Promise<McpSessionControllerFailureError> {
    if (!this.#current(generation)) return new McpSessionControllerFailureError(reason, []);
    this.#state = 'failed';
    this.#generation += 1;
    let rejectClose: (reason: unknown) => void = () => undefined;
    const closing = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
    this.#closePromise = closing;
    void closing.catch(() => undefined);
    const attached = this.#attachedApp ?? this.#attachingApp;
    const failures = await this.#drainResources(client, transport, this.#binding, attached);
    this.#clearResources(client, transport, attached, !this.#hasAttachmentCleanupFailure(failures));
    const error = new McpSessionControllerFailureError(reason, failures);
    this.#publishTerminalFailure(code, error);
    rejectClose(error);
    return error;
  }

  async #failConstruction(
    client: McpSessionControllerClient | undefined,
    transport: McpSessionControllerTransport | undefined,
    reason: unknown,
  ): Promise<McpSessionControllerFailureError> {
    const failures = await this.#settleCleanup([
      ...(client === undefined ? [] : [{ resource: 'client' as const, run: () => client.close() }]),
      ...(transport === undefined ? [] : [{ resource: 'transport' as const, run: () => transport.close() }]),
    ]);
    return new McpSessionControllerFailureError(reason, failures);
  }

  #finishConstruction(drain: ConstructionDrain): void {
    if (this.#constructionDrain === drain) this.#constructionDrain = undefined;
    drain.settle();
  }

  async #drainResources(
    client: McpSessionControllerClient | undefined,
    transport: McpSessionControllerTransport | undefined,
    binding: McpSessionControllerBinding | undefined,
    attached: AttachedApp | undefined,
  ): Promise<readonly McpSessionControllerCloseFailure[]> {
    this.#traceAbort?.abort();
    const appCloses = attached === undefined ? [] : [
      { resource: 'app-client' as const, run: () => this.#closeAttachedClient(attached) },
      { resource: 'app-transport' as const, run: () => this.#closeAttachedTransport(attached) },
    ];
    const active = [...this.#requests.entries()];
    const traceTask = this.#traceTask;
    for (const [, request] of active) request.abort.abort();
    const settled = await this.#settleCleanup([
      ...active.map(([id, request]) => ({ resource: `request:${id}` as const, run: () => request.settled })),
      ...(traceTask === undefined ? [] : [{ resource: 'trace' as const, run: () => traceTask }]),
    ]);
    const closed = await this.#settleCleanup([
      ...(client === undefined ? [] : [{ resource: 'client' as const, run: () => client.close() }]),
      ...(transport === undefined ? [] : [{ resource: 'transport' as const, run: () => transport.close() }]),
      ...appCloses,
    ]);
    const runtime = binding?.kind !== 'runtime' ? Object.freeze([]) : await this.#settleCleanup([
      {
        resource: 'runtime' as const,
        run: () => this.#runtimeRoutes().closeRuntime({
          expectedSessionRevision: binding.binding.sessionRevision,
          sessionId: binding.binding.sessionId,
        }),
      },
    ]);
    return Object.freeze([...settled, ...closed, ...runtime]);
  }

  async #settleCleanup(tasks: readonly CleanupTask[]): Promise<readonly McpSessionControllerCloseFailure[]> {
    const pending = tasks.map(({ run }) => {
      let work: unknown;
      this.#cleanupCloseReentry = Promise.resolve();
      try {
        work = run();
      } catch (reason) {
        return Promise.reject(reason);
      } finally {
        // Cleanup may synchronously reacquire its owner, but must not do so after yielding;
        // a delayed call is indistinguishable from an external close that must await cleanup.
        this.#cleanupCloseReentry = undefined;
      }
      return Promise.resolve(work);
    });
    const results = await Promise.allSettled(pending);
    return Object.freeze(results.flatMap((result, index) => result.status === 'rejected'
      ? [{ reason: result.reason, resource: tasks[index]!.resource }]
      : []));
  }

  #clearResources(
    client: McpSessionControllerClient | undefined,
    transport: McpSessionControllerTransport | undefined,
    attached: AttachedApp | undefined,
    releaseAttachment = true,
  ): void {
    if (this.#client === client) this.#client = undefined;
    if (this.#transport === transport) this.#transport = undefined;
    if (attached !== undefined && releaseAttachment) this.#releaseAttachment(attached);
    if (this.#client === undefined && this.#transport === undefined && this.#attachedApp === undefined && this.#attachingApp === undefined) {
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
    this.#replaceModel(next);
  }

  #publishTerminalFailure(code: string, reason: Error): void {
    const diagnostic = diagnosticFor(code, reason);
    if (this.#model.phase !== 'error') {
      this.#publish({ diagnostic, type: 'failed' });
      return;
    }
    if (this.#model.diagnostics.some((current) => (
      current.code === diagnostic.code && current.message === diagnostic.message && current.severity === diagnostic.severity
    ))) return;
    this.#replaceModel(Object.freeze({
      ...this.#model,
      diagnostics: Object.freeze([...this.#model.diagnostics, Object.freeze(diagnostic)]),
    }));
  }

  #replaceModel(next: McpBrowserSessionModel): void {
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

  #runtimeRoutes(): McpSessionControllerRuntimeRoutes {
    const routes = this.#routes;
    if (
      routes.openRuntime === undefined || routes.restartRuntime === undefined ||
      routes.closeRuntime === undefined || routes.executeRuntime === undefined
    ) throw new McpSessionControllerError('Runtime MCP routes are not available.');
    return routes as McpSessionControllerRuntimeRoutes;
  }

  #nextAppRequestId(): number {
    this.#attachedRequestIndex += 1;
    return this.#attachedRequestIndex;
  }

  #appAccess(attachment: AttachedApp, binding: DevRuntimeMcpAppRunBinding): McpSessionControllerAppAccess {
    return Object.freeze({
      client: attachment.client,
      close: () => this.#closeAttached(attachment),
      sessionId: binding.sessionId,
      sessionRevision: binding.sessionRevision,
    });
  }

  #closeAttachedClient(attachment: AttachedApp): Promise<void> {
    if (attachment.clientClosePromise === undefined) {
      const attempt = Promise.resolve().then(() => attachment.client.close());
      attachment.clientClosePromise = attempt;
      void attempt.catch(() => {
        if (attachment.clientClosePromise === attempt) attachment.clientClosePromise = undefined;
      });
    }
    return attachment.clientClosePromise;
  }

  #closeAttachedTransport(attachment: AttachedApp): Promise<void> {
    if (attachment.transportClosePromise === undefined) {
      const attempt = Promise.resolve().then(() => attachment.transport.close());
      attachment.transportClosePromise = attempt;
      void attempt.catch(() => {
        if (attachment.transportClosePromise === attempt) attachment.transportClosePromise = undefined;
      });
    }
    return attachment.transportClosePromise;
  }

  #closeAttached(attachment: AttachedApp): Promise<void> {
    if (attachment.closePromise === undefined) {
      const close = Promise.all([
        this.#closeAttachedClient(attachment),
        this.#closeAttachedTransport(attachment),
      ]).then(() => {
        this.#releaseAttachment(attachment);
      });
      attachment.closePromise = close;
      void close.catch(() => {
        if (attachment.closePromise === close) attachment.closePromise = undefined;
      });
    }
    return attachment.closePromise;
  }

  async #connectAttached(
    attachment: AttachedApp,
    binding: Extract<McpSessionControllerBinding, { readonly kind: 'runtime' }>,
  ): Promise<McpSessionControllerAppAccess> {
    const generation = this.#generation;
    try {
      await attachment.client.connect(attachment.transport);
      if (!this.#runtimeCurrent(binding, generation)) {
        await this.#closeAttached(attachment);
        throw new McpSessionControllerError('MCP runtime attachment is no longer current.');
      }
      this.#attachedApp = attachment;
      if (this.#attachingApp === attachment) this.#attachingApp = undefined;
      return this.#appAccess(attachment, binding.binding);
    } catch (reason) {
      try {
        await this.#closeAttached(attachment);
      } catch {
        // The primary connection result remains authoritative.
      }
      throw reason;
    }
  }

  #releaseAttachment(attachment: AttachedApp): void {
    if (this.#attachedApp === attachment) this.#attachedApp = undefined;
    if (this.#attachingApp === attachment) this.#attachingApp = undefined;
  }

  #hasAttachmentCleanupFailure(failures: readonly McpSessionControllerCloseFailure[]): boolean {
    return failures.some(({ resource }) => resource === 'app-client' || resource === 'app-transport');
  }

  async #drainAttachedRuntimeWork(attachment: AttachedApp | undefined): Promise<readonly McpSessionControllerCloseFailure[]> {
    const active = [...this.#requests.entries()];
    // Closing the runtime transport first prevents a stale request from emitting an error/result while it drains.
    const transportClose = attachment === undefined ? undefined : this.#closeAttachedTransport(attachment);
    const clientClose = attachment === undefined ? undefined : this.#closeAttachedClient(attachment);
    for (const [, request] of active) request.abort.abort();
    const settled = await this.#settleCleanup(active.map(([id, request]) => ({ resource: `request:${id}` as const, run: () => request.settled })));
    const closed = await this.#settleCleanup([
      ...(clientClose === undefined ? [] : [{ resource: 'app-client' as const, run: () => clientClose }]),
      ...(transportClose === undefined ? [] : [{ resource: 'app-transport' as const, run: () => transportClose }]),
    ]);
    if (attachment !== undefined && !this.#hasAttachmentCleanupFailure(closed)) this.#releaseAttachment(attachment);
    return Object.freeze([...closed, ...settled]);
  }

  async #runInvocation(input: McpSessionControllerRequest, replayOf?: string): Promise<unknown> {
    this.#assertReady('invoke');
    if (this.#binding?.kind === 'runtime') return this.#runRuntimeInvocation(input, replayOf);
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

  async #runRuntimeInvocation(input: McpSessionControllerRequest, replayOf?: string): Promise<unknown> {
    if (!isRecord(input.request) || typeof input.id !== 'string' || input.id.length === 0) {
      throw new McpSessionControllerError('MCP invocation requires a non-empty id and an object request.');
    }
    let operation: McpRouteOperation;
    try {
      operation = runtimeRouteOperationFor(input.operation, input.request, input.id);
    } catch (reason) {
      this.#publish({ diagnostic: diagnosticFor('mcp.operation.unsupported', reason), type: 'failed' });
      throw reason;
    }
    return (await this.#runRuntimeRouteOperation(input.id, operation, replayOf, input.signal)).value;
  }

  async #runRuntimeRouteOperation(
    id: string,
    operation: McpRouteOperation,
    replayOf?: string,
    signal?: AbortSignal,
  ): Promise<AgentBundleMcpDispatchResult> {
    this.#assertReady('invoke');
    const binding = this.#binding;
    if (binding?.kind !== 'runtime') throw new McpSessionControllerError('Runtime MCP operation requires a runtime session binding.');
    const generation = this.#generation;
    if (this.#requests.has(id)) throw new McpSessionControllerError(`MCP invocation ${JSON.stringify(id)} is already active.`);
    const active = activeRequest();
    const onAbort = () => active.abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    this.#requests.set(id, active);
    const controllerOperation = controllerOperationForRuntimeRoute(operation);
    this.#publish({
      request: {
        id,
        operation: controllerOperation,
        ...(replayOf === undefined ? {} : { replayOf }),
        request: controllerRequestForRuntimeRoute(operation),
        startedAt: Date.now(),
      },
      type: 'request.start',
    });
    try {
      const result = await this.#runtimeRoutes().executeRuntime(
        binding.binding.sessionId,
        runtimeRequestForRoute(operation, binding.binding.sessionRevision),
        active.abort.signal,
      );
      if (result.sessionId !== binding.binding.sessionId || result.sessionRevision !== binding.binding.sessionRevision) {
        throw new McpSessionControllerError('Runtime MCP operation response belongs to a stale session revision.');
      }
      if (!this.#runtimeCurrent(binding, generation)) {
        throw new McpSessionControllerError('Runtime MCP operation completed after its session binding changed.');
      }
      if (active.abort.signal.aborted) throw active.abort.signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (this.#runtimeCurrent(binding, generation)) {
        this.#publish({ completedAt: Date.now(), id, result: result.value, type: 'request.settled', vector: result.vector });
      }
      return Object.freeze({ value: result.value, vector: result.vector });
    } catch (reason) {
      if (this.#runtimeCurrent(binding, generation)) {
        this.#publish({ completedAt: Date.now(), error: invocationError(reason), id, type: 'request.settled' });
      }
      throw reason;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#requests.delete(id);
      active.settle();
    }
  }

  async #runRuntimeAppOperation(
    id: string,
    authority: McpSessionControllerAppAttachment,
    operation: McpRouteOperation,
  ): Promise<AgentBundleMcpDispatchResult> {
    this.#assertReady('invoke');
    const binding = this.#binding;
    if (binding?.kind !== 'runtime') throw new McpSessionControllerError('Runtime MCP operation requires a runtime session binding.');
    const generation = this.#generation;
    if (this.#requests.has(id)) throw new McpSessionControllerError(`MCP invocation ${JSON.stringify(id)} is already active.`);
    let appOperation: McpAppBindingOperation;
    try {
      appOperation = appBindingOperationFor(operation);
    } catch (reason) {
      this.#publish({ diagnostic: diagnosticFor('mcp.operation.unsupported', reason), type: 'failed' });
      throw reason;
    }
    const active = activeRequest();
    this.#requests.set(id, active);
    const controllerOperation = controllerOperationForRuntimeRoute(operation);
    this.#publish({
      request: {
        id,
        operation: controllerOperation,
        request: controllerRequestForRuntimeRoute(operation),
        startedAt: Date.now(),
      },
      type: 'request.start',
    });
    try {
      const result = await authority.execute(appOperation, active.abort.signal);
      if (
        result === null || typeof result !== 'object' ||
        result.sessionId !== binding.binding.sessionId || result.sessionRevision !== binding.binding.sessionRevision
      ) throw new McpSessionControllerError('Runtime MCP App operation response belongs to a stale session revision.');
      if (!this.#runtimeCurrent(binding, generation)) {
        throw new McpSessionControllerError('Runtime MCP App operation completed after its session binding changed.');
      }
      if (active.abort.signal.aborted) throw active.abort.signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (!this.#runtimeCurrent(binding, generation)) {
        throw new McpSessionControllerError('Runtime MCP App operation completed after its session binding changed.');
      }
      // The App operation vector is deliberately public-only. Retain the ordered request result
      // without coercing it into the model's private RuntimeVector contract.
      this.#publish({ completedAt: Date.now(), id, result: result.value, type: 'request.settled' });
      if (!this.#runtimeCurrent(binding, generation)) {
        throw new McpSessionControllerError('Runtime MCP App operation completed after its session binding changed.');
      }
      try {
        authority.onResult?.(appOperation, result);
      } catch {
        // Observability must not affect the sole controller-owned SDK transport.
      }
      return Object.freeze({ value: result.value });
    } catch (reason) {
      if (this.#runtimeCurrent(binding, generation)) {
        this.#publish({ completedAt: Date.now(), error: invocationError(reason), id, type: 'request.settled' });
      }
      throw reason;
    } finally {
      this.#requests.delete(id);
      active.settle();
    }
  }
}

export const createMcpSessionController = (options: McpSessionControllerOptions): McpSessionController =>
  new McpSessionController(options);
