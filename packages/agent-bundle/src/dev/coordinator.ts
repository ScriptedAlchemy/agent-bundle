import { Deferred, Effect, Semaphore } from 'effect';
import { resolve } from 'node:path';

import { freezeDiagnostics, hasErrors } from '../core/diagnostics.ts';
import { runPromise, runSync } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { ArtifactService, type ArtifactEpochResult, type FailedArtifactEpochResult } from './artifacts/artifact-service.ts';
import { DiagnosticService, type DiagnosticReport } from './diagnostic-service.ts';
import { acquireDevLock, type DevLockOptions } from './dev-lock.ts';
import { EpochStore } from './epoch-store.ts';
import { ProjectEventHub } from './events.ts';
import { DevPackageBuildService, type DevPackageBuilder } from './package-build-service.ts';
import { ProjectService, type PreparedProject, type ProjectCommand } from './project-service.ts';
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
  publishServerUrl?(url: string): Promise<void>;
}

export interface ProjectPreparer {
  prepare(command: ProjectCommand): Promise<PreparedProject>;
}

export interface ArtifactBuilder {
  build(prepared: PreparedProject): Promise<ArtifactEpochResult>;
}

export interface AffectedFileDiagnostics {
  close(): Promise<void>;
  lint(paths: readonly string[]): Promise<DiagnosticReport>;
}

export interface DevelopmentWatcher {
  addOutputPaths?(paths: readonly string[]): void;
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
  /** A pre-loaded initial config avoids evaluating a development config factory twice. */
  readonly initialPreparedProject?: PreparedProject;
  readonly ignoredPaths?: readonly string[];
  readonly onPreparedProject?: (prepared: PreparedProject) => Promise<void>;
  readonly outputPaths?: readonly string[];
  /** Rebuilds the framework-owned package build (bin/lib) after successful artifact rebuilds. */
  readonly packageBuildService?: DevPackageBuilder;
  readonly prepareCommand?: 'build' | 'dev';
  readonly projectService?: ProjectPreparer;
  readonly root: string;
}

/**
 * The coalesced follow-up rebuild: every invalidation that arrives while a
 * build runs merges into this single slot, and every requester shares one
 * `Deferred` completed with the follow-up's result.
 */
interface QueuedBuild {
  readonly deferred: Deferred.Deferred<ArtifactEpochResult>;
  readonly invalidation: Invalidation;
}

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

