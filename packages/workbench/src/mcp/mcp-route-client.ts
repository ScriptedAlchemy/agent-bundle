import type {
  DevRuntimeMcpAppRunBinding,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpOperationResult,
  DevRuntimeMcpRegistryReconcileResult,
  DevRuntimeMcpSessionControlRequest,
  DevRuntimeMcpSessionRequest,
  RuntimeVector,
} from '../../../agent-bundle/src/contracts/runtime.ts';
import type { JsonObject } from '../../../agent-bundle/src/contracts/runtime.ts';
import { isMcpSessionTarget, type McpSessionTarget } from '../../../agent-bundle/src/contracts/mcp-session.ts';
import { exactKeys, isLoopbackHttpUrl, isRecord } from '../client-helpers.ts';
import { hasOnlyOwnKeys } from '../strict-json.ts';

export type McpRouteTarget = McpSessionTarget;

export interface McpRouteSessionBinding {
  readonly epochId: string;
  readonly serverName: string;
  readonly target: McpRouteTarget;
}

export interface McpRouteConnection {
  readonly capabilities?: unknown;
  readonly protocolEra?: 'legacy' | 'modern';
  readonly protocolVersion?: string;
  readonly server?: Readonly<{ readonly name: string; readonly version: string }>;
}

export interface McpRouteSession {
  readonly binding: McpRouteSessionBinding;
  readonly connection: McpRouteConnection;
  readonly id: string;
  readonly timeoutMs: number;
}

/** Browser-safe projection of a runtime session. Provider and state-store IDs remain server-owned. */
export interface McpRouteRuntimeSession {
  readonly binding: DevRuntimeMcpAppRunBinding;
  readonly connection: McpRouteConnection;
  readonly state: 'connecting' | 'ready' | 'restarting' | 'failed' | 'closed';
}

/** The stable identity fields a runtime binding is compared by. */
export type McpRuntimeBindingIdentity = Pick<
  DevRuntimeMcpAppRunBinding,
  | 'definitionDigest'
  | 'registryRevision'
  | 'serverDigest'
  | 'serverName'
  | 'sessionId'
  | 'sessionRevision'
  | 'target'
  | 'transportDigest'
>;

export const sameRuntimeBinding = (left: McpRuntimeBindingIdentity, right: McpRuntimeBindingIdentity): boolean =>
  left.definitionDigest === right.definitionDigest && left.registryRevision === right.registryRevision &&
  left.serverDigest === right.serverDigest && left.serverName === right.serverName && left.sessionId === right.sessionId &&
  left.sessionRevision === right.sessionRevision && left.target === right.target && left.transportDigest === right.transportDigest;

export interface McpRouteRuntimeRestart {
  readonly reconcile: DevRuntimeMcpRegistryReconcileResult;
  readonly session: McpRouteRuntimeSession;
}

export type McpInspectorRouteState = 'exited' | 'idle' | 'running' | 'starting';

/** The dev server's view of the standalone MCP Inspector process; `url` is present only while running. */
export interface McpInspectorRouteStatus {
  readonly state: McpInspectorRouteState;
  readonly url?: string;
}

export interface McpRouteCatalog {
  readonly prompts: readonly unknown[];
  readonly resourceTemplates: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly tools: readonly unknown[];
}

export interface McpRouteTrace {
  readonly entries: readonly unknown[];
  readonly overflow?: unknown;
}

export type McpRouteOperation =
  | Readonly<{ readonly operation: 'initialize' | 'prompts/list' | 'resources/list' | 'resources/templates/list' | 'tools/list' }>
  | Readonly<{ readonly arguments?: Readonly<Record<string, string>>; readonly name: string; readonly operation: 'prompts/get' }>
  | Readonly<{ readonly operation: 'resources/read'; readonly uri: string }>
  | Readonly<{
    readonly arguments: Readonly<Record<string, unknown>>;
    /** The Workbench correlation id; the route stamps it into `params._meta` itself and refuses a browser-sent `_meta` (`AB8016`). */
    readonly correlationId?: string;
    readonly name: string;
    readonly operation: 'tools/call';
    readonly requestId?: string;
    /** A task-augmented call (#369): the `params.task` the server receives; answered by a `CreateTaskResult`. */
    readonly task?: Readonly<{ readonly pollInterval?: number; readonly ttl?: number }>;
  }>
  | Readonly<{ readonly operation: 'tasks/cancel' | 'tasks/get' | 'tasks/result'; readonly taskId: string }>
  | Readonly<{ readonly cursor?: string; readonly operation: 'tasks/list' }>;

export interface ForegroundRouteClientOptions {
  readonly fetch?: typeof fetch;
}

