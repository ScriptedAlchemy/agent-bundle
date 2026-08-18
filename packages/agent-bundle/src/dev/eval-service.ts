import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { loadConfig } from '../config/load.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import { aggregateEvalTrials, summarizeEvalRun, type EvalCaseAggregate } from '../eval/aggregate.ts';
import { compareEvalRuns, type EvalComparison } from '../eval/compare.ts';
import { prepareEvalArtifact, type PreparedEvalArtifact } from '../eval/artifact.ts';
import { normalizeEvalConfig, type NormalizedEvalConfig } from '../eval/config.ts';
import { runClaudeTrial } from '../eval/claude-harness.ts';
import { runCodexEvalTrial, type CodexCommandRunner } from '../eval/codex-harness.ts';
import { discoverEvalSuites, type DiscoveredEvalSuite } from '../eval/discovery.ts';
import { EvalHarnessError } from '../eval/errors.ts';
import { planEvalFixture, type EvalFixturePlan } from '../eval/fixtures.ts';
import { createEvalHarness, runDeterministicTrial, type EvalHarness } from '../eval/harness.ts';
import type { NativeClaudeProcessRunner } from '../host-contracts/native-claude-contract.ts';
import {
  createEvalRun,
  listEvalRuns,
  mintRunId,
  readEvalRun,
  readEvalRunEvents,
  readEvalTrials,
  type EvalRunEvent,
  type EvalRunRecord,
  type EvalTrialRecord,
} from '../eval/run-store.ts';
import type { EvalAssertionKind, EvalCase, EvalInvocation } from '../eval/types.ts';
import type { DevLogKindFor, DevLogSink } from './dev-log-service.ts';

export type EvalServiceErrorCode =
  | 'EVAL_ARTIFACT_NOT_FOUND'
  | 'EVAL_ARTIFACT_UNAVAILABLE'
  | 'EVAL_EVENTS_CURSOR_INVALID'
  | 'EVAL_HARNESS_UNSUPPORTED'
  | 'EVAL_RUN_NOT_FOUND'
  | 'EVAL_SELECTION_EMPTY'
  | 'EVAL_SEMANTIC_GRADER_UNSUPPORTED'
  | 'EVAL_TARGET_MISSING'
  | 'EVAL_TRIALS_INVALID';

/** Every refusal a caller can act on without reading the eval internals. */
export class EvalServiceError extends Error {
  readonly code: EvalServiceErrorCode;

  constructor(code: EvalServiceErrorCode, message: string) {
    super(message);
    this.name = 'EvalServiceError';
    this.code = code;
  }
}

export interface EvalAssertionSummary {
  readonly id: string;
  readonly kind: EvalAssertionKind;
}

export interface EvalCaseSummary {
  readonly assertions: readonly EvalAssertionSummary[];
  readonly digest: string;
  readonly hosts: readonly string[];
  readonly id: string;
  readonly invocation: EvalInvocation;
  readonly prompt: string;
  readonly trials: number;
}

export interface EvalSuiteSummary {
  readonly cases: readonly EvalCaseSummary[];
  readonly digest: string;
  readonly name: string;
  /** Project-relative so no caller, browser included, learns an absolute location. */
  readonly sourcePath: string;
}

export interface EvalSuiteListing {
  readonly diagnostics: readonly Diagnostic[];
  readonly suites: readonly EvalSuiteSummary[];
}

export interface EvalRunSelection {
  readonly caseIds?: readonly string[];
  readonly suites?: readonly string[];
}

export interface EvalRunRequest extends EvalRunSelection {
  /** An already-built artifact root. Only the API and CLI may name one; the browser never does. */
  readonly artifact?: string;
  readonly harness?: string;
  readonly signal?: AbortSignal;
  readonly trials?: number;
}

export interface EvalRunResult {
  readonly aggregates: readonly EvalCaseAggregate[];
  readonly diagnostics: readonly Diagnostic[];
  readonly run: EvalRunRecord;
  readonly trials: readonly EvalTrialRecord[];
}

/** A durable event replay never includes an incomplete append record. */
export interface EvalRunEventsReplay {
  readonly cursor: Readonly<{ readonly afterSequence: number }>;
  readonly events: readonly EvalRunEvent[];
  /** True when the event file ends with an incomplete record that was not replayed. */
  readonly incompleteTrailingRecord?: true;
}

/** A run-pinned raw-evidence descriptor. Call close when its response stream ends. */
export interface EvalArtifactReader {
  readonly digest: string;
  readonly filename: string;
  readonly ref: string;
  readonly size: number;
  close(): Promise<void>;
  read(start?: number, end?: number): Readable;
}

/** A replay snapshot followed by durable, ordered events published after its cursor. */
export interface EvalEventSubscription {
  readonly replay: EvalRunEventsReplay;
  activate(listener: (event: EvalRunEvent) => void): void;
  close(): void;
}

export interface EvalServiceOptions {
  readonly configPath?: string;
  readonly mode?: string;
  /** Optional non-throwing producer-wide diagnostics sink. */
  readonly logger?: DevLogSink;
  /** Native CLI injection is deliberately limited to test runners and their child environment. */
  readonly native?: EvalServiceNativeOptions;
  /** Injectable only to make run identity deterministic in tests. */
  readonly now?: () => Date;
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
  readonly targets?: readonly string[];
}

