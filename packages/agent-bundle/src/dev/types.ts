import type { Diagnostic } from '../core/diagnostics.ts';
import type { ProjectContext } from '../core/project-context.ts';
import type { ArtifactManifestProjectionDocuments } from '../build/manifest.ts';
import type { ApplicationExplorer } from './artifacts/application-explorer.ts';
import type { RouteInvocationEventPayload } from './routes/route-invocation.ts';

export type JsonPrimitive = boolean | null | number | string;
export type JsonArray = readonly JsonValue[];
export type JsonObject = Readonly<{ readonly [key: string]: JsonValue }>;
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export interface DiagnosticSummary {
  readonly errors: number;
  readonly infos: number;
  readonly warnings: number;
}

/** A fully emitted and validated immutable artifact publication. */
export interface ArtifactEpoch {
  readonly configDigest: string;
  readonly createdAt: string;
  readonly diagnostics: DiagnosticSummary;
  readonly id: string;
  readonly manifestPath: string;
  readonly modelDigest: string;
  /** The npm package name axis of the published project, when packaged. */
  readonly packageName?: string;
  /** The semantic release-version axis of the published project, when packaged. */
  readonly packageVersion?: string;
  readonly projectRevision: string;
  readonly targetDigests: Readonly<Record<string, string>>;
}

/** A source input referenced directly by an emitted artifact file. */
export interface ArtifactInspectionSourceInput {
  readonly path: string;
  readonly sha256: string;
}

/** Manifested artifact file facts, without the file contents. */
export interface ArtifactInspectionFile {
  readonly bytes: number;
  readonly kind: 'bundle' | 'copy' | 'generated' | 'prebuilt';
  readonly mode?: number;
  readonly path: string;
  readonly sha256: string;
  readonly sourceInputs: readonly ArtifactInspectionSourceInput[];
}

export interface ArtifactInspectionFileNode {
  readonly file: ArtifactInspectionFile;
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
}

export interface ArtifactInspectionDirectoryNode {
  readonly children: readonly ArtifactInspectionTreeNode[];
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
}

/** One immutable tree node within a declared artifact projection. */
export type ArtifactInspectionTreeNode = ArtifactInspectionDirectoryNode | ArtifactInspectionFileNode;

/** One selected host projection and the composite-root tree it reads. */
export interface ArtifactInspectionProjection {
  readonly documents: ArtifactManifestProjectionDocuments;
  readonly host: string;
  readonly marketplace?: string;
  readonly tree: ArtifactInspectionDirectoryNode;
}

/** Direct declared provenance for one emitted output path. */
export interface ArtifactInspectionProvenance {
  readonly outputPath: string;
  readonly sourceInputs: readonly ArtifactInspectionSourceInput[];
}

export interface ArtifactInspectionHook {
  readonly event: string;
  readonly file: ArtifactInspectionFile;
  readonly id: string;
  readonly kind: 'config' | 'event-route';
  readonly name: string;
  readonly path: string;
  readonly target: string;
  readonly timeout?: number;
}

export interface ArtifactInspectionMcpApp {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly resourceUri: string;
}

/** Non-secret runtime facts for one strict modern MCP server declaration. */
export interface ArtifactInspectionMcpServer {
  readonly apps: readonly ArtifactInspectionMcpApp[];
  readonly entryPaths: readonly string[];
  readonly kind: 'command' | 'compiled' | 'prebuilt' | 'remote';
  readonly manifestPath: string;
  readonly name: string;
  readonly target: string;
  readonly transport: string;
}

export interface ArtifactInspectionScript {
  readonly file: ArtifactInspectionFile;
  readonly id: string;
  readonly mode: 'bundle' | 'copy';
  readonly name: string;
  readonly rendered?: string;
  readonly target: string;
  readonly worker?: ArtifactInspectionFile;
}

export interface ArtifactInspectionBin {
  readonly file: ArtifactInspectionFile;
  readonly hosts: readonly string[];
  readonly name: string;
  readonly worker?: ArtifactInspectionFile;
}

export interface ArtifactInspectionRuntime {
  readonly bins: readonly ArtifactInspectionBin[];
  readonly executables: readonly ArtifactInspectionFile[];
  readonly hooks: readonly ArtifactInspectionHook[];
  readonly mcpServers: readonly ArtifactInspectionMcpServer[];
  readonly scripts: readonly ArtifactInspectionScript[];
}

/** Detached facts from one strictly validated, published Artifact Manifest epoch. */
export interface ArtifactInspection {
  readonly application: ApplicationExplorer;
  readonly epochId: string;
  readonly files: readonly ArtifactInspectionFile[];
  readonly project: ProjectContext;
  readonly projections: readonly ArtifactInspectionProjection[];
  readonly provenance: readonly ArtifactInspectionProvenance[];
  readonly runtime: ArtifactInspectionRuntime;
}

export interface ArtifactEpochAddedFile {
  readonly after: ArtifactInspectionFile;
  readonly path: string;
}

export interface ArtifactEpochRemovedFile {
  readonly before: ArtifactInspectionFile;
  readonly path: string;
}