/** Closed authority shared by every foreground browser route client. */
export interface ForegroundRequestAuthority {
  protectedRequest(path: string, init?: RequestInit, beforeDispatch?: () => void): Promise<Response>;
}

export interface McpRouteClientOptions extends ForegroundRouteClientOptions {
  /** Reuses Workbench's memory-only foreground authentication authority. */
  readonly foreground?: ForegroundRouteClient;
}

export interface ForegroundSessionSnapshot {
  readonly cookieName: string;
  readonly generation: number;
  readonly instanceId: string;
  readonly origin: string;
  readonly token: string;
}

export interface ForegroundSessionChange {
  readonly next: ForegroundSessionSnapshot;
  readonly previous: ForegroundSessionSnapshot;
}

export interface ForegroundSessionRefreshOptions {
  readonly beforeAdopt?: (change: ForegroundSessionChange) => Promise<void>;
}

interface ForegroundAuthentication {
  readonly generation: number;
  readonly promise: Promise<ForegroundSessionSnapshot>;
  readonly request: number;
}

interface Diagnostic {
  readonly code: string;
  readonly details?: unknown;
  readonly message: string;
  readonly phase?: string;
}

const isTarget = isMcpSessionTarget;

const detachedJson = (value: unknown, ancestors = new WeakSet<object>()): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new McpRouteClientError('AB8016', 'Foreground MCP data must contain finite JSON numbers.');
  }
  if (typeof value !== 'object') throw new McpRouteClientError('AB8016', 'Foreground MCP data must contain only JSON values.');
  if (ancestors.has(value)) throw new McpRouteClientError('AB8016', 'Foreground MCP data must not be cyclic.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => detachedJson(entry, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new McpRouteClientError('AB8016', 'Foreground MCP data must use ordinary JSON objects.');
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        configurable: false,
        enumerable: true,
        value: detachedJson(entry, ancestors),
        writable: false,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
};

const asRecord = (value: unknown, code = 'AB8019'): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new McpRouteClientError(code, 'Foreground MCP route returned an invalid response.');
  return detachedJson(value) as Readonly<Record<string, unknown>>;
};

const asArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid response.');
  return detachedJson(value) as readonly unknown[];
};

