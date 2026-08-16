import type { JsonObject, JsonValue } from './types.ts';

export interface RuntimeVector {
  readonly artifactEpochId?: string;
  readonly providerSessionId: string;
  readonly runtimeGenerationId: string;
  readonly sourceRevision: string;
  readonly stateStoreId: string;
  readonly stateVersion: number;
}

export interface DevRuntimeStateIdentity {
  readonly stateStoreId: string;
  readonly stateVersion: number;
}

export type DevRuntimeDiagnosticPhase =
  | 'source/build'
  | 'fixture-validation'
  | 'hook-wrapper'
  | 'rsc-render'
  | 'flight-decode'
  | 'lowering-contract'
  | 'mcp-protocol'
  | 'resource-selection'
  | 'sandbox/csp'
  | 'app-bridge'
  | 'provider-lifecycle';

export interface DevRuntimeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly phase: DevRuntimeDiagnosticPhase;
  readonly severity: 'error' | 'warning' | 'info';
}

export interface DevRuntimeDescriptor {
  readonly environmentVariables: readonly string[];
  readonly id: string;
  readonly label: string;
  readonly schemaVersion: 1;
}

export interface DevRuntimeFixture {
  readonly id: string;
  readonly label: string;
  readonly seed?: JsonValue;
}

export interface DevRuntimeSurface {
  readonly defaultTarget?: string;
  readonly fixtures: readonly DevRuntimeFixture[];
  readonly id: string;
  readonly inputSchema?: JsonObject;
  readonly kind: 'hook' | 'mcp-tool' | 'mcp-resource' | 'mcp-app';
  readonly label: string;
  readonly readOnly: boolean;
  readonly targets: readonly string[];
}

export interface DevRuntimeTreeNode {
  readonly children: readonly DevRuntimeTreeNode[];
  readonly id: string;
  readonly kind: 'component' | 'element' | 'text' | 'value';
  readonly label: string;
  readonly props?: JsonObject;
}

export interface DevRuntimeTraceSpan {
  readonly details?: JsonObject;
  readonly durationMs?: number;
  readonly id: string;
  readonly parentId?: string;
  readonly phase: string;
  readonly startedAt: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}

export interface DevRuntimeInspectionEnvelope {
  readonly agentVisible?: JsonValue;
  readonly app?: Readonly<{
    readonly mcpBinding: DevRuntimeMcpAppRunBinding;
    readonly resourceUri: string;
    /** Server-only client/HMR endpoint locator; it may differ from the invoked run surface. */
    readonly surfaceId: string;
  }>;
  readonly flight?: Readonly<{
    readonly bytes: number;
    readonly downloadPath?: string;
    readonly preview: string;
    readonly truncated: boolean;
  }>;
  readonly modelVisible?: JsonValue;
  readonly native?: JsonValue;
  readonly protocol?: JsonValue;
  readonly state: Readonly<{
    readonly identity: DevRuntimeStateIdentity;
    readonly snapshot?: JsonValue;
  }>;
  readonly trace: readonly DevRuntimeTraceSpan[];
  readonly tree: readonly DevRuntimeTreeNode[];
}

interface DevRuntimeRunBase {
  readonly completedAt?: string;
  readonly fixtureId?: string;
  readonly id: string;
  readonly input: JsonValue;
  readonly startedAt: string;
  readonly surfaceId: string;
  readonly target: string;
  readonly vector: RuntimeVector;
}

export type DevRuntimeRun =
  | (DevRuntimeRunBase & Readonly<{
      readonly diagnostics?: never;
      readonly result?: never;
      readonly status: 'running';
    }>)
  | (DevRuntimeRunBase & Readonly<{
      readonly completedAt: string;
      readonly diagnostics?: never;
      readonly result: DevRuntimeInspectionEnvelope;
      readonly status: 'succeeded';
    }>)
  | (DevRuntimeRunBase & Readonly<{
      readonly completedAt: string;
      readonly diagnostics: readonly DevRuntimeDiagnostic[];
      readonly result?: never;
      readonly status: 'failed';
    }>);

export type DevRuntimeStatus = Readonly<{
  readonly activeVector?: RuntimeVector;
  readonly descriptor: DevRuntimeDescriptor;
  readonly diagnostics: readonly DevRuntimeDiagnostic[];
  /** The compiler endpoint can accept an HMR client; not proof that a browser is connected. */
  readonly hmrReady: boolean;
  readonly lastGoodVector?: RuntimeVector;
  readonly state: 'starting' | 'compiling' | 'active' | 'degraded' | 'failed' | 'closed';
}>;

export interface DevRuntimeInvocationRequest {
  readonly expectedGenerationId?: string;
  readonly fixtureId?: string;
  readonly input: JsonValue;
  readonly surfaceId: string;
  readonly target: string;
}

