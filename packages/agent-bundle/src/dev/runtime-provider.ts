import type { ArtifactStatus, JsonObject } from './types.ts';
import type {
  DevRuntimeAsset,
  DevRuntimeAssetRequest,
  DevRuntimeDescriptor,
  DevRuntimeInvocationRequest,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpOperationResult,
  DevRuntimeMcpRegistryReconcileInput,
  DevRuntimeMcpRegistryReconcileResult,
  DevRuntimeMcpRegistryReplayGap,
  DevRuntimeMcpRegistrySnapshot,
  DevRuntimeMcpSessionControlRequest,
  DevRuntimeMcpSessionRequest,
  DevRuntimeMcpSessionSnapshot,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from './runtime-protocol.ts';

/** Trusted-process-only compiler endpoint; never serialize it into runtime JSON. */
export interface DevRuntimeClientSurfaceEndpoint {
  readonly entryPath: string;
  readonly httpOrigin: string;
  readonly httpPathPrefixes: readonly string[];
  readonly surfaceId: string;
  readonly webSocketOrigin: string;
  /** Normalized public `dev.client.path` from the runtime compiler. */
  readonly webSocketPath: string;
  /** Rsbuild compiler credential; server-only and never serialized to a browser surface. */
  readonly webSocketToken: string;
}

/** Core-owned, server-only proxy handle; the host plan may embed only bootstrapUrl. */
export interface DevRuntimeClientSurfaceProxyBinding {
  readonly bootstrapUrl: string;
  readonly origin: string;
  readonly surfaceId: string;
  readonly webSocketPath: string;
  close(): Promise<void>;
}

/** Trusted normalized input from ProjectService; never serialize to the browser. */
export interface DevRuntimePreparedMcpServer {
  readonly args?: readonly string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly name: string;
  readonly source?: string;
  readonly targets: readonly string[];
  readonly transport: 'stdio' | 'streamable-http' | 'sse';
  readonly url?: string;
}

export interface DevRuntimePreparedMcpApp {
  readonly _meta?: JsonObject;
  readonly id: string;
  readonly name: string;
  readonly resourceUri: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly source: string;
  readonly targets: readonly string[];
  readonly template?: string;
}

export interface DevRuntimePreparedProject {
  readonly apps: readonly DevRuntimePreparedMcpApp[];
  readonly provider: string;
  readonly servers: readonly DevRuntimePreparedMcpServer[];
  readonly sourceRevision: string;
}

export interface DevRuntimeEventInput {
  readonly correlationId?: string;
  readonly details?: JsonObject;
  readonly mcpRegistryRevision?: number;
  readonly mcpSessionId?: string;
  readonly mcpSessionRevision?: number;
  readonly runId?: string;
  readonly runtimeGenerationId?: string;
  readonly type:
    | 'runtime.status'
    | 'runtime.generation.compiling'
    | 'runtime.generation.activated'
    | 'runtime.generation.failed'
    | 'runtime.run.started'
    | 'runtime.run.completed'
    | 'runtime.run.failed'
    | 'runtime.mcp.restarting'
    | 'runtime.mcp.ready'
    | 'runtime.mcp.failed'
    | 'runtime.app.updated'
    | 'runtime.hmr.client-connected'
    | 'runtime.hmr.client-disconnected';
}

export interface DevRuntimeStartContext {
  readonly artifactStatus: () => ArtifactStatus;
  readonly emit: (event: DevRuntimeEventInput) => void;
  readonly environment: Readonly<Record<string, string>>;
  readonly projectRoot: string;
  readonly preparedRuntime: DevRuntimePreparedProject;
  readonly providerSessionId: string;
  readonly signal: AbortSignal;
  readonly storageRoot: string;
}

export type DevRuntimeMcpRegistryMessage =
  | DevRuntimeMcpRegistryReconcileResult
  | DevRuntimeMcpRegistryReplayGap;

export type DevRuntimeMcpRegistryListener = (message: DevRuntimeMcpRegistryMessage) => void;

export interface DevRuntimeMcpRegistrySubscription {
  unsubscribe(): void;
}

export interface DevRuntimeMcpSessionCloseObservation {
  readonly closed: boolean;
  unsubscribe(): void;
}

export interface DevRuntimeMcpSessionExecuteOptions {
  readonly signal?: AbortSignal;
}

export interface DevRuntimeMcpSessionView {
  execute(request: DevRuntimeMcpOperationRequest, options?: DevRuntimeMcpSessionExecuteOptions): Promise<DevRuntimeMcpOperationResult>;
  snapshot(): DevRuntimeMcpSessionSnapshot;
  watchClosed(listener: (reason?: unknown) => Promise<void> | void): DevRuntimeMcpSessionCloseObservation;
}

export interface DevRuntimeMcpSession extends DevRuntimeMcpSessionView {
  close(): Promise<void>;
}

export interface DevRuntimeMcpRegistry {
  closeSession(request: DevRuntimeMcpSessionControlRequest): Promise<void>;
  close(): Promise<void>;
  open(request: DevRuntimeMcpSessionRequest): Promise<DevRuntimeMcpSession>;
  reconcile(input: DevRuntimeMcpRegistryReconcileInput): Promise<DevRuntimeMcpRegistryReconcileResult>;
  restart(request: DevRuntimeMcpSessionControlRequest): Promise<DevRuntimeMcpRegistryReconcileResult>;
  session(sessionId: string): DevRuntimeMcpSessionView | undefined;
  snapshot(): DevRuntimeMcpRegistrySnapshot | undefined;
  subscribe(
    options: Readonly<{ readonly afterSequence?: number }>,
    listener: DevRuntimeMcpRegistryListener,
  ): DevRuntimeMcpRegistrySubscription;
}

export interface DevRuntimeSession {
  readonly mcpRegistry: DevRuntimeMcpRegistry;
  /** Server-only controller identity; it does not depend on an active generation. */
  readonly providerSessionId: string;
  clientSurface(surfaceId: string): DevRuntimeClientSurfaceEndpoint | undefined;
  close(): Promise<void>;
  invoke(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun>;
  readAsset(request: DevRuntimeAssetRequest): Promise<DevRuntimeAsset | undefined>;
  readRunFlight(runId: string): Promise<DevRuntimeAsset | undefined>;
  reconcilePreparedRuntime(prepared: DevRuntimePreparedProject): Promise<void>;
  replay(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun>;
  resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity>;
  run(runId: string): DevRuntimeRun | undefined;
  runs(limit: number): readonly DevRuntimeRun[];
  status(): DevRuntimeStatus;
  surfaces(): readonly DevRuntimeSurface[];
}

export interface DevRuntimeProvider {
  readonly descriptor: DevRuntimeDescriptor;
  start(context: DevRuntimeStartContext): Promise<DevRuntimeSession>;
}

export type CreateDevRuntimeProvider = () => DevRuntimeProvider | Promise<DevRuntimeProvider>;

export class DevRuntimeUnavailableError extends Error {
  readonly code = 'AB8201' as const;

  constructor(message = 'Development runtime is not available.') {
    super(message);
    this.name = 'DevRuntimeUnavailableError';
  }
}

export class DevRuntimeGenerationConflictError extends Error {
  readonly actualGenerationId?: string;
  readonly code = 'AB8204' as const;
  readonly expectedGenerationId: string;

  constructor(expectedGenerationId: string, actualGenerationId?: string) {
    super(`Expected runtime generation ${JSON.stringify(expectedGenerationId)} is not active.`);
    this.name = 'DevRuntimeGenerationConflictError';
    this.expectedGenerationId = expectedGenerationId;
    this.actualGenerationId = actualGenerationId;
  }
}