const hasOnlyKeys: (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => boolean = hasOnlyOwnKeys;

const hasExactKeys: (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => boolean = exactKeys;

const diagnostic = (value: unknown, status: number): Diagnostic => {
  if (isRecord(value) && isRecord(value.diagnostic) && typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return Object.freeze({
      code: value.diagnostic.code,
      ...(value.diagnostic.details === undefined ? {} : { details: detachedJson(value.diagnostic.details) }),
      message: value.diagnostic.message,
      ...(typeof value.diagnostic.phase === 'string' ? { phase: value.diagnostic.phase } : {}),
    });
  }
  return Object.freeze({ code: 'AB8019', message: `Foreground MCP request failed with HTTP ${status}.` });
};

const routeConnection = (value: unknown): McpRouteConnection => {
  const connection = asRecord(value);
  const server = connection.server;
  let serverSnapshot: Readonly<{ readonly name: string; readonly version: string }> | undefined;
  if (server !== undefined) {
    if (!isRecord(server) || !hasExactKeys(server, ['name', 'version']) || typeof server.name !== 'string' || typeof server.version !== 'string') {
      throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid connection.');
    }
    serverSnapshot = Object.freeze({ name: server.name, version: server.version });
  }
  if (
    !hasOnlyKeys(connection, ['capabilities', 'protocolEra', 'protocolVersion', 'server']) ||
    (connection.protocolEra !== undefined && connection.protocolEra !== 'legacy' && connection.protocolEra !== 'modern') ||
    (connection.protocolVersion !== undefined && typeof connection.protocolVersion !== 'string')
  ) {
    throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid connection.');
  }
  return Object.freeze({
    ...(connection.capabilities === undefined ? {} : { capabilities: connection.capabilities }),
    ...(connection.protocolEra === undefined ? {} : { protocolEra: connection.protocolEra }),
    ...(connection.protocolVersion === undefined ? {} : { protocolVersion: connection.protocolVersion }),
    ...(serverSnapshot === undefined ? {} : { server: serverSnapshot }),
  });
};

const routeSession = (value: unknown): McpRouteSession => {
  const response = asRecord(value);
  const session = asRecord(response.session);
  const binding = asRecord(session.binding);
  if (
    typeof session.id !== 'string' || session.id.length === 0 ||
    typeof binding.epochId !== 'string' || typeof binding.serverName !== 'string' || !isTarget(binding.target) ||
    typeof session.timeoutMs !== 'number' || !Number.isFinite(session.timeoutMs) || session.timeoutMs <= 0
  ) {
    throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid session.');
  }
  return Object.freeze({
    binding: Object.freeze({ epochId: binding.epochId, serverName: binding.serverName, target: binding.target }),
    connection: routeConnection(session.connection),
    id: session.id,
    timeoutMs: session.timeoutMs,
  });
};

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const foregroundAbortError = (): Error => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

/** Waits for an operation without allowing one caller's signal to cancel shared work. */
export const awaitWithAbort = <Value>(
  signal: AbortSignal | null | undefined,
  operation: () => Promise<Value>,
): Promise<Value> => {
  if (signal === undefined || signal === null) return operation();
  if (signal.aborted) return Promise.reject(foregroundAbortError());
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => reject(foregroundAbortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void operation().then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
};

const runtimeVector = (value: unknown): RuntimeVector => {
  const vector = asRecord(value);
  if (
    !nonempty(vector.providerSessionId) || !nonempty(vector.runtimeGenerationId) || !nonempty(vector.sourceRevision) ||
    !nonempty(vector.stateStoreId) || !nonnegative(vector.stateVersion) ||
    (vector.artifactEpochId !== undefined && !nonempty(vector.artifactEpochId))
  ) throw new McpRouteClientError('AB8019', 'Runtime MCP route returned an invalid operation vector.');
  return Object.freeze({
    ...(vector.artifactEpochId === undefined ? {} : { artifactEpochId: vector.artifactEpochId }),
    providerSessionId: vector.providerSessionId,
    runtimeGenerationId: vector.runtimeGenerationId,
    sourceRevision: vector.sourceRevision,
    stateStoreId: vector.stateStoreId,
    stateVersion: vector.stateVersion,
  });
};

const runtimeSession = (value: unknown): McpRouteRuntimeSession => {
  const session = asRecord(value);
  const binding = asRecord(session.binding);
  if (
    Object.keys(session).length !== 3 || Object.keys(binding).length !== 8 ||
    Object.hasOwn(binding, 'providerSessionId') || Object.hasOwn(binding, 'stateStoreId') ||
    !nonempty(binding.definitionDigest) || !positive(binding.registryRevision) ||
    !nonempty(binding.serverDigest) || !nonempty(binding.serverName) || !nonempty(binding.sessionId) ||
    !positive(binding.sessionRevision) || !nonempty(binding.target) ||
    !nonempty(binding.transportDigest) ||
    !['connecting', 'ready', 'restarting', 'failed', 'closed'].includes(session.state as string)
  ) throw new McpRouteClientError('AB8019', 'Runtime MCP route returned an invalid session.');
  return Object.freeze({
    binding: Object.freeze({
      definitionDigest: binding.definitionDigest,
      registryRevision: binding.registryRevision,
      serverDigest: binding.serverDigest,
      serverName: binding.serverName,
      sessionId: binding.sessionId,
      sessionRevision: binding.sessionRevision,
      target: binding.target,
      transportDigest: binding.transportDigest,
    }),
    connection: routeConnection(session.connection),
    state: session.state as McpRouteRuntimeSession['state'],
  });
};

const runtimeReconcile = (value: unknown): DevRuntimeMcpRegistryReconcileResult => {
  const reconcile = asRecord(value);
  if (
    !hasExactKeys(reconcile, ['action', 'invalidatedBindings', 'registryRevision', 'restartedSessionIds', 'runtimeGenerationId', 'sequence']) ||
    !['implementation-updated', 'sessions-restarted', 'restart-failed'].includes(reconcile.action as string) ||
    !positive(reconcile.registryRevision) || !nonempty(reconcile.runtimeGenerationId) || !positive(reconcile.sequence) ||
    !Array.isArray(reconcile.invalidatedBindings) || !Array.isArray(reconcile.restartedSessionIds) ||
    !reconcile.invalidatedBindings.every((binding) => {
      const current = isRecord(binding) ? binding : undefined;
      return current !== undefined && hasExactKeys(current, ['sessionId', 'sessionRevision']) && nonempty(current.sessionId) && positive(current.sessionRevision);
    }) || !reconcile.restartedSessionIds.every(nonempty)
  ) throw new McpRouteClientError('AB8019', 'Runtime MCP route returned an invalid reconcile result.');
  return Object.freeze({
    action: reconcile.action as DevRuntimeMcpRegistryReconcileResult['action'],
    invalidatedBindings: Object.freeze(reconcile.invalidatedBindings.map((binding) => {
      const current = binding as Readonly<Record<string, unknown>>;
      return Object.freeze({ sessionId: current.sessionId as string, sessionRevision: current.sessionRevision as number });
    })),
    registryRevision: reconcile.registryRevision,
    restartedSessionIds: Object.freeze([...reconcile.restartedSessionIds] as string[]),
    runtimeGenerationId: reconcile.runtimeGenerationId,
    sequence: reconcile.sequence,
  });
};

const runtimeRestart = (value: unknown, request: DevRuntimeMcpSessionControlRequest): McpRouteRuntimeRestart => {
  const response = asRecord(value);
  if (Object.keys(response).length !== 2) throw new McpRouteClientError('AB8019', 'Runtime MCP route returned an invalid restart response.');
  const reconcile = runtimeReconcile(response.reconcile);
  const session = runtimeSession(response.session);
  if (
    reconcile.action !== 'sessions-restarted' || !reconcile.restartedSessionIds.includes(request.sessionId) ||
    !reconcile.invalidatedBindings.some((binding) => binding.sessionId === request.sessionId && binding.sessionRevision === request.expectedSessionRevision) ||
    session.state !== 'ready' || session.binding.sessionId !== request.sessionId ||
    session.binding.sessionRevision !== request.expectedSessionRevision + 1 || session.binding.registryRevision !== reconcile.registryRevision
  ) throw new McpRouteClientError('AB8019', 'Runtime MCP route returned a restart snapshot that does not match its reconciliation evidence.');
  return Object.freeze({ reconcile, session });
};

const runtimeOperation = (value: unknown): DevRuntimeMcpOperationResult => {
  const result = asRecord(value);
  if (!nonempty(result.operationId) || !nonempty(result.sessionId) || !positive(result.sessionRevision) || result.value === undefined) {
    throw new McpRouteClientError('AB8019', 'Runtime MCP route returned an invalid operation result.');
  }
  return Object.freeze({
    operationId: result.operationId,
    sessionId: result.sessionId,
    sessionRevision: result.sessionRevision,
    value: detachedJson(result.value) as DevRuntimeMcpOperationResult['value'],
    vector: runtimeVector(result.vector),
  });
};

const runtimeOpenRequest = (request: DevRuntimeMcpSessionRequest): DevRuntimeMcpSessionRequest => {
  if (!nonempty(request.serverName) || !nonempty(request.target) || (request.expectedRegistryRevision !== undefined && !positive(request.expectedRegistryRevision))) {
    throw new McpRouteClientError('AB8015', 'Runtime MCP session request is not valid.');
  }
  return Object.freeze({
    ...(request.expectedRegistryRevision === undefined ? {} : { expectedRegistryRevision: request.expectedRegistryRevision }),
    serverName: request.serverName,
    target: request.target,
  });
};

const runtimeControlRequest = (request: DevRuntimeMcpSessionControlRequest): DevRuntimeMcpSessionControlRequest => {
  if (!nonempty(request.sessionId) || !positive(request.expectedSessionRevision)) {
    throw new McpRouteClientError('AB8015', 'Runtime MCP session control request is not valid.');
  }
  return Object.freeze({ expectedSessionRevision: request.expectedSessionRevision, sessionId: request.sessionId });
};

const runtimeOperationRequest = (request: DevRuntimeMcpOperationRequest): DevRuntimeMcpOperationRequest => {
  if (!positive(request.expectedSessionRevision)) throw new McpRouteClientError('AB8015', 'Runtime MCP operation request is not valid.');
  if (request.kind === 'list-tools' || request.kind === 'list-resources') return Object.freeze({ expectedSessionRevision: request.expectedSessionRevision, kind: request.kind });
  if (request.kind === 'read-resource' && nonempty(request.uri)) {
    return Object.freeze({ expectedSessionRevision: request.expectedSessionRevision, kind: 'read-resource', uri: request.uri });
  }
  if (request.kind === 'call-tool' && nonempty(request.name)) {
    const argumentsSnapshot = detachedJson(request.arguments);
    if (!isRecord(argumentsSnapshot)) throw new McpRouteClientError('AB8015', 'Runtime MCP operation request is not valid.');
    return Object.freeze({
      arguments: argumentsSnapshot as JsonObject,
      expectedSessionRevision: request.expectedSessionRevision,
      kind: 'call-tool',
      name: request.name,
    });
  }
  throw new McpRouteClientError('AB8015', 'Runtime MCP operation request is not valid.');
};

const inspectorRouteStates: readonly McpInspectorRouteState[] = Object.freeze(['exited', 'idle', 'running', 'starting']);

const isInspectorRouteState = (value: unknown): value is McpInspectorRouteState =>
  (inspectorRouteStates as readonly unknown[]).includes(value);

const inspectorRouteStatus = (value: unknown): McpInspectorRouteStatus => {
  const invalid = (): McpRouteClientError => new McpRouteClientError('AB8019', 'Inspector status route returned an invalid response.');
  const response = isRecord(value) ? asRecord(value) : undefined;
  if (response === undefined || !hasExactKeys(response, ['status']) || !isRecord(response.status)) throw invalid();
  const status = response.status;
  if (
    !hasOnlyKeys(status, ['state', 'url']) || !isInspectorRouteState(status.state) ||
    (status.url !== undefined && !isLoopbackHttpUrl(status.url))
  ) throw invalid();
  return Object.freeze({ state: status.state, ...(status.url === undefined ? {} : { url: status.url }) });
};

const inspectorRouteLaunch = (value: unknown): Readonly<{ readonly url: string }> => {
  const response = isRecord(value) ? asRecord(value) : undefined;
  if (response === undefined || !hasExactKeys(response, ['url']) || !isLoopbackHttpUrl(response.url)) {
    throw new McpRouteClientError('AB8019', 'Inspector launch route returned an invalid response.');
  }
  return Object.freeze({ url: response.url });
};

const encode = (value: string): string => encodeURIComponent(value);

const foregroundRoute = (path: string): string => {
  const origin = 'http://foreground.invalid';
  let parsed: URL;
  try {
    parsed = new URL(path, origin);
  } catch {
    throw new ForegroundRouteClientError('AB8015', 'Foreground route is not valid.', 400);
  }
  if (!path.startsWith('/') || path.startsWith('//') || parsed.origin !== origin || parsed.username.length > 0 || parsed.password.length > 0 ||
    parsed.hash.length > 0 || `${parsed.pathname}${parsed.search}` !== path) {
    throw new ForegroundRouteClientError('AB8015', 'Foreground route is not valid.', 400);
  }
  return path;
};

/** A serialized origin: `new URL(value).origin === value`, so no path, trailing slash, credentials, or bare host. */
const isSerializedOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

/**
 * Contributor dev-server origins the foreground server allowlisted for the Workbench HMR loop (#572).
 * The bootstrap body carries the key only while that loopback-only allowlist is non-empty, so an empty
 * list is as invalid as a non-list.
 */
const isDevOriginList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isSerializedOrigin);

/** Memory-only authentication shared by foreground browser route clients. */
export class ForegroundRouteClient implements ForegroundRequestAuthority {
  readonly #fetch: typeof fetch;
  #authentication: ForegroundAuthentication | undefined;
  #authenticationGeneration = 0;
  #latestStartedBootstrapRequest = 0;
  #snapshot: ForegroundSessionSnapshot | undefined;

  constructor(options: ForegroundRouteClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async publicJson(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.#json(await this.#fetch(foregroundRoute(path), init));
  }

  async protectedJson(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.#json(await this.protectedResponse(path, init));
  }

  /** Establishes the same-origin cookie/session bootstrap before EventSource opens. */
  async ensureSession(): Promise<void> {
    const authentication = this.#authenticate();
    await authentication.promise;
    if (!this.#isAuthenticationCurrent(authentication)) {
      throw new ForegroundRouteClientError('AB8019', 'Foreground authentication was invalidated.', 401);
    }
  }

  /** Returns the current immutable foreground identity and credential snapshot. */
  async sessionSnapshot(): Promise<ForegroundSessionSnapshot> {
    const authentication = this.#authenticate();
    const session = await authentication.promise;
    if (!this.#isAuthenticationCurrent(authentication)) {
      throw new ForegroundRouteClientError('AB8019', 'Foreground authentication was invalidated.', 401);
    }
    return session;
  }

  /** Revalidates foreground identity, superseding every older in-flight bootstrap. */
  async refreshSession(options: ForegroundSessionRefreshOptions = {}): Promise<ForegroundSessionSnapshot> {
    const request = ++this.#latestStartedBootstrapRequest;
    return this.#bootstrap(request, this.#authenticationGeneration, options, true);
  }

  /** Returns the authenticated foreground origin without exposing the session token. */
  async sessionOrigin(): Promise<string> {
    const authentication = this.#authenticate();
    const session = await authentication.promise;
    if (!this.#isAuthenticationCurrent(authentication)) {
      throw new ForegroundRouteClientError('AB8019', 'Foreground authentication was invalidated.', 401);
    }
    return session.origin;
  }

  async protectedRequest(path: string, init: RequestInit = {}, beforeDispatch?: () => void): Promise<Response> {
    const route = foregroundRoute(path);
    const authentication = this.#authenticate();
    const signal = init.signal ?? undefined;
    const session = await awaitWithAbort(signal, () => authentication.promise);
    if (signal?.aborted) throw foregroundAbortError();
    if (!this.#isAuthenticationCurrent(authentication)) {
      throw new ForegroundRouteClientError('AB8019', 'Foreground authentication was invalidated.', 401);
    }
    beforeDispatch?.();
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', session.token);
    const response = await this.#fetch(route, { ...init, headers });
    if (!this.#isResponseAuthorityCurrent(authentication, session)) {
      throw new ForegroundRouteClientError('AB8019', 'Foreground authentication was invalidated.', 401);
    }
    return response;
  }

  async protectedResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.protectedRequest(path, init);
    if (!response.ok) throw ForegroundRouteClientError.fromResponse(await response.clone().json().catch(() => undefined), response.status);
    return response;
  }

  /** Erases the short-lived foreground token once its owning transport closes. */
  forgetAuthentication(): void {
    this.#authentication = undefined;
    this.#snapshot = undefined;
    this.#authenticationGeneration += 1;
    this.#latestStartedBootstrapRequest += 1;
  }

  async #json(response: Response): Promise<unknown> {
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw ForegroundRouteClientError.fromResponse(body, response.status);
    try {
      return detachedJson(body);
    } catch (error) {
      if (error instanceof McpRouteClientError) throw new ForegroundRouteClientError(error.code, error.message, response.status);
      throw error;
    }
  }

  #authenticate(): ForegroundAuthentication {
    if (this.#authentication !== undefined) return this.#authentication;
    return this.#startAuthentication();
  }

  #startAuthentication(): ForegroundAuthentication {
    const request = ++this.#latestStartedBootstrapRequest;
    const authentication = Object.freeze({
      generation: this.#authenticationGeneration,
      promise: this.#bootstrap(request, this.#authenticationGeneration, {}, false),
      request,
    });
    this.#authentication = authentication;
    void authentication.promise.catch(() => {
      if (!this.#isAuthenticationCurrent(authentication)) return;
      this.#authentication = this.#snapshot === undefined
        ? undefined
        : Object.freeze({
            generation: this.#authenticationGeneration,
            promise: Promise.resolve(this.#snapshot),
            request: this.#latestStartedBootstrapRequest,
          });
    });
    return authentication;
  }

  #isAuthenticationCurrent(authentication: ForegroundAuthentication): boolean {
    return this.#authentication === authentication && this.#authenticationGeneration === authentication.generation;
  }

  #isResponseAuthorityCurrent(
    authentication: ForegroundAuthentication,
    session: ForegroundSessionSnapshot,
  ): boolean {
    return this.#authenticationGeneration === authentication.generation &&
      this.#snapshot?.generation === session.generation &&
      this.#snapshot.instanceId === session.instanceId;
  }

  async #bootstrap(
    request: number,
    authenticationGeneration: number,
    options: ForegroundSessionRefreshOptions,
    replaceAuthentication: boolean,
  ): Promise<ForegroundSessionSnapshot> {
    try {
      const response = await this.#fetch('/api/project/session', { credentials: 'same-origin' });
      if (this.#bootstrapSuperseded(request, authenticationGeneration)) return this.#supersededSnapshot();
      const body: unknown = await response.json().catch(() => undefined);
      if (this.#bootstrapSuperseded(request, authenticationGeneration)) return this.#supersededSnapshot();
      if (!response.ok) throw ForegroundRouteClientError.fromResponse(body, response.status);
      if (
        !isRecord(body) ||
        (!hasExactKeys(body, ['cookieName', 'instanceId', 'origin', 'token']) &&
          !hasExactKeys(body, ['cookieName', 'devOrigins', 'instanceId', 'origin', 'token'])) ||
        typeof body.cookieName !== 'string' || !/^agent-bundle-foreground-session-[a-f0-9]{32}$/u.test(body.cookieName) ||
        typeof body.instanceId !== 'string' || body.instanceId.length === 0 || body.instanceId.length > 128 ||
        body.instanceId.trim() !== body.instanceId || typeof body.origin !== 'string' ||
        typeof body.token !== 'string' || body.token.length === 0
      ) {
        throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid response.', response.status);
      }
      const devOrigins = Object.hasOwn(body, 'devOrigins') ? body.devOrigins : undefined;
      if (devOrigins !== undefined && !isDevOriginList(devOrigins)) {
        throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid response.', response.status);
      }
      let origin: URL;
      try {
        origin = new URL(body.origin);
      } catch {
        throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid origin.', response.status);
      }
      if (origin.origin !== body.origin) throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap returned an invalid origin.', response.status);
      const browserOrigin = globalThis.location?.origin;
      if (
        browserOrigin !== undefined && browserOrigin !== 'null' && browserOrigin !== body.origin &&
        devOrigins?.includes(browserOrigin) !== true
      ) {
        throw new ForegroundRouteClientError(
          'AB8003',
          `Origin ${browserOrigin} is not allowed by the foreground server at ${body.origin}. Open ${body.origin} instead, or start agent-bundle dev with --workbench-dev-origin ${browserOrigin} to allow this origin.`,
          response.status,
        );
      }
      const previous = this.#snapshot;
      const generation = previous === undefined
        ? 0
        : previous.instanceId === body.instanceId
          ? previous.generation
          : previous.generation + 1;
      const snapshot = Object.freeze({
        cookieName: body.cookieName,
        generation,
        instanceId: body.instanceId,
        origin: body.origin,
        token: body.token,
      });
      if (previous !== undefined && previous.instanceId !== snapshot.instanceId && options.beforeAdopt !== undefined) {
        await options.beforeAdopt(Object.freeze({ next: snapshot, previous }));
        if (this.#bootstrapSuperseded(request, authenticationGeneration)) return this.#supersededSnapshot();
      }
      this.#snapshot = snapshot;
      if (replaceAuthentication) {
        this.#authentication = Object.freeze({
          generation: authenticationGeneration,
          promise: Promise.resolve(snapshot),
          request,
        });
      }
      return snapshot;
    } catch (error) {
      if (this.#bootstrapSuperseded(request, authenticationGeneration) && this.#snapshot !== undefined) return this.#snapshot;
      throw error;
    }
  }

  #bootstrapSuperseded(request: number, authenticationGeneration: number): boolean {
    return request !== this.#latestStartedBootstrapRequest || authenticationGeneration !== this.#authenticationGeneration;
  }

  #supersededSnapshot(): ForegroundSessionSnapshot {
    if (this.#snapshot !== undefined) return this.#snapshot;
    throw new ForegroundRouteClientError('AB8019', 'Foreground session bootstrap was superseded.', 401);
  }
}

