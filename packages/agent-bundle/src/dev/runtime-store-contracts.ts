import type {
  DevRuntimeEventInput,
  DevRuntimeMcpRegistry,
} from './runtime-provider.ts';
import type {
  DevRuntimeMcpConnectionState,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpRegistryReconcileInput,
  DevRuntimeMcpRegistryReconcileResult,
  DevRuntimeMcpServerDescriptor,
} from './runtime-protocol.ts';
import type { JsonValue } from './types.ts';

/**
 * The generation store and MCP registry contracts a `dev.runtime.provider`
 * drives, spelled without their implementations (#485). The classes in
 * `runtime-generation-store.ts` and `runtime-mcp-registry.ts` implement these
 * interfaces and throw `YieldableFrameworkError`s, which reach `effect`; a
 * public `.d.ts` graph must not (`docs/effect-conventions.md`, boundary
 * modules), so `agent-bundle/api` exports this module and the factories in
 * `runtime-store-factories.ts`, never the classes.
 */

export interface RuntimeGenerationAsset {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimeGenerationMetadataCodec<TMetadata> {
  decode(value: JsonValue): TMetadata;
  encode(value: TMetadata): JsonValue;
}

export interface RuntimeGenerationManifestInput<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
}

export interface RuntimeGenerationManifest<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly createdAt: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly metadata: TMetadata;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationValidationInput<TMetadata> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
  readonly root: string;
}

export type RuntimeGenerationValidator<TMetadata> = (
  input: RuntimeGenerationValidationInput<TMetadata>,
) => Promise<TMetadata> | TMetadata;

export interface RuntimeGenerationActivationGuard<TMetadata> {
  wait(manifest: RuntimeGenerationManifest<TMetadata>): Promise<void>;
  check(manifest: RuntimeGenerationManifest<TMetadata>): boolean;
}

export interface RuntimeGenerationPrepareOptions<TMetadata> {
  readonly guard?: RuntimeGenerationActivationGuard<TMetadata>;
}

export interface RuntimeGenerationCandidate {
  readonly id: string;
  readonly root: string;
  readonly sequence: number;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationPreparedActivation<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  readonly sequence: number;
}

export interface RuntimeGeneration<TMetadata = unknown> {
  readonly id: string;
  readonly manifest: RuntimeGenerationManifest<TMetadata>;
  readonly root: string;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationLease<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  release(): Promise<void>;
}

export interface RuntimeGenerationStoreOptions<TMetadata> {
  readonly metadataCodec: RuntimeGenerationMetadataCodec<TMetadata>;
  readonly now?: () => Date;
  /** Test seam for cleanup failures; production callers use recursive `rm`. */
  readonly remove?: (path: string) => Promise<void>;
  readonly retainInactive?: number;
  readonly storageRoot: string;
  readonly validateMetadata: RuntimeGenerationValidator<TMetadata>;
}

export interface RuntimeGenerationCloseFailure {
  readonly error: unknown;
  readonly path: string;
}

/** The `code` of an error the generation store throws (`name: 'RuntimeGenerationStoreError'`). */
export type RuntimeGenerationStoreErrorCode =
  | 'RUNTIME_GENERATION_CLOSED'
  | 'RUNTIME_GENERATION_CONFLICT'
  | 'RUNTIME_GENERATION_INVALID'
  | 'RUNTIME_GENERATION_NOT_FOUND'
  | 'RUNTIME_GENERATION_SUPERSEDED';

/**
 * The durable, epoch-pinned generation store a provider session drives:
 * stage a candidate, prepare and commit (or abort) its activation, lease the
 * active generation for a run, and close. Created with
 * `createRuntimeGenerationStore` from `agent-bundle/api`.
 */
