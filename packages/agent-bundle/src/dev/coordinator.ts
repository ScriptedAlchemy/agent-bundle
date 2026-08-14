import { resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { ArtifactService, type ArtifactEpochResult, type FailedArtifactEpochResult } from './artifact-service.ts';
import { DiagnosticService, type DiagnosticReport } from './diagnostic-service.ts';
import { acquireDevLock, type DevLockOptions } from './dev-lock.ts';
import { EpochStore } from './epoch-store.ts';
import { ProjectEventHub } from './events.ts';
import { ProjectService, type PreparedProject } from './project-service.ts';
import { ProjectWatcher, type ProjectWatcherOptions } from './watcher.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from '../config/ignore.ts';
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

export interface DevelopmentWatcher {
  close(): Promise<void>;
  ready?(): Promise<void>;
}

export interface DevCoordinatorCloseFailure {
  readonly error: unknown;
  readonly resource: 'build' | 'diagnostics' | 'lock' | 'watcher';
}

/** Reports every resource that could not be released during coordinator shutdown. */
export class DevCoordinatorCloseError extends Error {
  readonly failures: readonly DevCoordinatorCloseFailure[];

  constructor(failures: readonly DevCoordinatorCloseFailure[]) {
    super('DevCoordinator could not close every resource.');
    this.name = 'DevCoordinatorCloseError';
    this.failures = Object.freeze([...failures]);
  }
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
  readonly createWatcher?: (options: ProjectWatcherOptions) => DevelopmentWatcher;
  readonly epochStore?: EpochStore;
  readonly eventHub?: ProjectEventHub;
  readonly now?: () => Date;
  readonly ignoredPaths?: readonly string[];
  readonly outputPaths?: readonly string[];
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

const phaseDiagnostic = (phase: 'artifact' | 'lint' | 'prepare', error: unknown): Diagnostic => Object.freeze({
  code: 'AB7201',
  message: `${phase[0]!.toUpperCase()}${phase.slice(1)} failed during development rebuild: ${
    error instanceof Error ? error.message : String(error)
  }`,
  severity: 'error',
});

const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

const withDiagnostics = (
  source: SourceStatus,
  diagnostics: readonly Diagnostic[],
): SourceStatus => freezeProjectStatus({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: {
    diagnostics: freezeDiagnostics([...source.diagnostics, ...diagnostics]),
    ...(source.revision === undefined ? {} : { revision: source.revision }),
    state: hasErrors([...source.diagnostics, ...diagnostics]) ? 'invalid' : source.state,
  },
}).source;

const failedResult = (diagnostics: readonly Diagnostic[]): FailedArtifactEpochResult => {
  const first = diagnostics[0] ?? phaseDiagnostic('artifact', new Error('Unknown rebuild failure.'));
  const nonemptyDiagnostics: [Diagnostic, ...Diagnostic[]] = [first, ...diagnostics.slice(1)];
  return Object.freeze({
    diagnostics: Object.freeze(nonemptyDiagnostics),
    outcome: 'failed',
  });
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
  readonly #createWatcher: (options: ProjectWatcherOptions) => DevelopmentWatcher;
  readonly #diagnosticService: AffectedFileDiagnostics;
  readonly #epochStore: EpochStore;
  readonly #eventHub: ProjectEventHub;
  readonly #now: () => Date;
  readonly #ignoredPaths: readonly string[];
  readonly #outputPaths: readonly string[];
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
  #watcher: DevelopmentWatcher | undefined;

  constructor(options: DevCoordinatorOptions) {
    this.#root = resolve(options.root);
    this.#acquireLock = options.acquireLock ?? acquireDevLock;
    this.#epochStore = options.epochStore ?? new EpochStore({ projectRoot: this.#root });
    this.#artifactService = options.artifactService ?? new ArtifactService({ epochStore: this.#epochStore });
    this.#createAttemptId = options.createAttemptId ?? (() => crypto.randomUUID());
    this.#createWatcher = options.createWatcher ?? ((watcherOptions) => new ProjectWatcher(watcherOptions));
    this.#diagnosticService = options.diagnosticService ?? new DiagnosticService({ root: this.#root });
    this.#eventHub = options.eventHub ?? new ProjectEventHub({ now: options.now });
    this.#ignoredPaths = Object.freeze([...(options.ignoredPaths ?? [])]);
    this.#now = options.now ?? (() => new Date());
    this.#outputPaths = Object.freeze([...(options.outputPaths ?? ['dist'])]);
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
    if (this.#lock === undefined) return failure('DevCoordinator must be started before rebuilding.');
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
      if (this.#closing) throw new Error('DevCoordinator is closed.');
      await this.#epochStore.recoverStaging();
      this.#activeEpoch = await this.#epochStore.readActiveEpoch();
      const projectIgnoreRules = await readProjectIgnoreRules(this.#root);
      this.#watcher = this.#createWatcher({
        ignoredPaths: this.#ignoredPaths,
        isIgnored: (source) => isProjectPathIgnored(projectIgnoreRules, this.#root, source),
        now: this.#now,
        onInvalidation: async (invalidation) => this.rebuild(invalidation),
        outputPaths: this.#outputPaths,
        root: this.#root,
      });
      await this.#watcher.ready?.();
      await this.rebuild(nowInvalidation(this.#now, 'initial', []));
      return Object.freeze({
        close: () => this.close(),
        status: () => this.status(),
      });
    } catch (error) {
      await Promise.allSettled([
        this.#watcher?.close() ?? Promise.resolve(),
        this.#lock.close(),
      ]);
      this.#watcher = undefined;
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

  #beginBuild(invalidation: Invalidation, source: SourceStatus): RunningBuildAttempt {
    const running: RunningBuildAttempt = Object.freeze({
      diagnostics: freezeDiagnostics(source.diagnostics),
      id: this.#createAttemptId(),
      outcome: 'running',
      sourceRevision: source.revision ?? 'unknown',
      startedAt: this.#now().toISOString(),
    });
    this.#status = freezeProjectStatus({
      artifact: artifactStatusFor(this.#activeEpoch, source.revision),
      build: {
        activeAttempt: running,
        ...(lastAttempt(this.#status) === undefined ? {} : { lastAttempt: lastAttempt(this.#status) }),
        state: 'building',
      },
      source,
    });
    this.#eventHub.publish({ payload: invalidation, type: 'source.changed' });
    this.#eventHub.publish({ payload: invalidation, type: 'invalidation' });
    this.#eventHub.publish({ payload: source, type: 'source.status' });
    this.#eventHub.publish({ payload: running, type: 'build.started' });
    return running;
  }

  #completeFailure(
    running: RunningBuildAttempt,
    source: SourceStatus,
    diagnostics: readonly Diagnostic[],
  ): FailedArtifactEpochResult {
    const result = failedResult(diagnostics);
    const completed: FailedBuildAttempt = Object.freeze({
      completedAt: this.#now().toISOString(),
      diagnostics: result.diagnostics,
      id: running.id,
      outcome: 'failed',
      sourceRevision: running.sourceRevision,
      startedAt: running.startedAt,
    });
    const artifact = artifactStatusFor(this.#activeEpoch, source.revision);
    this.#status = freezeProjectStatus({
      artifact,
      build: { lastAttempt: completed, state: 'failed' },
      source,
    });
    this.#eventHub.publish({ payload: source, type: 'source.status' });
    this.#eventHub.publish({ payload: completed, type: 'build.failed' });
    this.#eventHub.publish({ payload: artifact, type: 'artifact.status' });
    return result;
  }

  async #performBuild(invalidation: Invalidation): Promise<ArtifactEpochResult> {
    let prepared: PreparedProject;
    try {
      prepared = await this.#projectService.prepare('build');
    } catch (error) {
      const source = withDiagnostics(this.#status.source, [phaseDiagnostic('prepare', error)]);
      return this.#completeFailure(this.#beginBuild(invalidation, source), source, source.diagnostics);
    }

    const running = this.#beginBuild(invalidation, prepared.source);
    let lintDiagnostics: readonly Diagnostic[];
    try {
      const report = await this.#diagnosticService.lint(invalidation.paths);
      lintDiagnostics = freezeDiagnostics(report.diagnostics);
    } catch (error) {
      const source = withDiagnostics(prepared.source, [phaseDiagnostic('lint', error)]);
      return this.#completeFailure(running, source, source.diagnostics);
    }

    const source = withDiagnostics(prepared.source, lintDiagnostics);
    if (hasErrors(lintDiagnostics)) {
      return this.#completeFailure(running, source, source.diagnostics);
    }

    let result: ArtifactEpochResult;
    try {
      result = await this.#artifactService.build(prepared);
    } catch (error) {
      return this.#completeFailure(running, source, [
        ...source.diagnostics,
        phaseDiagnostic('artifact', error),
      ]);
    }
    const diagnostics = freezeDiagnostics([...lintDiagnostics, ...result.diagnostics]);
    if (result.outcome === 'succeeded') {
      const completed: SucceededBuildAttempt = Object.freeze({
        completedAt: this.#now().toISOString(),
        diagnostics,
        id: running.id,
        outcome: 'succeeded',
        result: Object.freeze({ epoch: result.epoch }),
        sourceRevision: running.sourceRevision,
        startedAt: running.startedAt,
      });
      this.#activeEpoch = result.epoch;
      const artifact = artifactStatusFor(this.#activeEpoch, source.revision);
      this.#status = freezeProjectStatus({
        artifact,
        build: { lastAttempt: completed, state: 'idle' },
        source,
      });
      if (artifact.state === 'active') {
        this.#eventHub.publish({ epochId: result.epoch.id, payload: artifact, type: 'artifact.available' });
      }
      this.#eventHub.publish({ payload: artifact, type: 'artifact.status' });
      return Object.freeze({ diagnostics, epoch: result.epoch, outcome: 'succeeded' });
    }
    return this.#completeFailure(running, source, diagnostics);
  }

  async #close(): Promise<void> {
    const inFlight = this.#currentBuild ?? this.#startPromise;
    const buildResult = await Promise.allSettled([inFlight ?? Promise.resolve()]);
    const resources: readonly Readonly<{
      readonly close: () => Promise<unknown>;
      readonly resource: DevCoordinatorCloseFailure['resource'];
    }>[] = [
      { close: async () => this.#watcher?.close(), resource: 'watcher' },
      { close: () => this.#diagnosticService.close(), resource: 'diagnostics' },
      { close: async () => this.#lock?.close(), resource: 'lock' },
    ];
    const results = await Promise.allSettled(resources.map(async ({ close }) => close()));
    const failures = [
      ...buildResult.flatMap((result): readonly DevCoordinatorCloseFailure[] =>
        result.status === 'rejected'
          ? [Object.freeze({ error: result.reason, resource: 'build' })]
          : [],
      ),
      ...results.flatMap((result, index): readonly DevCoordinatorCloseFailure[] =>
        result.status === 'rejected'
          ? [Object.freeze({ error: result.reason, resource: resources[index]!.resource })]
          : [],
      ),
    ];
    if (failures.length > 0) throw new DevCoordinatorCloseError(failures);
  }
}