export interface DevRuntimeReplayRequest {
  readonly expectedGenerationId?: string;
  readonly mode: 'exact' | 'latest';
  readonly runId: string;
}

export interface DevRuntimeStateResetRequest {
  readonly expectedGenerationId?: string;
  readonly seed?: JsonValue;
  readonly stateStoreId: string;
}

export interface DevRuntimeAssetRequest {
  readonly path: readonly string[];
  readonly runtimeGenerationId: string;
  readonly surfaceId: string;
}

export interface DevRuntimeAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/** Server-only compiler endpoint. It is never returned by status/surfaces JSON. */
export interface DevRuntimeMcpSessionRequest {
  readonly expectedRegistryRevision?: number;
  readonly serverName: string;
  readonly target: string;
}

export interface DevRuntimeMcpSessionControlRequest {
  readonly expectedSessionRevision: number;
  readonly sessionId: string;
}

export interface DevRuntimeMcpSessionBinding {
  readonly definitionDigest: string;
  readonly providerSessionId: string;
  readonly registryRevision: number;
  readonly serverDigest: string;
  readonly serverName: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly stateStoreId: string;
  readonly target: string;
  readonly transportDigest: string;
}

export type DevRuntimeMcpAppRunBinding = Omit<
  DevRuntimeMcpSessionBinding,
  'providerSessionId' | 'stateStoreId'
>;

export interface DevRuntimeMcpServerDescriptor {
  readonly definitionDigest: string;
  readonly name: string;
  readonly resources: readonly JsonObject[];
  readonly serverDigest: string;
  readonly target: string;
  readonly tools: readonly JsonObject[];
  readonly transportDigest: string;
}

export interface DevRuntimeMcpRegistrySnapshot {
  readonly definitionDigest: string;
  readonly providerSessionId: string;
  readonly registryRevision: number;
  readonly runtimeGenerationId: string;
  readonly servers: readonly DevRuntimeMcpServerDescriptor[];
  readonly transportDigest: string;
}

export interface DevRuntimeMcpConnectionState {
  readonly capabilities: JsonObject | undefined;
  readonly protocolEra: 'legacy' | 'modern' | undefined;
  readonly protocolVersion: string | undefined;
  readonly server: Readonly<{ readonly name: string; readonly version: string }> | undefined;
}

interface DevRuntimeMcpOperationBase {
  readonly expectedSessionRevision: number;
}

export type DevRuntimeMcpOperationRequest = DevRuntimeMcpOperationBase & (
  | Readonly<{ readonly kind: 'list-tools' }>
  | Readonly<{
      readonly arguments: JsonObject;
      readonly kind: 'call-tool';
      readonly name: string;
      readonly requestId?: string;
    }>
  | Readonly<{ readonly kind: 'list-resources' }>
  | Readonly<{ readonly kind: 'read-resource'; readonly uri: string }>
);

export interface DevRuntimeMcpOperationResult {
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly value: JsonValue;
  readonly vector: RuntimeVector;
}

export interface DevRuntimeMcpSessionSnapshot {
  readonly binding: DevRuntimeMcpSessionBinding;
  readonly connection: DevRuntimeMcpConnectionState;
  readonly state: 'connecting' | 'ready' | 'restarting' | 'failed' | 'closed';
}

export interface DevRuntimeMcpRegistryReconcileInput {
  readonly definitionDigest: string;
  readonly runtimeGenerationId: string;
  readonly servers: readonly DevRuntimeMcpServerDescriptor[];
  readonly transportDigest: string;
}

export interface DevRuntimeMcpInvalidatedBinding {
  readonly sessionId: string;
  readonly sessionRevision: number;
}

export interface DevRuntimeMcpRegistryReconcileResult {
  readonly action: 'implementation-updated' | 'sessions-restarted' | 'restart-failed';
  readonly invalidatedBindings: readonly DevRuntimeMcpInvalidatedBinding[];
  readonly registryRevision: number;
  readonly restartedSessionIds: readonly string[];
  readonly runtimeGenerationId: string;
  readonly sequence: number;
}

export interface DevRuntimeMcpRegistryReplayGap {
  readonly earliestAvailableSequence: number;
  readonly latestDroppedSequence: number;
  readonly requestedAfterSequence: number;
  readonly type: 'replay.gap';
}

export interface DevRuntimeStatusResponse {
  readonly status: DevRuntimeStatus | null;
}

export interface DevRuntimeSurfacesResponse {
  readonly surfaces: readonly DevRuntimeSurface[];
}

export interface DevRuntimeRunResponse {
  readonly run: DevRuntimeRun;
}

export interface DevRuntimeRunsResponse {
  readonly providerSessionId: string;
  readonly runs: readonly DevRuntimeRun[];
}

export interface DevRuntimeStateResponse {
  readonly state: DevRuntimeStateIdentity;
}
