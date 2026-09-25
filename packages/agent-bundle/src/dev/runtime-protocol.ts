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