export class ForegroundRouteClientError extends Error {
  readonly code: string;
  readonly details: unknown | undefined;
  readonly phase: string | undefined;
  /**
   * HTTP status of the failed foreground response (`fromResponse`); `undefined`
   * when the client constructed the failure itself — a refused 200 body, a
   * superseded or invalidated session — and `status` is only nominal.
   */
  readonly responseStatus: number | undefined;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status: number,
    options: Readonly<{ readonly details?: unknown; readonly phase?: string; readonly responseStatus?: number }> = {},
  ) {
    super(message);
    this.name = 'ForegroundRouteClientError';
    this.code = code;
    this.details = options.details;
    this.phase = options.phase;
    this.responseStatus = options.responseStatus;
    this.status = status;
  }

  static fromResponse(body: unknown, status: number): ForegroundRouteClientError {
    const detail = diagnostic(body, status);
    return new ForegroundRouteClientError(detail.code, detail.message, status, {
      details: detail.details,
      phase: detail.phase,
      responseStatus: status,
    });
  }
}

/** A typed, credential-memory-only browser client for the foreground MCP routes. */
export class McpRouteClient {
  readonly #foreground: ForegroundRouteClient;

  constructor(options: McpRouteClientOptions = {}) {
    this.#foreground = options.foreground ?? new ForegroundRouteClient({ fetch: options.fetch });
  }