export interface ArtifactEpochChangedFile {
  readonly after: ArtifactInspectionFile;
  readonly before: ArtifactInspectionFile;
  readonly path: string;
}

export interface ArtifactEpochUnchangedFile {
  readonly after: ArtifactInspectionFile;
  readonly before: ArtifactInspectionFile;
  readonly path: string;
}

/** Stable facts-only difference between two exact published artifact epochs. */
export interface ArtifactEpochDiff {
  readonly added: readonly ArtifactEpochAddedFile[];
  readonly baseEpochId: string;
  readonly candidateEpochId: string;
  readonly changed: readonly ArtifactEpochChangedFile[];
  readonly removed: readonly ArtifactEpochRemovedFile[];
  readonly unchanged: readonly ArtifactEpochUnchangedFile[];
}

export type SourceState = 'unknown' | 'ready' | 'invalid';

export interface SourceStatus {
  readonly diagnostics: readonly Diagnostic[];
  /** The npm package name axis derived from package.json, when valid. */
  readonly packageName?: string;
  /** The semantic release-version axis derived from package.json, when valid. */
  readonly packageVersion?: string;
  readonly revision?: string;
  readonly state: SourceState;
}

export interface RunningBuildAttempt {
  readonly completedAt?: never;
  readonly diagnostics: readonly Diagnostic[];
  readonly id: string;
  readonly outcome: 'running';
  readonly result?: never;
  readonly sourceRevision: string;
  readonly startedAt: string;
}

export interface SucceededBuildAttempt {
  readonly completedAt: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly id: string;
  readonly outcome: 'succeeded';
  readonly result: Readonly<{ readonly epoch: ArtifactEpoch }>;
  readonly sourceRevision: string;
  readonly startedAt: string;
}

export interface FailedBuildAttempt {
  readonly completedAt: string;
  readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  readonly id: string;
  readonly outcome: 'failed';
  readonly result?: never;
  readonly sourceRevision: string;
  readonly startedAt: string;
}

export type BuildAttempt =
  | RunningBuildAttempt
  | SucceededBuildAttempt
  | FailedBuildAttempt;
export type BuildAttemptOutcome = BuildAttempt['outcome'];
export type CompletedBuildAttempt = Exclude<BuildAttempt, RunningBuildAttempt>;

export type BuildStatus =
  | Readonly<{
      readonly lastAttempt?: CompletedBuildAttempt;
      readonly state: 'idle';
    }>
  | Readonly<{
      readonly activeAttempt: RunningBuildAttempt;
      readonly lastAttempt?: CompletedBuildAttempt;
      readonly state: 'building';
    }>
  | Readonly<{
      readonly lastAttempt: FailedBuildAttempt;
      readonly state: 'failed';
    }>;

export type BuildState = BuildStatus['state'];

export type ArtifactStatus =
  | Readonly<{
      readonly activeEpoch?: never;
      readonly currentSourceRevision?: string;
      readonly state: 'missing';
    }>
  | Readonly<{
      readonly activeEpoch: ArtifactEpoch;
      readonly currentSourceRevision: string;
      readonly state: 'active';
    }>
  | Readonly<{
      /** Last fully published epoch, retained while the source is newer. */
      readonly activeEpoch: ArtifactEpoch;
      readonly currentSourceRevision: string;
      readonly state: 'stale';
    }>;

export type ActiveArtifactStatus = Extract<ArtifactStatus, { state: 'active' }>;
export type StaleArtifactStatus = Extract<ArtifactStatus, { state: 'stale' }>;
export type ArtifactState = ArtifactStatus['state'];

/**
 * A non-secret, foreground-topology capability. It is present only when this
 * foreground owns a fixed development Runtime controller; it is not Runtime
 * state and deliberately carries no provider or declaration details.
 */
export interface ProjectRuntimeTopology {
  readonly state: 'configured';
}

/**
 * What live host MCP connections and opted-in development installs currently
 * serve. Present only on a foreground that owns host-facing surfaces; absent
 * from coordinator-only status.
 */
export interface HostAdoptionStatus {
  /** The epoch host-facing surfaces serve; absent until one has been adopted. */
  readonly adoptedEpochId?: string;
  /** The latest contract-matrix evaluation, present only when `dev.contracts` gates adoption. */
  readonly contracts?: DevContractStatusEvent;
  /** `gated` when `dev.contracts` is declared; `direct` when hosts follow `artifact.available`. */
  readonly mode: 'direct' | 'gated';
}

export interface ProjectStatus {
  readonly artifact: ArtifactStatus;
  readonly build: BuildStatus;
  readonly hostAdoption?: HostAdoptionStatus;
  readonly runtime?: ProjectRuntimeTopology;
  readonly source: SourceStatus;
}

export type InvalidationReason = 'initial' | 'manual' | 'source-change';

/** A debounced batch of source paths which requires project work to be reconsidered. */
export interface Invalidation {
  readonly occurredAt: string;
  readonly paths: readonly string[];
  readonly reason: InvalidationReason;
}

