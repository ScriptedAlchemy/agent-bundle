import type { Diagnostic } from '../core/diagnostics.ts';

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
  readonly projectRevision: string;
  readonly targetDigests: Readonly<Record<string, string>>;
}

export type SourceState = 'unknown' | 'ready' | 'invalid';

export interface SourceStatus {
  readonly diagnostics: readonly Diagnostic[];
  readonly revision?: string;
  readonly state: SourceState;
}

export type BuildAttemptOutcome = 'running' | 'succeeded' | 'failed';

/** A single build attempt. Failed attempts never replace an active epoch. */
export interface BuildAttempt {
  readonly completedAt?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly id: string;
  readonly outcome: BuildAttemptOutcome;
  readonly sourceRevision: string;
  readonly startedAt: string;
}

export type BuildState = 'idle' | 'building' | 'failed';

export interface BuildStatus {
  readonly lastAttempt?: BuildAttempt;
  readonly state: BuildState;
}

export type ArtifactState = 'missing' | 'active' | 'stale';

export interface ArtifactStatus {
  /** Last fully published epoch, including while it is stale. */
  readonly activeEpoch?: ArtifactEpoch;
  /** Revision of the source currently represented by the source status. */
  readonly currentSourceRevision?: string;
  readonly state: ArtifactState;
}

export interface ProjectStatus {
  readonly artifact: ArtifactStatus;
  readonly build: BuildStatus;
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
  readonly details?: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly type: string;
}

export type ProjectEventType =
  | 'source.changed'
  | 'source.status'
  | 'invalidation'
  | 'build.started'
  | 'build.failed'
  | 'artifact.available'
  | 'artifact.status'
  | 'runtime.event';

/**
 * Stable envelope used by every persisted-in-memory project event. Sequence IDs
 * belong only to published events; synthetic replay notices intentionally have
 * their own type so they cannot impersonate an event that has fallen out of the
 * bounded buffer.
 */
export interface ProjectEvent<TPayload = unknown> {
  readonly epochId?: string;
  readonly occurredAt: string;
  readonly payload: TPayload;
  readonly sequence: number;
  readonly type: ProjectEventType;
}

export interface ProjectReplayGap {
  readonly earliestAvailableSequence: number;
  readonly latestDroppedSequence: number;
  readonly requestedAfterSequence: number;
  readonly type: 'replay.gap';
}

export type ProjectEventMessage = ProjectEvent | ProjectReplayGap;

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

export const freezeProjectEvent = <TPayload>(
  event: ProjectEvent<TPayload>,
): ProjectEvent<TPayload> => freezeStructured(event);