export interface EvalServiceNativeOptions {
  readonly claudeRun?: NativeClaudeProcessRunner;
  readonly codexRun?: CodexCommandRunner;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

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

const maximumTrials = 100;
const maximumArtifactBytes = 8 * 1024 * 1024;
const safeRunId = /^[a-z0-9][a-z0-9._-]*$/u;
const safeArtifactSegment = /^[a-z0-9][a-z0-9._-]*$/iu;

const serviceError = (code: EvalServiceErrorCode, message: string): EvalServiceError =>
  new EvalServiceError(code, message);

const projectRelative = (projectRoot: string, path: string): string =>
  relative(projectRoot, path).replaceAll('\\', '/');

/** Persist artifact identity without leaking or trusting an absolute host path. */
const storedArtifactBinding = (
  projectRoot: string,
  runDirectory: string,
  artifact: PreparedEvalArtifact,
) => {
  const base = artifact.binding.source === 'run-owned' ? runDirectory : projectRoot;
  const manifestPath = projectRelative(base, artifact.binding.manifestPath);
  const storedManifestPath = manifestPath !== '..' && !manifestPath.startsWith('../')
    ? manifestPath
    : `external/${digest({ targetDigests: artifact.binding.targetDigests })}.json`;
  return Object.freeze({
    ...artifact.binding,
    manifestPath: storedManifestPath,
  });
};

const caseSummary = (evalCase: EvalCase): EvalCaseSummary => Object.freeze({
  assertions: Object.freeze(evalCase.assertions.map((assertion) =>
    Object.freeze({ id: assertion.id, kind: assertion.kind }))),
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

class PendingEvalEventSubscription implements EvalEventSubscription {
  #closed = false;
  #listener: ((event: EvalRunEvent) => void) | undefined;
  readonly #onClose: () => void;
  #queued: EvalRunEvent[] = [];
  #replay: EvalRunEventsReplay | undefined;

  constructor(onClose: () => void) {
    this.#onClose = onClose;
  }

  get replay(): EvalRunEventsReplay {
    if (this.#replay === undefined) throw new Error('Eval event subscription has not finished replaying.');
    return this.#replay;
  }

  bind(replay: EvalRunEventsReplay): void {
    this.#replay = replay;
    this.#queued = this.#queued.filter((event) => event.sequence > replay.cursor.afterSequence);
  }

  publish(event: EvalRunEvent): void {
    if (this.#closed) return;
    const listener = this.#listener;
    if (listener === undefined) this.#queued.push(event);
    else listener(event);
  }

  activate(listener: (event: EvalRunEvent) => void): void {
    if (this.#closed || this.#listener !== undefined) return;
    this.#listener = listener;
    const queued = this.#queued;
    this.#queued = [];
    for (const event of queued) listener(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listener = undefined;
    this.#queued = [];
    this.#onClose();
  }
}

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path.length === 0 || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

const artifactSegments = (value: unknown): readonly string[] | undefined => {
  if (typeof value !== 'string' || /%(?:2f|5c)/iu.test(value) || value.includes('\\') || value.includes('\0')) {
    return undefined;
  }
  const segments = value.split('/');
  if (
    segments.length < 2 || segments[0] !== 'artifacts' ||
    segments.some((segment) => !safeArtifactSegment.test(segment))
  ) return undefined;
  return Object.freeze(segments);
};

const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const assertNoSymlinkedArtifactPath = async (projectRoot: string, target: string): Promise<void> => {
  const root = resolve(projectRoot);
  const resolvedTarget = resolve(target);
  if (!isWithin(root, resolvedTarget)) throw new Error('Raw evidence path escaped the project.');
  const segments = relative(root, resolvedTarget).split(/[/\\]/u);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || index < segments.length - 1 && !entry.isDirectory()) {
      throw new Error('Raw evidence path must contain only real directories and a real file.');
    }
  }
};

class OpenedEvalArtifact implements EvalArtifactReader {
  readonly digest: string;
  readonly filename: string;
  readonly ref: string;
  readonly size: number;
  readonly #bytes: Buffer;
  readonly #onClose: () => void;
  #closePromise: Promise<void> | undefined;

  constructor(options: {
    readonly bytes: Buffer;
    readonly digest: string;
    readonly filename: string;
    readonly onClose: () => void;
    readonly ref: string;
    readonly size: number;
  }) {
    this.digest = options.digest;
    this.filename = options.filename;
    this.#bytes = options.bytes;
    this.#onClose = options.onClose;
    this.ref = options.ref;
    this.size = options.size;
  }

  read(start = 0, end = this.size - 1): Readable {
    if (this.#closePromise !== undefined) throw new Error('Raw evidence reader is closed.');
    if (this.size === 0 && start === 0 && end === -1) return Readable.from([]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= this.size) {
      throw new RangeError('Raw evidence read range is not valid.');
    }
    return Readable.from([Buffer.from(this.#bytes.subarray(start, end + 1))]);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = Promise.resolve().then(async () => {
      this.#onClose();
    });
    return this.#closePromise;
  }
}

/**
 * The one eval path the CLI, the programmatic API, and the workbench browser all
 * use. It resolves every filesystem location itself: a caller names
 * suites, cases, and a trial count, never a run directory, artifact copy, or command.
 */
export class EvalService {
  readonly #artifactReaders = new Set<OpenedEvalArtifact>();
  readonly #configPath: string | undefined;
  readonly #mode: string;
  readonly #logger: DevLogSink | undefined;
  readonly #native: EvalServiceNativeOptions | undefined;
  readonly #now: () => Date;
  readonly #projectRoot: string;
  readonly #registry: TargetRegistry;
  readonly #targets: readonly string[] | undefined;
  readonly #eventSubscriptions = new Map<string, Set<PendingEvalEventSubscription>>();
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
    for (const id of ids) records.push(await readEvalRun(this.#runDirectory(config, id)));
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
      const results = await Promise.allSettled([...this.#artifactReaders].map(async (reader) => reader.close()));
      this.#artifactReaders.clear();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((failure) => failure.reason), 'Eval evidence readers could not close.');
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

  async run(request: EvalRunRequest): Promise<EvalRunResult> {
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
      artifact: storedArtifactBinding(this.#projectRoot, directory, artifact),
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
      const completed: EvalTrialRecord[] = [];
      const wasCancelled = (): boolean => request.signal?.aborted === true;
      let cancelled = wasCancelled();
      for (const plan of planned) {
        if (wasCancelled()) {
          cancelled = true;
          break;
        }
        const trial = await this.#runTrial({
          artifact,
          config,
          directory,
          harness,
          plan,
          signal: request.signal,
          writer,
        });
        completed.push(trial);
        await this.#appendEvent(writer, runId, {
          kind: 'trial.completed',
          payload: { caseId: trial.caseId, id: trial.id, outcome: trial.outcome },
        });
        if (wasCancelled()) cancelled = true;
      }
      if (cancelled || completed.length !== planned.length) {
        await this.#appendEvent(writer, runId, {
          kind: 'run.cancelled',
          payload: { completed: completed.length, planned: planned.length },
        });
      } else {
        await this.#appendEvent(writer, runId, {
          kind: 'run.completed',
          payload: { completed: completed.length, planned: planned.length },
        });
      }
      const aggregates = aggregateEvalTrials(completed);
      const result = Object.freeze({
        aggregates,
        diagnostics: config.diagnostics,
        run: await writer.finish(summarizeEvalRun(aggregates)),
        trials: Object.freeze(completed),
      });
      this.#log('eval.run.completed', 'info', 'Eval run completed.', runId, {
        aggregates: result.aggregates,
        trials: result.trials.length,
      });
      return result;
    } catch (error) {
      await this.#appendEvent(writer, runId, { kind: 'run.failed', payload: {} }).catch(() => undefined);
      this.#log('eval.run.failed', 'error', 'Eval run failed.', runId, {
        failure: 'unavailable',
      });
      throw error;
    } finally {
      await writer.close();
    }
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
        catch { subscription.close(); }
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
    const artifactRoot = join(directory, 'artifacts');
    const target = join(directory, ...segments);
    await assertNoSymlinkedArtifactPath(this.#projectRoot, target);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumArtifactBytes) {
      throw new Error('Raw evidence file metadata is not safe.');
    }
    const [physicalRoot, physicalTarget] = await Promise.all([realpath(artifactRoot), realpath(target)]);
    if (!isWithin(physicalRoot, physicalTarget)) throw new Error('Raw evidence file escaped its run artifacts directory.');
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [after, descriptor] = await Promise.all([lstat(target), file.stat()]);
      if (
        !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size > maximumArtifactBytes ||
        !descriptor.isFile() || descriptor.nlink !== 1 || descriptor.size > maximumArtifactBytes ||
        !sameFile(before, descriptor) || !sameFile(after, descriptor)
      ) {
        throw new Error('Raw evidence file changed while opening.');
      }
      const bytes = Buffer.alloc(Math.min(descriptor.size, maximumArtifactBytes) + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const final = await file.stat();
      if (!sameFile(descriptor, final) || final.size !== descriptor.size || bytesRead !== descriptor.size || bytesRead > maximumArtifactBytes) {
        throw new Error('Raw evidence file changed while hashing.');
      }
      const snapshot = Buffer.from(bytes.subarray(0, bytesRead));
      const digest = createHash('sha256').update(snapshot).digest('hex');
      await file.close();
      const reader = new OpenedEvalArtifact({
        bytes: snapshot,
        digest,
        filename: basename(ref),
        onClose: () => this.#artifactReaders.delete(reader),
        ref,
        size: descriptor.size,
      });
      this.#artifactReaders.add(reader);
      if (this.#closePromise !== undefined) {
        await reader.close();
        throw serviceError('EVAL_ARTIFACT_UNAVAILABLE', 'Recorded raw evidence is not available.');
      }
      return reader;
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }
}