const withDiagnostics = (
  source: SourceStatus,
  diagnostics: readonly Diagnostic[],
): SourceStatus => freezeProjectStatus({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: {
    diagnostics: freezeDiagnostics([...source.diagnostics, ...diagnostics]),
    ...(source.packageName === undefined ? {} : { packageName: source.packageName }),
    ...(source.packageVersion === undefined ? {} : { packageVersion: source.packageVersion }),
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
  readonly #cancelStartup: () => void;
  readonly #createAttemptId: () => string;
  readonly #createWatcher: (options: ProjectWatcherOptions) => DevelopmentWatcher;
  readonly #diagnosticService: AffectedFileDiagnostics;
  readonly #epochStore: EpochStore;
  readonly #eventHub: ProjectEventHub;
  readonly #now: () => Date;
  readonly #ignoredPaths: readonly string[];
  readonly #outputPaths: readonly string[];
  readonly #onPreparedProject: ((prepared: PreparedProject) => Promise<void>) | undefined;
  readonly #packageBuildService: DevPackageBuilder;
  readonly #prepareCommand: 'build' | 'dev';
  readonly #projectService: ProjectPreparer;
  readonly #root: string;
  /** Serializes build passes; admission below guarantees one holder, the permit makes the invariant structural. */
  readonly #buildPermit: Semaphore.Semaphore = runSync(Semaphore.make(1));
  readonly #startRebuildToken = Symbol('DevCoordinator initial rebuild');
  readonly #startupCancellation: Promise<void>;
  #activeEpoch: ArtifactEpoch | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #currentBuild: Promise<ArtifactEpochResult> | undefined;
  #lock: DevLockHandle | undefined;
  #lockClosePromise: Promise<void> | undefined;
  #queued: QueuedBuild | undefined;
  #nextPreparedProject: PreparedProject | undefined;
  #startPromise: Promise<DevSession> | undefined;
  #status: ProjectStatus = initialStatus();
  #session: DevSession | undefined;
  #watcher: DevelopmentWatcher | undefined;
  #watcherClosePromise: Promise<void> | undefined;

  constructor(options: DevCoordinatorOptions) {
    this.#root = resolve(options.root);
    this.#acquireLock = options.acquireLock ?? acquireDevLock;
    this.#epochStore = options.epochStore ?? new EpochStore({ projectRoot: this.#root });
    this.#artifactService = options.artifactService ?? new ArtifactService({ epochStore: this.#epochStore });
    let cancelStartup: () => void = () => undefined;
    this.#startupCancellation = new Promise<void>((resolvePromise) => {
      cancelStartup = resolvePromise;
    });
    this.#cancelStartup = cancelStartup;
    this.#createAttemptId = options.createAttemptId ?? (() => crypto.randomUUID());
    this.#createWatcher = options.createWatcher ?? ((watcherOptions) => new ProjectWatcher(watcherOptions));
    this.#diagnosticService = options.diagnosticService ?? new DiagnosticService({ root: this.#root });
    this.#eventHub = options.eventHub ?? new ProjectEventHub({ now: options.now });
    this.#ignoredPaths = Object.freeze([...(options.ignoredPaths ?? [])]);
    this.#now = options.now ?? (() => new Date());
    this.#nextPreparedProject = options.initialPreparedProject;
    this.#onPreparedProject = options.onPreparedProject;
    this.#packageBuildService = options.packageBuildService ?? new DevPackageBuildService();
    this.#outputPaths = Object.freeze([...new Set([
      ...(options.outputPaths ?? ['dist']),
      ...(options.initialPreparedProject?.outputRoots ?? []),
    ])]);
    this.#prepareCommand = options.prepareCommand ?? 'build';
    this.#projectService = options.projectService ?? new ProjectService({
      outputRoots: this.#outputPaths,
      root: this.#root,
    });
  }

  async start(): Promise<DevSession> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#closing) throw new Error('DevCoordinator is closed.');
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async rebuild(invalidation: Invalidation): Promise<ArtifactEpochResult> {
    return this.#rebuild(invalidation);
  }

  async publishServerUrl(url: string): Promise<void> {
    await this.#lock?.publishServerUrl?.(url);
  }

  async #rebuild(
    invalidation: Invalidation,
    token?: symbol,
  ): Promise<ArtifactEpochResult> {
    if (this.#closing) return failure('DevCoordinator is closed.');
    if (token !== this.#startRebuildToken && this.#session === undefined) {
      return failure('DevCoordinator must finish starting before rebuilding.');
    }
    if (this.#lock === undefined) return failure('DevCoordinator must be started before rebuilding.');
    const normalized = nowInvalidation(this.#now, invalidation.reason, invalidation.paths);
    if (this.#currentBuild === undefined) return this.#startBuild(normalized);
    // Admission is synchronous on purpose: rebuilds issued in the same turn
    // must observe the running build and merge into exactly one follow-up.
    const queued = this.#queued;
    this.#queued = queued === undefined
      ? { deferred: runSync(Deferred.make<ArtifactEpochResult>()), invalidation: normalized }
      : { deferred: queued.deferred, invalidation: mergeInvalidations(queued.invalidation, normalized) };
    return runPromise(Deferred.await(this.#queued.deferred));
  }

  status(): ProjectStatus {
    return this.#status;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    const queued = this.#queued;
    this.#queued = undefined;
    if (queued !== undefined) {
      runSync(Deferred.succeed(queued.deferred, failure('DevCoordinator is closing.')));
    }
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(): Promise<DevSession> {
    try {
      await this.#acquireStartupLock();
      this.#assertOpen();
      await this.#awaitStartup(this.#epochStore.recoverStaging());
      this.#assertOpen();
      this.#activeEpoch = await this.#awaitStartup(this.#epochStore.readActiveEpoch());
      this.#assertOpen();
      const projectIgnoreRules = await this.#awaitStartup(readProjectIgnoreRules(this.#root));
      this.#assertOpen();
      this.#watcher = this.#createWatcher({
        ignoredPaths: this.#ignoredPaths,
        isIgnored: (source) => isProjectPathIgnored(projectIgnoreRules, this.#root, source),
        now: this.#now,
        onInvalidation: async (invalidation) => this.rebuild(invalidation),
        outputPaths: this.#outputPaths,
        root: this.#root,
      });
      await this.#awaitStartup(this.#watcher.ready?.() ?? Promise.resolve());
      this.#assertOpen();
      await this.#rebuild(nowInvalidation(this.#now, 'initial', []), this.#startRebuildToken);
      const session: DevSession = Object.freeze({
        close: () => this.close(),
        status: () => this.status(),
      });
      this.#session = session;
      return session;
    } catch (error) {
      await Promise.allSettled([
        this.#releaseWatcher(),
        this.#releaseLock(),
      ]);
      this.#watcher = undefined;
      this.#lock = undefined;
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error('DevCoordinator is closed.');
  }

  async #acquireStartupLock(): Promise<void> {
    const acquisition = this.#acquireLock({ projectRoot: this.#root });
    try {
      this.#lock = await this.#awaitStartup(acquisition);
    } catch (error) {
      void acquisition.then(
        (lock) => lock.close().catch(() => undefined),
        () => undefined,
      );
      throw error;
    }
  }

  async #awaitStartup<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([
      operation,
      this.#startupCancellation.then(() => {
        throw new Error('DevCoordinator is closed.');
      }),
    ]);
  }

  #releaseLock(): Promise<void> {
    if (this.#lockClosePromise !== undefined) return this.#lockClosePromise;
    const lock = this.#lock;
    if (lock === undefined) return Promise.resolve();
    this.#lockClosePromise = lock.close();
    return this.#lockClosePromise;
  }

  #releaseWatcher(): Promise<void> {
    if (this.#watcherClosePromise !== undefined) return this.#watcherClosePromise;
    const watcher = this.#watcher;
    if (watcher === undefined) return Promise.resolve();
    this.#watcherClosePromise = watcher.close();
    return this.#watcherClosePromise;
  }

  /**
   * Runs one build pass as an Effect fiber holding the build permit; the
   * exit hook drains the coalesced follow-up slot before the caller's
   * promise settles, exactly where the pre-Effect `finally` chain sat.
   */
  #startBuild(invalidation: Invalidation): Promise<ArtifactEpochResult> {
    const current = runPromise(this.#buildPermit.withPermit(
      liftPromise(() => this.#performBuild(invalidation)).pipe(
        Effect.onExit(() => Effect.sync(() => this.#drainQueuedBuild())),
      ),
    ));
    this.#currentBuild = current;
    return current;
  }

  #drainQueuedBuild(): void {
    this.#currentBuild = undefined;
    const queued = this.#queued;
    this.#queued = undefined;
    if (queued === undefined) return;
    if (this.#closing) {
      runSync(Deferred.succeed(queued.deferred, failure('DevCoordinator is closing.')));
      return;
    }
    this.#startBuild(queued.invalidation).then(
      (result) => runSync(Deferred.succeed(queued.deferred, result)),
      () => runSync(Deferred.succeed(queued.deferred, failure('DevCoordinator rebuild failed.'))),
    );
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
      const initial = this.#nextPreparedProject;
      this.#nextPreparedProject = undefined;
      prepared = initial ?? await this.#projectService.prepare(this.#prepareCommand);
    } catch (error) {
      const source = withDiagnostics(this.#status.source, [phaseDiagnostic('prepare', error)]);
      return this.#completeFailure(this.#beginBuild(invalidation, source), source, source.diagnostics);
    }

    this.#watcher?.addOutputPaths?.(prepared.outputRoots);
    const running = this.#beginBuild(invalidation, prepared.source);
    try {
      await this.#onPreparedProject?.(prepared);
    } catch (error) {
      const source = withDiagnostics(prepared.source, [phaseDiagnostic('prepare', error)]);
      return this.#completeFailure(running, source, source.diagnostics);
    }
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
    // The package build (bin/lib) rebuilds inside the same serialized pass,
    // after the artifact epoch committed: its failure never invalidates the
    // epoch and surfaces as warning diagnostics on the succeeded attempt.
    const packageDiagnostics = result.outcome === 'succeeded'
      ? (await this.#packageBuildService.build(prepared, invalidation)).diagnostics
      : Object.freeze([]);
    const diagnostics = freezeDiagnostics([...lintDiagnostics, ...result.diagnostics, ...packageDiagnostics]);
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
    const hasBuildInFlight = this.#currentBuild !== undefined;
    const startupBlockedBeforeBuild = !hasBuildInFlight &&
      this.#session === undefined && this.#startPromise !== undefined;
    if (startupBlockedBeforeBuild) {
      this.#cancelStartup();
      void this.#releaseWatcher().catch(() => undefined);
      void this.#releaseLock().catch(() => undefined);
    }
    const inFlight = this.#currentBuild ?? this.#startPromise;
    const buildResult = await Promise.allSettled([inFlight ?? Promise.resolve()]);
    const resources: readonly Readonly<{
      readonly close: () => Promise<unknown>;
      readonly resource: DevCoordinatorCloseFailure['resource'];
    }>[] = [
      { close: () => this.#releaseWatcher(), resource: 'watcher' },
      { close: () => this.#diagnosticService.close(), resource: 'diagnostics' },
      { close: () => this.#releaseLock(), resource: 'lock' },
    ];
    const results = await Promise.allSettled(resources.map(async ({ close }) => close()));
    const failures = [
      ...buildResult.flatMap((result): readonly DevCoordinatorCloseFailure[] =>
        hasBuildInFlight && result.status === 'rejected'
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
