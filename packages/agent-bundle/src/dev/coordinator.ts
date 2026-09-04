import { Cause, Deferred, Effect, Exit, Result, Semaphore } from 'effect';
import { resolve } from 'node:path';

import { freezeDiagnostics, hasErrors } from '../core/diagnostics.ts';
import { runPromise, runSync } from '../effect/boundary.ts';
import { liftPromise, liftTry } from '../effect/lift.ts';
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
  readonly #onPreparedProject: ((prepared: PreparedProject) => Promise<void>) | undefined;
  readonly #packageBuildService: DevPackageBuilder;
  readonly #prepareCommand: 'build' | 'dev';
  readonly #projectService: ProjectPreparer;
  readonly #root: string;
  /** Serializes build passes; admission below guarantees one holder, the permit makes the invariant structural. */
  readonly #buildPermit: Semaphore.Semaphore = runSync(Semaphore.make(1));
  readonly #startRebuildToken = Symbol('DevCoordinator initial rebuild');
  /**
   * Fails once `close()` cancels a startup that is still blocked before its
   * first build; every startup step races against it (`#awaitStartup`).
   */
  readonly #startupClosed: Deferred.Deferred<never, Error> = runSync(Deferred.make<never, Error>());
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
    this.#startPromise = runPromise(this.#startEffect());
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

  /**
   * Startup as one Effect: every blocking step races the close signal
   * (`#awaitStartup`), and a failed startup releases whatever it acquired —
   * watcher and lock concurrently, outcomes ignored — before re-raising the
   * original error. Sync steps are lifted so a throw is a typed failure the
   * cleanup handler sees, never a defect that skips it.
   */
  #startEffect(): Effect.Effect<DevSession, unknown> {
    const startup = Effect.gen({ self: this }, function* (this: DevCoordinator) {
      yield* this.#acquireStartupLock();
      yield* this.#assertOpenEffect();
      yield* this.#awaitStartup(() => this.#epochStore.recoverStaging());
      yield* this.#assertOpenEffect();
      this.#activeEpoch = yield* this.#awaitStartup(() => this.#epochStore.readActiveEpoch());
      yield* this.#assertOpenEffect();
      const projectIgnoreRules = yield* this.#awaitStartup(() => readProjectIgnoreRules(this.#root));
      yield* this.#assertOpenEffect();
      const watcher = yield* liftTry(() => this.#createWatcher({
        ignoredPaths: this.#ignoredPaths,
        isIgnored: (source) => isProjectPathIgnored(projectIgnoreRules, this.#root, source),
        now: this.#now,
        onInvalidation: async (invalidation) => this.rebuild(invalidation),
        outputPaths: this.#outputPaths,
        root: this.#root,
      }));
      this.#watcher = watcher;
      yield* this.#awaitStartup(() => watcher.ready?.() ?? Promise.resolve());
      yield* this.#assertOpenEffect();
      yield* liftPromise(() => this.#rebuild(nowInvalidation(this.#now, 'initial', []), this.#startRebuildToken));
      const session: DevSession = Object.freeze({
        close: () => this.close(),
        status: () => this.status(),
      });
      this.#session = session;
      return session;
    });
    return startup.pipe(Effect.catch((error) => Effect.gen({ self: this }, function* (this: DevCoordinator) {
      yield* Effect.forEach(
        [() => this.#releaseWatcher(), () => this.#releaseLock()],
        (release) => Effect.exit(liftPromise(release)),
        { concurrency: 'unbounded' },
      );
      this.#watcher = undefined;
      this.#lock = undefined;
      return yield* Effect.fail(error);
    })));
  }

  #assertOpenEffect(): Effect.Effect<void, Error> {
    return Effect.suspend(() => this.#closing
      ? Effect.fail(new Error('DevCoordinator is closed.'))
      : Effect.void);
  }

  /**
   * A lock that resolves after startup was cancelled is released, not kept:
   * the acquisition is started once, raced against close, and drained when
   * it loses.
   */
  #acquireStartupLock(): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const acquisition = this.#acquireLock({ projectRoot: this.#root });
      return this.#awaitStartup(() => acquisition).pipe(
        Effect.flatMap((lock) => Effect.sync(() => {
          this.#lock = lock;
        })),
        Effect.tapError(() => Effect.sync(() => {
          void acquisition.then(
            (lock) => lock.close().catch(() => undefined),
            () => undefined,
          );
        })),
      );
    });
  }

  /** One startup step raced against `close()`; the loser is interrupted. */
  #awaitStartup<T>(operation: () => Promise<T>): Effect.Effect<T, unknown> {
    return Effect.raceFirst(liftPromise(operation), Deferred.await(this.#startupClosed));
  }

  #cancelStartup(): void {
    runSync(Deferred.fail(this.#startupClosed, new Error('DevCoordinator is closed.')));
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
   * promise settles.
   */
  #startBuild(invalidation: Invalidation): Promise<ArtifactEpochResult> {
    const current = runPromise(this.#buildPermit.withPermit(
      this.#performBuild(invalidation).pipe(
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
    const previousAttempt = this.#status.build.lastAttempt;
    this.#status = freezeProjectStatus({
      artifact: artifactStatusFor(this.#activeEpoch, source.revision),
      build: {
        activeAttempt: running,
        ...(previousAttempt === undefined ? {} : { lastAttempt: previousAttempt }),
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

  /**
   * One serialized build pass. Only the leaf I/O is lifted — prepare, the
   * prepared-project hook, lint, the artifact build, and the package build —
   * and each phase's failure is exposed as a `Result` so it completes the
   * attempt as a failed build result. Status and event bookkeeping stays
   * synchronous inside the fiber; the program itself never fails.
   */
  readonly #performBuild = Effect.fnUntraced(function* (
    this: DevCoordinator,
    invalidation: Invalidation,
  ): Effect.fn.Return<ArtifactEpochResult, unknown> {
    const initial = this.#nextPreparedProject;
    this.#nextPreparedProject = undefined;
    const preparation = yield* Effect.result(initial === undefined
      ? liftPromise(() => this.#projectService.prepare(this.#prepareCommand))
      : Effect.succeed(initial));
    if (Result.isFailure(preparation)) {
      const source = withDiagnostics(this.#status.source, [phaseDiagnostic('prepare', preparation.failure)]);
      return this.#completeFailure(this.#beginBuild(invalidation, source), source, source.diagnostics);
    }
    const prepared = preparation.success;

    this.#watcher?.addOutputPaths?.([prepared.artifactDistPath, ...prepared.outputRoots]);
    const running = this.#beginBuild(invalidation, prepared.source);
    const onPrepared = this.#onPreparedProject;
    const hook = yield* Effect.result(onPrepared === undefined
      ? Effect.void
      : liftPromise(() => onPrepared(prepared)));
    if (Result.isFailure(hook)) {
      const source = withDiagnostics(prepared.source, [phaseDiagnostic('prepare', hook.failure)]);
      return this.#completeFailure(running, source, source.diagnostics);
    }
    const lint = yield* Effect.result(liftPromise(() => this.#diagnosticService.lint(invalidation.paths)));
    if (Result.isFailure(lint)) {
      const source = withDiagnostics(prepared.source, [phaseDiagnostic('lint', lint.failure)]);
      return this.#completeFailure(running, source, source.diagnostics);
    }
    const lintDiagnostics: readonly Diagnostic[] = freezeDiagnostics(lint.success.diagnostics);

    const source = withDiagnostics(prepared.source, lintDiagnostics);
    if (hasErrors(lintDiagnostics)) {
      return this.#completeFailure(running, source, source.diagnostics);
    }

    const built = yield* Effect.result(liftPromise(() => this.#artifactService.build(prepared)));
    if (Result.isFailure(built)) {
      return this.#completeFailure(running, source, [
        ...source.diagnostics,
        phaseDiagnostic('artifact', built.failure),
      ]);
    }
    const result = built.success;
    // The package build (bin/lib) rebuilds inside the same serialized pass,
    // after the artifact epoch committed: its failure never invalidates the
    // epoch and surfaces as warning diagnostics on the succeeded attempt.
    const packageDiagnostics = result.outcome === 'succeeded'
      ? (yield* liftPromise(() => this.#packageBuildService.build(prepared, invalidation))).diagnostics
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
  });

  /**
   * Shutdown as one Effect: wait for the in-flight build or startup to
   * settle, then release every resource concurrently, capturing each `Exit`
   * so no failure short-circuits another release. Every failure is reported
   * together as `DevCoordinatorCloseError` (build first, then resources in
   * declaration order).
   */
  #close(): Promise<void> {
    const hasBuildInFlight = this.#currentBuild !== undefined;
    const startupBlockedBeforeBuild = !hasBuildInFlight &&
      this.#session === undefined && this.#startPromise !== undefined;
    if (startupBlockedBeforeBuild) {
      this.#cancelStartup();
      void this.#releaseWatcher().catch(() => undefined);
      void this.#releaseLock().catch(() => undefined);
    }
    const inFlight: Promise<unknown> = this.#currentBuild ?? this.#startPromise ?? Promise.resolve();
    const resources: readonly Readonly<{
      readonly close: () => Promise<unknown>;
      readonly resource: DevCoordinatorCloseFailure['resource'];
    }>[] = [
      { close: () => this.#releaseWatcher(), resource: 'watcher' },
      { close: () => this.#diagnosticService.close(), resource: 'diagnostics' },
      { close: () => this.#releaseLock(), resource: 'lock' },
    ];
    const closeFailure = (
      exit: Exit.Exit<unknown, unknown>,
      resource: DevCoordinatorCloseFailure['resource'],
    ): readonly DevCoordinatorCloseFailure[] =>
      Exit.isFailure(exit) ? [Object.freeze({ error: Cause.squash(exit.cause), resource })] : [];
    return runPromise(Effect.gen(function* () {
      const buildExit = yield* Effect.exit(liftPromise(() => inFlight));
      const releases = yield* Effect.forEach(
        resources,
        ({ close }) => Effect.exit(liftPromise(close)),
        { concurrency: 'unbounded' },
      );
      const failures = [
        ...(hasBuildInFlight ? closeFailure(buildExit, 'build') : []),
        ...releases.flatMap((exit, index) => closeFailure(exit, resources[index]!.resource)),
      ];
      if (failures.length > 0) return yield* Effect.fail(new DevCoordinatorCloseError(failures));
    }));
  }
}
