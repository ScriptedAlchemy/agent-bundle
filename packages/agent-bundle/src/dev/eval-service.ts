import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { mapConcurrent } from '../core/async.ts';
import { loadConfig } from '../config/load.ts';
import { aggregateEvalTrials, summarizeEvalRun } from '../eval/aggregate.ts';
import { compareEvalRuns, type EvalComparison } from '../eval/compare.ts';
import { prepareEvalArtifact, type PreparedEvalArtifact } from '../eval/artifact.ts';
import { normalizeEvalConfig, type NormalizedEvalConfig } from '../eval/config.ts';
import { runClaudeTrial } from '../eval/claude-harness.ts';
import { runCodexEvalTrial } from '../eval/codex-harness.ts';
import { discoverEvalSuites, type DiscoveredEvalSuite } from '../eval/discovery.ts';
import { EvalHarnessError } from '../eval/errors.ts';
import { planEvalFixture, type EvalFixturePlan } from '../eval/fixtures.ts';
import { createEvalHarness, runDeterministicTrial, type EvalHarness } from '../eval/harness.ts';
import {
  createEvalRun,
  EvalRunEventDurabilityError,
  EvalRunEventWriteUncertainError,
  listEvalRuns,
  mintRunId,
  readEvalRun,
  readEvalRunEvents,
  readEvalTrials,
  type EvalArtifactBinding,
  type EvalRunEvent,
  type EvalRunRecord,
  type EvalTrialRecord,
} from '../eval/run-store.ts';
import type { EvalCase } from '../eval/types.ts';
import type { DevLogKindFor, DevLogSink } from './dev-log-service.ts';
import { isErrno } from '../core/errors.ts';
import { PendingEvalEventSubscription } from './eval-event-subscription.ts';
import {
  artifactSegments,
  assertNoSymlinkedArtifactPath,
  openEvalArtifactSnapshot,
  type OpenedEvalArtifact,
} from './eval-artifact-reader.ts';

import {
  EvalServiceError,
  evalServiceError as serviceError,
} from './eval-service-error.ts';
import type {
  EvalArtifactReader,
  EvalCaseSummary,
  EvalEventSubscription,
  EvalRunAdmission,
  EvalRunEventsReplay,
  EvalRunRequest,
  EvalRunResult,
  EvalRunSelection,
  EvalServiceNativeOptions,
  EvalServiceOptions,
  EvalSuiteListing,
  EvalSuiteSummary,
} from './eval-service-types.ts';

export { EvalServiceError, type EvalServiceErrorCode } from './eval-service-error.ts';
export type * from './eval-service-types.ts';


interface SelectedEvalCase {
  readonly evalCase: EvalCase;
  readonly suite: string;
  readonly suiteDir: string;
}

interface PlannedEvalTrial {
  readonly evalCase: EvalCase;
  readonly fixturePlan: EvalFixturePlan;
  readonly host: string;
  readonly suiteDir: string;
  readonly trialIndex: number;
}

interface ActiveEvalRun {
  cancellation: Promise<void> | undefined;
  cancelled: boolean;
  readonly controller: AbortController;
  requestAbort: (() => void) | undefined;
  readonly requestSignal: AbortSignal | undefined;
  result: Promise<EvalRunResult> | undefined;
  readonly runId: string;
  terminal: 'finishing' | 'open' | 'persisted' | 'uncertain' | 'written';
  uncertainty: EvalRunEventWriteUncertainError | undefined;
  readonly writer: Awaited<ReturnType<typeof createEvalRun>>;
}

const maximumTrials = 100;
/** Background failures are surfaced once at close; retain a bounded window so long-lived services cannot grow without limit. */
const maximumRetainedBackgroundFailures = 256;
const safeRunId = /^[a-z0-9][a-z0-9._-]*$/u;

const projectRelative = (projectRoot: string, path: string): string =>
  relative(projectRoot, path).replaceAll('\\', '/');