export interface RuntimeEvent {
  readonly correlationId?: string;
  readonly details?: JsonObject;
  readonly mcpRegistryRevision?: number;
  readonly mcpSessionId?: string;
  readonly mcpSessionRevision?: number;
  readonly providerSessionId: string;
  readonly runId?: string;
  readonly runtimeGenerationId?: string;
  readonly type: import('./runtime-provider.ts').DevRuntimeEventInput['type'];
}

export interface DevHostSyncEvent {
  readonly diagnostics: readonly Diagnostic[];
  readonly epochId: string;
  readonly host: 'claude' | 'codex' | 'cursor';
  readonly state: 'failed' | 'succeeded';
}

export interface DevContractFailure {
  readonly checks: readonly string[];
  readonly routeId: string;
}

export interface DevContractStatusEvent {
  readonly diagnostics: readonly Diagnostic[];
  readonly epochId: string;
  readonly failures: readonly DevContractFailure[];
  readonly state: 'failed' | 'passed';
  readonly summary: string;
}

export interface ProjectEventPayloadMap {
  readonly 'artifact.available': ActiveArtifactStatus;
  readonly 'artifact.status': ArtifactStatus;
  readonly 'build.failed': FailedBuildAttempt;
  readonly 'build.started': RunningBuildAttempt;
  readonly 'dev.contract.status': DevContractStatusEvent;
  readonly 'dev.host.sync': DevHostSyncEvent;
  readonly invalidation: Invalidation;
  readonly 'route.invocation': RouteInvocationEventPayload;
  readonly 'runtime.event': RuntimeEvent;
  readonly 'source.changed': Invalidation;
  readonly 'source.status': SourceStatus;
}

export type ProjectEventType = keyof ProjectEventPayloadMap;
type EpochScopedProjectEventType = 'artifact.available' | 'dev.contract.status' | 'dev.host.sync';

type ProjectEventFor<TType extends ProjectEventType> = TType extends ProjectEventType
  ? Readonly<{
      readonly occurredAt: string;
      readonly payload: ProjectEventPayloadMap[TType];
      readonly sequence: number;
      readonly type: TType;
    }> &
      (TType extends EpochScopedProjectEventType
        ? Readonly<{ readonly epochId: string }>
        : Readonly<{ readonly epochId?: string }>)
  : never;

/** Stable envelope for each published project event. */
export type ProjectEvent = {
  readonly [TType in ProjectEventType]: ProjectEventFor<TType>;
}[ProjectEventType];

export type ProjectEventOf<TType extends ProjectEventType> = ProjectEventFor<TType>;

export interface ProjectReplayGap {
  readonly earliestAvailableSequence: number;
  readonly latestDroppedSequence: number;
  readonly requestedAfterSequence: number;
  readonly type: 'replay.gap';
}

export type ProjectEventMessage = ProjectEvent | ProjectReplayGap;

const invalidJson = (reason: string): never => {
  throw new TypeError(`Project event payload must be JSON: ${reason}`);
};

const freezeJson = (value: unknown, seen: WeakSet<object>): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : invalidJson('numbers must be finite');
  }

  if (typeof value !== 'object') {
    return invalidJson(`unsupported ${typeof value} value`);
  }

  if (seen.has(value)) {
    return invalidJson('cyclic or repeated references are not supported');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        return invalidJson('arrays cannot contain non-index properties');
      }

      if (key === 'length') {
        continue;
      }

      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        return invalidJson('arrays cannot contain out-of-range index properties');
      }
    }

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        return invalidJson('arrays cannot contain holes or accessors');
      }
      freezeJson(descriptor.value, seen);
    }

    return Object.freeze(value) as JsonArray;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidJson('objects must have a plain-object prototype');
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      return invalidJson('objects cannot contain symbol properties');
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      return invalidJson('objects cannot contain accessors');
    }
    freezeJson(descriptor.value, seen);
  }

  return Object.freeze(value) as JsonObject;
};

/**
 * Validates a strict JSON tree and freezes every reachable array and object.
 *
 * Deliberately separate from core `snapshotStrictJsonValue`: this variant
 * freezes the caller's value IN PLACE (identity-preserving, observable to
 * ProjectEventHub.publish callers that keep a reference) instead of returning
 * a detached copy, and it rejects repeated references, not just cycles.
 */
export const freezeJsonValue = (value: unknown): JsonValue =>
  freezeJson(value, new WeakSet<object>());

const freezeStructured = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeStructured((value as Record<PropertyKey, unknown>)[key], seen);
  }

  return Object.freeze(value);
};

export const freezeArtifactEpoch = (epoch: ArtifactEpoch): ArtifactEpoch =>
  freezeStructured(epoch);

export const freezeProjectStatus = (status: ProjectStatus): ProjectStatus =>
  freezeStructured(status);

export const freezeInvalidation = (invalidation: Invalidation): Invalidation =>
  freezeStructured(invalidation);

export const freezeProjectEvent = (event: ProjectEvent): ProjectEvent =>
  freezeStructured(event);