export interface DevRuntimeGenerationStore<TMetadata = unknown> {
  abort(prepared: RuntimeGenerationPreparedActivation<TMetadata>): Promise<void>;
  active(): RuntimeGeneration<TMetadata> | undefined;
  begin(input: Readonly<{ readonly id: string; readonly sourceRevision: string }>): Promise<RuntimeGenerationCandidate>;
  canCommit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): boolean;
  close(): Promise<void>;
  commit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): RuntimeGeneration<TMetadata>;
  fail(candidate: RuntimeGenerationCandidate): Promise<void>;
  lease(id?: string): Promise<RuntimeGenerationLease<TMetadata>>;
  prepare(
    candidate: RuntimeGenerationCandidate,
    input: RuntimeGenerationManifestInput<TMetadata>,
    options?: RuntimeGenerationPrepareOptions<TMetadata>,
  ): Promise<RuntimeGenerationPreparedActivation<TMetadata>>;
}

export interface RuntimeMcpConnection {
  readonly state: DevRuntimeMcpConnectionState;
  close(): Promise<void>;
  relist(): Promise<DevRuntimeMcpConnectionState>;
}

export interface RuntimeMcpConnector {
  connect(input: Readonly<{
    readonly descriptor: DevRuntimeMcpServerDescriptor;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }>): Promise<RuntimeMcpConnection>;
}

export interface RuntimeMcpExecutionContext {
  readonly descriptor: DevRuntimeMcpServerDescriptor;
  readonly generation: RuntimeGeneration;
  readonly request: DevRuntimeMcpOperationRequest;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export interface RuntimeMcpExecutionValue {
  readonly stateVersion: number;
  readonly value: JsonValue;
}

export interface RuntimeMcpRegistryOptions {
  readonly artifactEpochId: () => string | undefined;
  readonly connector: RuntimeMcpConnector;
  readonly createOperationId?: () => string;
  readonly createSessionId?: () => string;
  readonly emit: (event: DevRuntimeEventInput) => void;
  readonly executor: (context: RuntimeMcpExecutionContext) => Promise<RuntimeMcpExecutionValue>;
  readonly generationStore: DevRuntimeGenerationStore;
  readonly initialRegistry?: DevRuntimeMcpRegistryReconcileInput;
  readonly providerSessionId: string;
  readonly stateStoreId: string;
}

export interface RuntimeMcpPreparedActivationReconcile {
  readonly input: DevRuntimeMcpRegistryReconcileInput;
  readonly reservationRevision: number;
}

export interface RuntimeMcpCommittedActivationReconcile {
  readonly result: DevRuntimeMcpRegistryReconcileResult;
  finalize(): Promise<void>;
  publish(): void;
}

export interface RuntimeMcpRegistryCloseFailure {
  readonly error: unknown;
  readonly resource: string;
}

/** The `code` of an error the MCP registry throws (`name: 'RuntimeMcpRegistryError'`). */
export type RuntimeMcpRegistryErrorCode =
  | 'RUNTIME_MCP_REGISTRY_CLOSED'
  | 'RUNTIME_MCP_REGISTRY_CONFLICT'
  | 'RUNTIME_MCP_REGISTRY_INVALID'
  | 'RUNTIME_MCP_REGISTRY_NOT_FOUND';

/**
 * The MCP registry as the provider that owns it sees it: the session-facing
 * {@link DevRuntimeMcpRegistry} plus the activation reconcile the provider
 * drives while it activates a generation. Created with
 * `createRuntimeMcpRegistry` from `agent-bundle/api`.
 */
export interface DevRuntimeProviderMcpRegistry extends DevRuntimeMcpRegistry {
  abortActivationReconcile(prepared: RuntimeMcpPreparedActivationReconcile): Promise<void>;
  commitActivationReconcile(prepared: RuntimeMcpPreparedActivationReconcile): RuntimeMcpCommittedActivationReconcile;
  prepareActivationReconcile(input: DevRuntimeMcpRegistryReconcileInput): Promise<RuntimeMcpPreparedActivationReconcile>;
}
