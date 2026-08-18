import { rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

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
  type EvalRunRecord,
  type EvalTrialRecord,
} from '../eval/run-store.ts';
import type { EvalAssertionKind, EvalCase, EvalInvocation } from '../eval/types.ts';
import type { DevLogKindFor, DevLogSink } from './dev-log-service.ts';

export type EvalServiceErrorCode =
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
const safeRunId = /^[a-z0-9][a-z0-9._-]*$/u;

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

/**
 * The one eval path the CLI, the programmatic API, and the workbench browser all
 * use. It resolves every filesystem location itself: a caller names
 * suites, cases, and a trial count, never a run directory, artifact copy, or command.
 */
export class EvalService {
  readonly #configPath: string | undefined;
  readonly #mode: string;
  readonly #logger: DevLogSink | undefined;
  readonly #native: EvalServiceNativeOptions | undefined;
  readonly #now: () => Date;
  readonly #projectRoot: string;
  readonly #registry: TargetRegistry;
  readonly #targets: readonly string[] | undefined;

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
      await writer.appendEvent({
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
        await writer.appendEvent({
          kind: 'trial.completed',
          payload: { caseId: trial.caseId, id: trial.id, outcome: trial.outcome },
        });
        if (wasCancelled()) cancelled = true;
      }
      if (cancelled || completed.length !== planned.length) {
        await writer.appendEvent({
          kind: 'run.cancelled',
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
}
