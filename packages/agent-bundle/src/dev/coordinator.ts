import { resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { ArtifactService, type ArtifactEpochResult } from './artifact-service.ts';
import { DiagnosticService, type DiagnosticReport } from './diagnostic-service.ts';
import { acquireDevLock, type DevLockOptions } from './dev-lock.ts';
import { EpochStore } from './epoch-store.ts';
import { ProjectEventHub } from './events.ts';
import { ProjectService, type PreparedProject } from './project-service.ts';
import {
  freezeInvalidation,
  freezeProjectStatus,
  type ArtifactEpoch,
  type ArtifactStatus,
  type BuildAttempt,
  type FailedBuildAttempt,
  type Invalidation,
  type ProjectStatus,
  type RunningBuildAttempt,
  type SourceStatus,
  type SucceededBuildAttempt,
} from './types.ts';

export interface DevLockHandle {
  close(): Promise<void>;
}

export interface ProjectPreparer {
  prepare(command: 'build'): Promise<PreparedProject>;
}

export interface ArtifactBuilder {
  build(prepared: PreparedProject): Promise<ArtifactEpochResult>;
}

export interface AffectedFileDiagnostics {
  close(): Promise<void>;
  lint(paths: readonly string[]): Promise<DiagnosticReport>;
}

export interface DevSession {
  close(): Promise<void>;
  status(): ProjectStatus;
}

export interface DevCoordinatorOptions {
  readonly acquireLock?: (options: DevLockOptions) => Promise<DevLockHandle>;
  readonly artifactService?: ArtifactBuilder;
  readonly createAttemptId?: () => string;
  readonly diagnosticService?: AffectedFileDiagnostics;
  readonly epochStore?: EpochStore;
  readonly eventHub?: ProjectEventHub;
  readonly now?: () => Date;
  readonly projectService?: ProjectPreparer;
  readonly root: string;
}

interface QueuedBuild {
  readonly invalidation: Invalidation;
  readonly resolvers: readonly ((result: ArtifactEpochResult) => void)[];
}

const freezeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));

const emptySource = (): SourceStatus => Object.freeze({
  diagnostics: Object.freeze([]),
  state: 'unknown',
});

const initialStatus = (): ProjectStatus => freezeProjectStatus({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: emptySource(),
});

const nowInvalidation = (
  now: () => Date,
  reason: Invalidation['reason'],
  paths: readonly string[],
): Invalidation => freezeInvalidation({
  occurredAt: now().toISOString(),
  paths: Object.freeze([...new Set(paths)].sort((left, right) => left.localeCompare(right))),
  reason,
});

const mergeInvalidations = (left: Invalidation, right: Invalidation): Invalidation => freezeInvalidation({
  occurredAt: left.occurredAt <= right.occurredAt ? left.occurredAt : right.occurredAt,
  paths: Object.freeze([...new Set([...left.paths, ...right.paths])].sort((first, second) => first.localeCompare(second))),
  reason: left.reason === 'manual' || right.reason === 'manual'
    ? 'manual'
    : left.reason === 'initial' && right.reason === 'initial'
      ? 'initial'
      : 'source-change',
});

const failure = (message: string): ArtifactEpochResult => {
  const diagnostics: [Diagnostic] = [Object.freeze({
    code: 'AB7200',
    message,
    severity: 'error' as const,
  })];
  return Object.freeze({ diagnostics: Object.freeze(diagnostics), outcome: 'failed' });
};

const lastAttempt = (status: ProjectStatus): Exclude<BuildAttempt, RunningBuildAttempt> | undefined =>
  status.build.lastAttempt;

const artifactStatusFor = (
  epoch: ArtifactEpoch | undefined,
  sourceRevision: string | undefined,
): ArtifactStatus => {
  if (epoch === undefined) {
    return Object.freeze({
      ...(sourceRevision === undefined ? {} : { currentSourceRevision: sourceRevision }),
      state: 'missing',
    });
  }
  if (sourceRevision === epoch.projectRevision) {
    return Object.freeze({ activeEpoch: epoch, currentSourceRevision: sourceRevision, state: 'active' });
  }
  return Object.freeze({
    activeEpoch: epoch,
    currentSourceRevision: sourceRevision ?? epoch.projectRevision,
    state: 'stale',
  });
};

/** Serializes development rebuilds and preserves a last known-good artifact epoch. */
export class DevCoordinator {
  readonly #acquireLock: (options: DevLockOptions) => Promise<DevLockHandle>;
  readonly #artifactService: ArtifactBuilder;
  readonly #createAttemptId: () => string;
  readonly #diagnosticService: AffectedFileDiagnostics;
  readonly #epochStore: EpochStore;
  readonly #eventHub: ProjectEventHub;
  readonly #now: () => Date;
  readonly #projectService: ProjectPreparer;
  readonly #root: string;
  #activeEpoch: ArtifactEpoch | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #currentBuild: Promise<ArtifactEpochResult> | undefined;
  #lock: DevLockHandle | undefined;
  #queued: QueuedBuild | undefined;
  #startPromise: Promise<DevSession> | undefined;
  #status: ProjectStatus = initialStatus();

  constructor(options: DevCoordinatorOptions) {
    this.#root = resolve(options.root);
    this.#acquireLock = options.acquireLock ?? acquireDevLock;
    this.#epochStore = options.epochStore ?? new EpochStore({ projectRoot: this.#root });
    this.#artifactService = options.artifactService ?? new ArtifactService({ epochStore: this.#epochStore });
    this.#createAttemptId = options.createAttemptId ?? (() => crypto.randomUUID());
    this.#diagnosticService = options.diagnosticService ?? new DiagnosticService({ root: this.#root });
    this.#eventHub = options.eventHub ?? new ProjectEventHub({ now: options.now });
    this.#now = options.now ?? (() => new Date());
    this.#projectService = options.projectService ?? new ProjectService({ root: this.#root });
  }