  async create(binding: McpRouteSessionBinding, timeoutMs?: number): Promise<McpRouteSession> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new McpRouteClientError('AB8016', 'MCP session timeout must be a positive finite number.');
    }
    return routeSession(await this.#json('/api/mcp/sessions', {
      body: JSON.stringify({ ...binding, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  async session(id: string): Promise<McpRouteSession> {
    return routeSession(await this.#json(this.#sessionPath(id)));
  }

  async connection(id: string): Promise<McpRouteConnection> {
    return routeConnection(asRecord(await this.#json(`${this.#sessionPath(id)}/connection`)).connection);
  }

  async catalog(id: string): Promise<McpRouteCatalog> {
    const response = asRecord(await this.#json(`${this.#sessionPath(id)}/catalog`));
    return Object.freeze({
      prompts: asArray(response.prompts),
      resourceTemplates: asArray(response.resourceTemplates),
      resources: asArray(response.resources),
      tools: asArray(response.tools),
    });
  }

  async config(id: string): Promise<unknown> {
    return asRecord(await this.#json(`${this.#sessionPath(id)}/config`)).config;
  }

  async operation(id: string, operation: McpRouteOperation, signal?: AbortSignal): Promise<unknown> {
    return asRecord(await this.#json(`${this.#sessionPath(id)}/operations`, {
      body: JSON.stringify(operation),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    })).result;
  }

  async trace(id: string, after = 0): Promise<McpRouteTrace> {
    const trace = asRecord(asRecord(await this.#json(`${this.#sessionPath(id)}/trace?after=${this.#cursor(after)}`)).trace);
    return Object.freeze({
      entries: asArray(trace.entries),
      ...(trace.overflow === undefined ? {} : { overflow: trace.overflow }),
    });
  }

  async stream(id: string, after: number, signal?: AbortSignal): Promise<Response> {
    return this.#request(`${this.#sessionPath(id)}/stream?after=${this.#cursor(after)}`, { signal });
  }

  async restart(id: string): Promise<McpRouteConnection> {
    const response = asRecord(await this.#json(`${this.#sessionPath(id)}/restart`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    return routeConnection(response.connection);
  }

  async cancel(id: string, requestId: string, signal?: AbortSignal): Promise<boolean> {
    const response = asRecord(await this.#json(`${this.#sessionPath(id)}/cancel`, {
      body: JSON.stringify({ requestId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
    if (typeof response.cancelled !== 'boolean') throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid cancellation response.');
    return response.cancelled;
  }

  async close(id: string): Promise<boolean> {
    const response = asRecord(await this.#json(this.#sessionPath(id), { method: 'DELETE' }));
    if (typeof response.closed !== 'boolean') throw new McpRouteClientError('AB8019', 'Foreground MCP route returned an invalid close response.');
    return response.closed;
  }

  async openRuntime(request: DevRuntimeMcpSessionRequest): Promise<McpRouteRuntimeSession> {
    const input = runtimeOpenRequest(request);
    return runtimeSession(asRecord(await this.#json('/api/runtime/mcp/sessions', {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })).session);
  }

  async restartRuntime(request: DevRuntimeMcpSessionControlRequest): Promise<McpRouteRuntimeRestart> {
    const input = runtimeControlRequest(request);
    return runtimeRestart(asRecord(await this.#json(`${this.#runtimeSessionPath(input.sessionId)}/restart`, {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })), input);
  }

  async closeRuntime(request: DevRuntimeMcpSessionControlRequest): Promise<void> {
    const input = runtimeControlRequest(request);
    const response = asRecord(await this.#json(this.#runtimeSessionPath(input.sessionId), {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'DELETE',
    }));
    if (response.closed !== true) throw new McpRouteClientError('AB8019', 'Runtime MCP route returned an invalid close response.');
  }

  async executeRuntime(sessionId: string, request: DevRuntimeMcpOperationRequest, signal?: AbortSignal): Promise<DevRuntimeMcpOperationResult> {
    const path = this.#runtimeSessionPath(sessionId);
    const input = runtimeOperationRequest(request);
    const result = runtimeOperation(asRecord(await this.#json(`${path}/rpc`, {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    })).result);
    if (result.sessionId !== sessionId || result.sessionRevision !== input.expectedSessionRevision) {
      throw new McpRouteClientError('AB8204', 'Runtime MCP operation response does not match the requested session revision.');
    }
    return result;
  }

  async inspectorStatus(): Promise<McpInspectorRouteStatus> {
    return inspectorRouteStatus(await this.#json('/api/inspector/status'));
  }

  /** Idempotent while the Inspector is starting or running; the server owns the command it spawns. */
  async inspectorLaunch(): Promise<Readonly<{ readonly url: string }>> {
    return inspectorRouteLaunch(await this.#json('/api/inspector/launch', {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  forgetAuthentication(): void {
    this.#foreground.forgetAuthentication();
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    try {
      return await this.#foreground.protectedJson(path, init);
    } catch (error) {
      throw this.#mcpError(error);
    }
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.#foreground.protectedResponse(path, init);
    } catch (error) {
      throw this.#mcpError(error);
    }
  }

  #mcpError(error: unknown): McpRouteClientError | unknown {
    if (error instanceof McpRouteClientError) return error;
    if (error instanceof ForegroundRouteClientError) return new McpRouteClientError(error.code, error.message);
    return error;
  }

  #cursor(value: number): string {
    if (!Number.isSafeInteger(value) || value < 0) throw new McpRouteClientError('AB8017', 'MCP session trace cursor is not valid.');
    return String(value);
  }

  #sessionPath(id: string): string {
    if (id.length === 0) throw new McpRouteClientError('AB8015', 'MCP session is not available.');
    return `/api/mcp/sessions/${encode(id)}`;
  }

  #runtimeSessionPath(id: string): string {
    if (!nonempty(id) || id.includes('\0') || id.includes('/') || id.includes('\\')) {
      throw new McpRouteClientError('AB8015', 'Runtime MCP session is not available.');
    }
    return `/api/runtime/mcp/sessions/${encode(id)}`;
  }
}

export class McpRouteClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpRouteClientError';
    this.code = code;
  }
}