const persistedArtifactBinding = (
  projectRoot: string,
  runDirectory: string,
  binding: EvalArtifactBinding,
): EvalArtifactBinding => {
  const base = binding.source === 'run-owned' ? runDirectory : projectRoot;
  const manifestPath = relative(base, binding.manifestPath);
  if (
    manifestPath.length === 0 ||
    isAbsolute(manifestPath) ||
    manifestPath === '..' ||
    manifestPath.startsWith(`..${sep}`)
  ) {
    throw serviceError(
      'EVAL_ARTIFACT_OUTSIDE_PROJECT',
      'The evaluated artifact must be inside the project so its durable run record never exposes an absolute path.',
    );
  }
  return Object.freeze({
    manifestPath: manifestPath.replaceAll('\\', '/'),
    source: binding.source,
    targetDigests: binding.targetDigests,
  });
};

const caseSummary = (evalCase: EvalCase): EvalCaseSummary => Object.freeze({
  assertions: Object.freeze(evalCase.assertions.map((assertion) =>
    Object.freeze({
      id: assertion.id,
      kind: assertion.kind,
      ...('skill' in assertion && assertion.skill !== undefined ? { skill: assertion.skill } : {}),
    }))),
  digest: evalCase.digest,
  hosts: Object.freeze(Object.keys(evalCase.hosts).sort((left, right) => left.localeCompare(right))),
  id: evalCase.id,
  invocation: evalCase.invocation,
  prompt: evalCase.prompt,
  trials: evalCase.trials,
});

const suiteSummary = (projectRoot: string, discovered: DiscoveredEvalSuite): EvalSuiteSummary => Object.freeze({
  cases: Object.freeze(discovered.suite.cases.map(caseSummary)),
  digest: discovered.suite.digest,
  name: discovered.suite.name,
  sourcePath: projectRelative(projectRoot, discovered.sourcePath),
});

const selectEvalCases = (
  discovered: readonly DiscoveredEvalSuite[],
  selection: EvalRunSelection,
): readonly SelectedEvalCase[] => Object.freeze(discovered
  .filter((entry) => selection.suites === undefined || selection.suites.includes(entry.suite.name))
  .flatMap((entry) => entry.suite.cases
    .filter((evalCase) => selection.caseIds === undefined || selection.caseIds.includes(evalCase.id))
    .map((evalCase): SelectedEvalCase => Object.freeze({
      evalCase,
      suite: entry.suite.name,
      suiteDir: dirname(entry.sourcePath),
    }))));

const missingArtifactTargets = (
  planned: readonly PlannedEvalTrial[],
  artifact: PreparedEvalArtifact,
): readonly string[] => Object.freeze([...new Set(planned
  .filter((trial) => artifact.binding.targetDigests[trial.host] === undefined)
  .map((trial) => `${trial.evalCase.id}/${trial.host}`))].sort((left, right) => left.localeCompare(right)));

const requestedTrials = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumTrials) {
    throw serviceError(
      'EVAL_TRIALS_INVALID',
      `Requested eval trial count must be an integer between 1 and ${maximumTrials}.`,
    );
  }
  return value;
};

const requestedAfterSequence = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw serviceError('EVAL_EVENTS_CURSOR_INVALID', 'Eval event cursor must be a non-negative safe integer.');
  }
  return value;
};

/**
 * The one terminal-failure transition for both the trial-loop failure and the
 * terminal-append failure: a durability error whose failed event was terminal
 * proves that event reached the log ('written'), while an uncertain write
 * leaves the log state unknowable ('uncertain'). Any other failure leaves the
 * terminal state untouched so #execute still appends a terminal event.
 */
const classifyTerminalFailure = (active: ActiveEvalRun, error: unknown): void => {
  if (
    error instanceof EvalRunEventDurabilityError
    && (error.event.kind === 'run.cancelled' || error.event.kind === 'run.completed' || error.event.kind === 'run.failed')
  ) {
    active.terminal = 'written';
  }
  if (error instanceof EvalRunEventWriteUncertainError) {
    active.terminal = 'uncertain';
    active.uncertainty = error;
  }
};