  async start(): Promise<DevSession> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#closing) throw new Error('DevCoordinator is closed.');
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async rebuild(invalidation: Invalidation): Promise<ArtifactEpochResult> {
    if (this.#closing) return failure('DevCoordinator is closed.');
    const normalized = nowInvalidation(this.#now, invalidation.reason, invalidation.paths);
    if (this.#currentBuild === undefined) return this.#startBuild(normalized);
    return new Promise<ArtifactEpochResult>((resolvePromise) => {
      this.#queued = this.#queued === undefined
        ? { invalidation: normalized, resolvers: [resolvePromise] }
        : {
          invalidation: mergeInvalidations(this.#queued.invalidation, normalized),
          resolvers: [...this.#queued.resolvers, resolvePromise],
        };
    });
  }

  status(): ProjectStatus {
    return this.#status;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    const queued = this.#queued;
    this.#queued = undefined;
    queued?.resolvers.forEach((resolveResult) => resolveResult(failure('DevCoordinator is closing.')));
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<DevSession> {
    this.#lock = await this.#acquireLock({ projectRoot: this.#root });
    try {
      await this.#epochStore.recoverStaging();
      await this.rebuild(nowInvalidation(this.#now, 'initial', []));
      return Object.freeze({
        close: () => this.close(),
        status: () => this.status(),
      });
    } catch (error) {
      await this.#lock.close();
      this.#lock = undefined;
      throw error;
    }
  }

  #startBuild(invalidation: Invalidation): Promise<ArtifactEpochResult> {
    const current = this.#performBuild(invalidation).finally(() => {
      this.#currentBuild = undefined;
      const queued = this.#queued;
      this.#queued = undefined;
      if (queued === undefined) return;
      if (this.#closing) {
        queued.resolvers.forEach((resolveResult) => resolveResult(failure('DevCoordinator is closing.')));
        return;
      }
      this.#startBuild(queued.invalidation).then(
        (result) => queued.resolvers.forEach((resolveResult) => resolveResult(result)),
        () => queued.resolvers.forEach((resolveResult) => resolveResult(failure('DevCoordinator rebuild failed.'))),
      );
    });
    this.#currentBuild = current;
    return current;
  }

  async #performBuild(invalidation: Invalidation): Promise<ArtifactEpochResult> {
    const prepared = await this.#projectService.prepare('build');
    const sourceRevision = prepared.source.revision ?? 'unknown';
    const running: RunningBuildAttempt = Object.freeze({
      diagnostics: freezeDiagnostics(prepared.diagnostics),
      id: this.#createAttemptId(),
      outcome: 'running',
      sourceRevision,
      startedAt: this.#now().toISOString(),
    });
    this.#status = freezeProjectStatus({
      artifact: artifactStatusFor(this.#activeEpoch, prepared.source.revision),
      build: {
        activeAttempt: running,
        ...(lastAttempt(this.#status) === undefined ? {} : { lastAttempt: lastAttempt(this.#status) }),
        state: 'building',
      },
      source: prepared.source,
    });
    this.#eventHub.publish({ payload: invalidation, type: 'source.changed' });
    this.#eventHub.publish({ payload: invalidation, type: 'invalidation' });
    this.#eventHub.publish({ payload: prepared.source, type: 'source.status' });
    this.#eventHub.publish({ payload: running, type: 'build.started' });
    await this.#diagnosticService.lint(invalidation.paths);

    const result = await this.#artifactService.build(prepared);
    const completedAt = this.#now().toISOString();
    if (result.outcome === 'succeeded') {
      const completed: SucceededBuildAttempt = Object.freeze({
        completedAt,
        diagnostics: freezeDiagnostics(result.diagnostics),
        id: running.id,
        outcome: 'succeeded',
        result: Object.freeze({ epoch: result.epoch }),
        sourceRevision,
        startedAt: running.startedAt,
      });
      this.#activeEpoch = result.epoch;
      const artifact = artifactStatusFor(this.#activeEpoch, prepared.source.revision);
      this.#status = freezeProjectStatus({
        artifact,
        build: { lastAttempt: completed, state: 'idle' },
        source: prepared.source,
      });
      if (artifact.state === 'active') {
        this.#eventHub.publish({ epochId: result.epoch.id, payload: artifact, type: 'artifact.available' });
      }
      this.#eventHub.publish({ payload: artifact, type: 'artifact.status' });
      return result;
    }

    const completed: FailedBuildAttempt = Object.freeze({
      completedAt,
      diagnostics: result.diagnostics,
      id: running.id,
      outcome: 'failed',
      sourceRevision,
      startedAt: running.startedAt,
    });
    const artifact = artifactStatusFor(this.#activeEpoch, prepared.source.revision);
    this.#status = freezeProjectStatus({
      artifact,
      build: { lastAttempt: completed, state: 'failed' },
      source: prepared.source,
    });
    this.#eventHub.publish({ payload: completed, type: 'build.failed' });
    this.#eventHub.publish({ payload: artifact, type: 'artifact.status' });
    return result;
  }

  async #close(): Promise<void> {
    await this.#currentBuild;
    const results = await Promise.allSettled([
      this.#diagnosticService.close(),
      this.#lock?.close() ?? Promise.resolve(),
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected !== undefined && rejected.status === 'rejected') throw rejected.reason;
  }
}
