import type { ArtifactStatus, JsonObject } from './types.ts';
import type {
  DevRuntimeAsset,
  DevRuntimeAssetRequest,
  DevRuntimeDescriptor,
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from './runtime-protocol.ts';

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
  readonly runId?: string;
  readonly runtimeGenerationId?: string;
  readonly type:
    | 'runtime.status'
    | 'runtime.generation.compiling'
    | 'runtime.generation.activated'
    | 'runtime.generation.failed'
    | 'runtime.run.started'
    | 'runtime.run.completed'
    | 'runtime.run.failed';
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

export interface DevRuntimeSession {
  /** Server-only controller identity; it does not depend on an active generation. */
  readonly providerSessionId: string;
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

const errorCode = (error: unknown): unknown =>
  error instanceof Error ? (error as { readonly code?: unknown }).code : undefined;

/**
 * Whether `error` is the provider's "runtime unavailable" signal. A provider
 * module imports these classes from the published `agent-bundle/api` (#485),
 * which may be a different installation of the package than the one serving
 * the Workbench, so the documented AB8201 response cannot hinge on
 * constructor identity: the class's `name` and `code` are the contract.
 */
export const isDevRuntimeUnavailableError = (error: unknown): error is DevRuntimeUnavailableError =>
  error instanceof DevRuntimeUnavailableError
  || (error instanceof Error && error.name === 'DevRuntimeUnavailableError' && errorCode(error) === 'AB8201');

/** Whether `error` is the provider's generation-conflict signal; see {@link isDevRuntimeUnavailableError}. */
export const isDevRuntimeGenerationConflictError = (error: unknown): error is DevRuntimeGenerationConflictError =>
  error instanceof DevRuntimeGenerationConflictError
  || (
    error instanceof Error
    && error.name === 'DevRuntimeGenerationConflictError'
    && errorCode(error) === 'AB8204'
    && typeof (error as { readonly expectedGenerationId?: unknown }).expectedGenerationId === 'string'
  );