/**
 * The one eval path the CLI, the programmatic API, and the workbench browser all
 * use. It resolves every filesystem location itself: a caller names
 * suites, cases, and a trial count, never a run directory, artifact copy, or command.
 */
export class EvalService {
  readonly #artifactReaders = new Set<OpenedEvalArtifact>();
  readonly #backgroundFailures = new Set<unknown>();
  readonly #configPath: string | undefined;
  readonly #mode: string;
  readonly #logger: DevLogSink | undefined;
  readonly #native: EvalServiceNativeOptions | undefined;
  readonly #now: () => Date;
  readonly #projectRoot: string;
  readonly #registry: TargetRegistry;
  readonly #targets: readonly string[] | undefined;
  readonly #eventSubscriptions = new Map<string, Set<PendingEvalEventSubscription>>();
  readonly #activeRuns = new Map<string, ActiveEvalRun>();
  readonly #startingRuns = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;

  constructor(options: EvalServiceOptions) {
    this.#configPath = options.configPath;
    this.#mode = options.mode ?? 'production';
    this.#logger = options.logger;
    this.#native = options.native;
    this.#now = options.now ?? (() => new Date());
    this.#projectRoot = resolve(options.projectRoot);
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#targets = options.targets;
  }

  async suites(): Promise<EvalSuiteListing> {
    const config = await this.#config();
    const discovered = await this.#discover(config);
    return Object.freeze({
      diagnostics: config.diagnostics,
      suites: Object.freeze(discovered.map((entry) => suiteSummary(this.#projectRoot, entry))),
    });
  }

  async list(): Promise<readonly EvalRunRecord[]> {
    const config = await this.#config();
    const ids = await listEvalRuns({ projectRoot: this.#projectRoot, runsDir: config.runsDir });
    const records: EvalRunRecord[] = [];
    await mapConcurrent(ids.map((id, index) => ({ id, index })), 16, async ({ id, index }) => {
      records[index] = await readEvalRun(this.#runDirectory(config, id));
    });
    return Object.freeze(records);
  }

  async read(runId: string): Promise<EvalRunResult> {
    if (!safeRunId.test(runId)) {
      throw serviceError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(runId)} is not a run identifier.`);
    }
    const config = await this.#config();
    const directory = this.#runDirectory(config, runId);
    const run = await readEvalRun(directory);
    await readEvalRunEvents(directory);
    const trials = await readEvalTrials(directory);
    return Object.freeze({
      aggregates: aggregateEvalTrials(trials),
      diagnostics: config.diagnostics,
      run,
      trials,
    });
  }

  async events(runId: string, afterSequence: number): Promise<EvalRunEventsReplay> {
    if (!safeRunId.test(runId)) {
      throw serviceError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(runId)} is not a run identifier.`);
    }
    const after = requestedAfterSequence(afterSequence);
    const config = await this.#config();
    const directory = this.#runDirectory(config, runId);
    await readEvalRun(directory);
    const persisted = await readEvalRunEvents(directory);
    const latest = persisted.events.at(-1)?.sequence ?? 0;
    if (after > latest) {
      throw serviceError('EVAL_EVENTS_CURSOR_INVALID', 'Eval event cursor is ahead of the durable event log.');
    }
    return Object.freeze({
      cursor: Object.freeze({ afterSequence: latest }),
      events: Object.freeze(persisted.events.filter((event) => event.sequence > after)),
      ...(persisted.incompleteTrailingRecord === undefined ? {} : { incompleteTrailingRecord: true as const }),
    });
  }

  async subscribeEvents(runId: string, afterSequence: number): Promise<EvalEventSubscription> {
    if (!safeRunId.test(runId)) {
      throw serviceError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(runId)} is not a run identifier.`);
    }
    const after = requestedAfterSequence(afterSequence);
    const subscriptions = this.#eventSubscriptions.get(runId) ?? new Set<PendingEvalEventSubscription>();
    const subscription = new PendingEvalEventSubscription(() => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.#eventSubscriptions.delete(runId);
    });
    subscriptions.add(subscription);
    this.#eventSubscriptions.set(runId, subscriptions);
    try {
      subscription.bind(await this.events(runId, after));
      return subscription;
    } catch (error) {
      subscription.close();
      throw error;
    }
  }

  async openArtifact(runId: string, artifactRef: string): Promise<EvalArtifactReader> {
    if (!safeRunId.test(runId)) {
      throw serviceError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(runId)} is not a run identifier.`);
    }
    if (this.#closePromise !== undefined) {
      throw serviceError('EVAL_ARTIFACT_UNAVAILABLE', 'Recorded raw evidence is not available.');
    }
    const config = await this.#config();
    const directory = this.#runDirectory(config, runId);
    let trials: readonly EvalTrialRecord[];
    try {
      await assertNoSymlinkedArtifactPath(this.#projectRoot, join(directory, 'run.json'));
      await readEvalRun(directory);
      trials = await readEvalTrials(directory);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw serviceError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(runId)} was not found.`);
      }
      throw serviceError('EVAL_ARTIFACT_UNAVAILABLE', 'Recorded raw evidence is not available.');
    }
    const segments = artifactSegments(artifactRef);
    if (segments === undefined || !trials.some((trial) => trial.rawArtifacts.includes(artifactRef))) {
      throw serviceError('EVAL_ARTIFACT_NOT_FOUND', 'Recorded raw evidence was not found.');
    }
    try {
      return await this.#openArtifact(directory, artifactRef, segments);
    } catch (error) {
      if (error instanceof EvalServiceError) throw error;
      throw serviceError('EVAL_ARTIFACT_UNAVAILABLE', 'Recorded raw evidence is not available.');
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(async () => {
      const starts = await Promise.allSettled([...this.#startingRuns]);
      const active = [...this.#activeRuns.values()];
      const results = await Promise.allSettled([
        ...[...this.#artifactReaders].map(async (reader) => reader.close()),
        ...active.map(async (run) => this.#requestCancellation(run)),
        ...active.flatMap((run) => run.result === undefined ? [] : [run.result]),
      ]);
      this.#artifactReaders.clear();
      const failures = [
        ...[...starts, ...results]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason),
        ...this.#backgroundFailures,
      ];
      if (failures.length > 0) {
        throw new AggregateError([...new Set(failures)], 'Eval service could not close.');
      }
    });
    return this.#closePromise;
  }

  /**
   * Alignment facets the run store does not persist yet stay unverified rather than
   * being asserted as aligned, so a delta never rests on an assumption.
   */
  async compare(baseRunId: string, candidateRunId: string): Promise<EvalComparison> {
    const [baseline, candidate] = await Promise.all([this.read(baseRunId), this.read(candidateRunId)]);
    return compareEvalRuns({
      baseline: { run: baseline.run, trials: baseline.trials },
      candidate: { run: candidate.run, trials: candidate.trials },
    });
  }

  start(request: EvalRunRequest): Promise<EvalRunAdmission> {
    if (this.#closePromise !== undefined) throw new Error('Eval service is closing.');
    const pending = Promise.withResolvers<void>();
    this.#startingRuns.add(pending.promise);
    return this.#admit(request).finally(() => {
      this.#startingRuns.delete(pending.promise);
      pending.resolve();
    });
  }

  async #admit(request: EvalRunRequest): Promise<EvalRunAdmission> {
    if (this.#closePromise !== undefined) throw new Error('Eval service is closing.');
    const harness = this.#harness(request.harness);
    const trials = requestedTrials(request.trials);
    const config = await this.#config();
    if (config.semanticGrader !== undefined && harness.kind !== 'native-claude') {
      throw serviceError(
        'EVAL_SEMANTIC_GRADER_UNSUPPORTED',
        'Configured semantic grading requires the native Claude eval harness.',
      );
    }
    const selected = selectEvalCases(await this.#discover(config), request);
    if (selected.length === 0) {
      throw serviceError(
        'EVAL_SELECTION_EMPTY',
        `No discovered eval suite or case matched ${JSON.stringify({
          ...(request.caseIds === undefined ? {} : { caseIds: [...request.caseIds] }),
          ...(request.suites === undefined ? {} : { suites: [...request.suites] }),
        })}.`,
      );
    }

    const planned = await this.#plan(selected, harness, trials);
    if (planned.length === 0) {
      throw serviceError(
        'EVAL_SELECTION_EMPTY',
        `No selected eval case has a host the ${JSON.stringify(harness.name)} harness can drive.`,
      );
    }
    const runId = mintRunId(this.#now());
    const directory = this.#runDirectory(config, runId);
    const artifact = await prepareEvalArtifact({
      ...(request.artifact === undefined ? {} : { artifact: request.artifact }),
      ...(this.#configPath === undefined ? {} : { configPath: this.#configPath }),
      projectRoot: this.#projectRoot,
      registry: this.#registry,
      runDirectory: directory,
      ...(this.#targets === undefined ? {} : { targets: this.#targets }),
    });
    const missing = missingArtifactTargets(planned, artifact);
    if (missing.length > 0) {
      // Nothing owns this directory yet, so the abandoned artifact copy is removed.
      await rm(directory, { force: true, recursive: true });
      throw serviceError(
        'EVAL_TARGET_MISSING',
        `The evaluated artifact has no target for ${JSON.stringify(missing)}. Build the pinned host targets before evaluating them.`,
      );
    }

    const writer = await createEvalRun({
      artifact: persistedArtifactBinding(this.#projectRoot, directory, artifact.binding),
      projectRoot: this.#projectRoot,
      provenance: Object.freeze({
        agentBundleVersion: artifact.manifest.producer.version,
        harness: harness.name,
        projectRevision: artifact.manifest.project.revision,
      }),
      runId,
      runsDir: config.runsDir,
    });
    try {
      await this.#appendEvent(writer, runId, {
        kind: 'run.started',
        payload: { cases: new Set(planned.map((trial) => trial.evalCase.id)).size, harness: harness.name, trials: planned.length },
      });
      this.#log('eval.run.started', 'info', 'Eval run started.', runId, {
        cases: new Set(planned.map((trial) => trial.evalCase.id)).size,
        harness: harness.name,
        trials: planned.length,
      });
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }

    const controller = new AbortController();
    const active: ActiveEvalRun = {
      cancellation: undefined,
      cancelled: false,
      controller,
      requestAbort: undefined,
      requestSignal: request.signal,
      result: undefined,
      runId,
      terminal: 'open',
      uncertainty: undefined,
      writer,
    };
    const result = Promise.withResolvers<EvalRunResult>();
    active.result = result.promise;
    this.#activeRuns.set(runId, active);
    if (request.signal !== undefined) {
      active.requestAbort = () => { void this.#requestCancellation(active).catch(() => undefined); };
      request.signal.addEventListener('abort', active.requestAbort, { once: true });
      if (request.signal.aborted) active.requestAbort();
    }
    void this.#execute(active, {
      artifact,
      config,
      directory,
      harness,
      planned,
    }).then(result.resolve, (error: unknown) => {
      if (this.#backgroundFailures.size < maximumRetainedBackgroundFailures) this.#backgroundFailures.add(error);
      result.reject(error);
    });
    void active.result.catch(() => undefined);
    return Object.freeze({ run: writer.record });
  }

  async run(request: EvalRunRequest): Promise<EvalRunResult> {
    const admission = await this.start(request);
    const active = this.#activeRuns.get(admission.run.id);
    return active?.result === undefined ? this.read(admission.run.id) : active.result;
  }

  async cancel(runId: string): Promise<boolean> {
    if (!safeRunId.test(runId)) {
      throw serviceError('EVAL_RUN_NOT_FOUND', `Eval run ${JSON.stringify(runId)} is not a run identifier.`);
    }
    const active = this.#activeRuns.get(runId);
    if (active !== undefined) {
      const requested = active.cancellation === undefined && active.terminal === 'open';
      if (requested) await this.#requestCancellation(active);
      if (active.result !== undefined) await active.result.catch(() => undefined);
      return requested;
    }
    await this.read(runId);
    return false;
  }

  async #execute(
    active: ActiveEvalRun,
    options: Readonly<{
      readonly artifact: PreparedEvalArtifact;
      readonly config: NormalizedEvalConfig;
      readonly directory: string;
      readonly harness: EvalHarness;
      readonly planned: readonly PlannedEvalTrial[];
    }>,
  ): Promise<EvalRunResult> {
    const completed: EvalTrialRecord[] = [];
    let executionFailure: unknown;
    let executionFailed = false;
    let finalizationAttempted = false;
    let result: EvalRunResult | undefined;
    try {
      for (const plan of options.planned) {
        if (active.cancelled || active.controller.signal.aborted) break;
        await this.#appendEvent(active.writer, active.runId, {
          kind: 'trial.started',
          payload: { caseId: plan.evalCase.id, host: plan.host, trialIndex: plan.trialIndex },
        });
        if (active.cancelled || active.controller.signal.aborted) {
          await this.#appendEvent(active.writer, active.runId, {
            kind: 'trial.cancelled',
            payload: { caseId: plan.evalCase.id, host: plan.host, trialIndex: plan.trialIndex },
          });
          break;
        }
        try {
          const trial = await this.#runTrial({
            artifact: options.artifact,
            config: options.config,
            directory: options.directory,
            harness: options.harness,
            plan,
            signal: active.controller.signal,
            writer: active.writer,
          });
          completed.push(trial);
          await this.#appendEvent(active.writer, active.runId, {
            kind: 'trial.completed',
            payload: { caseId: trial.caseId, id: trial.id, outcome: trial.outcome },
          });
        } catch (error) {
          if (error instanceof EvalRunEventWriteUncertainError) throw error;
          if (active.cancelled || active.controller.signal.aborted) {
            await this.#appendEvent(active.writer, active.runId, {
              kind: 'trial.cancelled',
              payload: { caseId: plan.evalCase.id, host: plan.host, trialIndex: plan.trialIndex },
            });
            break;
          }
          await this.#appendEvent(active.writer, active.runId, {
            kind: 'trial.failed',
            payload: { caseId: plan.evalCase.id, host: plan.host, trialIndex: plan.trialIndex },
          });
          throw error;
        }
      }
      if (active.terminal === 'uncertain') {
        throw active.uncertainty ?? new Error('Eval run event write became uncertain without a recorded failure.');
      }
      const cancelled = active.cancelled || active.controller.signal.aborted || completed.length !== options.planned.length;
      active.terminal = 'finishing';
      await this.#appendEvent(active.writer, active.runId, {
        kind: cancelled ? 'run.cancelled' : 'run.completed',
        payload: { completed: completed.length, planned: options.planned.length },
      });
      active.terminal = 'persisted';
      const aggregates = aggregateEvalTrials(completed);
      finalizationAttempted = true;
      const completedResult = Object.freeze({
        aggregates,
        diagnostics: options.config.diagnostics,
        run: await active.writer.finish(summarizeEvalRun(aggregates)),
        trials: Object.freeze(completed),
      });
      result = completedResult;
      this.#log('eval.run.completed', 'info', 'Eval run completed.', active.runId, {
        aggregates: completedResult.aggregates,
        trials: completedResult.trials.length,
      });
    } catch (error) {
      executionFailure = error;
      executionFailed = true;
      classifyTerminalFailure(active, error);
      if (active.terminal !== 'persisted' && active.terminal !== 'uncertain' && active.terminal !== 'written') {
        active.terminal = 'finishing';
        try {
          await this.#appendEvent(active.writer, active.runId, {
            kind: active.cancelled || active.controller.signal.aborted ? 'run.cancelled' : 'run.failed',
            payload: {},
          });
          active.terminal = 'persisted';
        } catch (terminalFailure) {
          classifyTerminalFailure(active, terminalFailure);
          executionFailure = new AggregateError([executionFailure, terminalFailure], 'Eval run execution and terminal persistence both failed.', { cause: executionFailure });
        }
      }
      if (!finalizationAttempted && active.terminal !== 'uncertain') {
        try {
          await active.writer.finish(summarizeEvalRun(aggregateEvalTrials(completed)));
        } catch (finalizationFailure) {
          executionFailure = new AggregateError([executionFailure, finalizationFailure], 'Eval run execution and finalization both failed.', { cause: executionFailure });
        }
      }
      this.#log('eval.run.failed', 'error', 'Eval run failed.', active.runId, { failure: 'unavailable' });
    }

    let cleanupFailure: unknown;
    let cleanupFailed = false;
    try {
      if (active.requestAbort !== undefined) active.requestSignal?.removeEventListener('abort', active.requestAbort);
      await active.writer.close();
    } catch (error) {
      cleanupFailure = error;
      cleanupFailed = true;
    } finally {
      if (this.#activeRuns.get(active.runId) === active) this.#activeRuns.delete(active.runId);
    }
    if (executionFailed && cleanupFailed) {
      throw new AggregateError([executionFailure, cleanupFailure], 'Eval run execution and cleanup failed.');
    }
    if (cleanupFailed) throw cleanupFailure;
    if (executionFailed) throw executionFailure;
    if (result === undefined) throw new Error('Eval run completed without a result.');
    return result;
  }

  #requestCancellation(active: ActiveEvalRun): Promise<void> {
    if (active.cancellation !== undefined) return active.cancellation;
    if (active.terminal !== 'open') return Promise.resolve();
    active.cancelled = true;
    const cancellation = this.#appendEvent(active.writer, active.runId, {
      kind: 'run.cancelling',
      payload: {},
    }).then(() => undefined).catch((error: unknown) => {
      if (error instanceof EvalRunEventWriteUncertainError) {
        active.terminal = 'uncertain';
        active.uncertainty = error;
      }
      throw error;
    });
    active.cancellation = cancellation;
    active.controller.abort();
    return cancellation;
  }

  #log(kind: DevLogKindFor<'eval'>, level: 'error' | 'info', summary: string, runId: string, details: unknown): void {
    try {
      this.#logger?.log({ context: { runId }, details, kind, level, producer: 'eval', summary });
    } catch { /* Diagnostics cannot affect durable eval execution. */ }
  }

  async #appendEvent(
    writer: Awaited<ReturnType<typeof createEvalRun>>,
    runId: string,
    event: { readonly kind: string; readonly payload: unknown },
  ): Promise<EvalRunEvent> {
    const persisted = await writer.appendEvent(event);
    const subscriptions = this.#eventSubscriptions.get(runId);
    if (subscriptions !== undefined) {
      for (const subscription of [...subscriptions]) {
        try { subscription.publish(persisted); }
        catch { subscription.close(); } // A throwing subscriber cannot stall durable append.
      }
    }
    return persisted;
  }

  async #config(): Promise<NormalizedEvalConfig> {
    const loaded = await loadConfig({
      command: 'eval',
      ...(this.#configPath === undefined ? {} : { configPath: this.#configPath }),
      mode: this.#mode,
      root: this.#projectRoot,
      ...(this.#targets === undefined ? {} : { targets: this.#targets }),
    });
    return normalizeEvalConfig(loaded.config.evals);
  }

  async #discover(config: NormalizedEvalConfig): Promise<readonly DiscoveredEvalSuite[]> {
    return discoverEvalSuites({ config, projectRoot: this.#projectRoot });
  }

  /** Fixtures are planned before any run directory exists, so a broken fixture never leaves one. */
  async #plan(
    selected: readonly SelectedEvalCase[],
    harness: EvalHarness,
    trials: number | undefined,
  ): Promise<readonly PlannedEvalTrial[]> {
    const planned: PlannedEvalTrial[] = [];
    for (const entry of selected) {
      const hosts = Object.keys(entry.evalCase.hosts)
        .filter((host) => this.#harnessDrivesHost(harness, host))
        .sort((left, right) => left.localeCompare(right));
      if (hosts.length === 0) continue;
      const fixturePlan = await planEvalFixture({ baseDir: entry.suiteDir, fixture: entry.evalCase.fixture });
      const count = trials ?? entry.evalCase.trials;
      for (const host of hosts) {
        for (let trialIndex = 0; trialIndex < count; trialIndex += 1) {
          planned.push(Object.freeze({
            evalCase: entry.evalCase,
            fixturePlan,
            host,
            suiteDir: entry.suiteDir,
            trialIndex,
          }));
        }
      }
    }
    return Object.freeze(planned);
  }

  #harnessDrivesHost(harness: EvalHarness, host: string): boolean {
    return harness.kind === 'deterministic'
      || harness.kind === 'native-claude' && host === 'claude'
      || harness.kind === 'native-codex' && host === 'codex';
  }

  async #runTrial(options: {
    readonly artifact: PreparedEvalArtifact;
    readonly config: NormalizedEvalConfig;
    readonly directory: string;
    readonly harness: EvalHarness;
    readonly plan: PlannedEvalTrial;
    readonly signal: AbortSignal | undefined;
    readonly writer: Awaited<ReturnType<typeof createEvalRun>>;
  }): Promise<EvalTrialRecord> {
    const shared = {
      artifact: options.artifact,
      evalCase: options.plan.evalCase,
      fixturePlan: options.plan.fixturePlan,
      host: options.plan.host,
      suiteDir: options.plan.suiteDir,
      trialIndex: options.plan.trialIndex,
      workspaceRoot: join(options.directory, 'workspaces'),
      writer: options.writer,
    };
    switch (options.harness.kind) {
      case 'deterministic':
        return runDeterministicTrial(shared);
      case 'native-claude':
        return runClaudeTrial({
          ...shared,
          ...(options.config.semanticGrader === undefined
            ? {}
            : { configuredSemanticGrader: options.config.semanticGrader }),
          ...(this.#native?.environment === undefined ? {} : { environment: this.#native.environment }),
          ...(this.#native?.claudeRun === undefined ? {} : { run: this.#native.claudeRun }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      case 'native-codex':
        return runCodexEvalTrial({
          ...shared,
          ...(this.#native?.environment === undefined ? {} : { environment: this.#native.environment }),
          ...(this.#native?.codexRun === undefined ? {} : { run: this.#native.codexRun }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }
  }

  /** The descriptor rejects unknown harnesses; this service dispatches every supported kind. */
  #harness(name: string | undefined): EvalHarness {
    let harness: EvalHarness;
    try {
      harness = createEvalHarness(name ?? 'deterministic');
    } catch (error) {
      if (error instanceof EvalHarnessError && error.code === 'EVAL_MODEL_BACKED_UNSUPPORTED') {
        throw serviceError('EVAL_HARNESS_UNSUPPORTED', error.message);
      }
      throw error;
    }
    return harness;
  }

  #runDirectory(config: NormalizedEvalConfig, runId: string): string {
    return join(this.#projectRoot, config.runsDir, runId);
  }

  async #openArtifact(
    directory: string,
    ref: string,
    segments: readonly string[],
  ): Promise<EvalArtifactReader> {
    const reader = await openEvalArtifactSnapshot({
      directory,
      onClose: (closed) => this.#artifactReaders.delete(closed),
      projectRoot: this.#projectRoot,
      ref,
      segments,
    });
    this.#artifactReaders.add(reader);
    if (this.#closePromise !== undefined) {
      await reader.close();
      throw serviceError('EVAL_ARTIFACT_UNAVAILABLE', 'Recorded raw evidence is not available.');
    }
    return reader;
  }
}
