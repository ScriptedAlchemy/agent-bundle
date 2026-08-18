import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { digest } from '../core/digest.ts';
import { loadConfig } from '../config/load.ts';
import type { PreparedEvalArtifact } from '../eval/artifact.ts';
import { runClaudeTrial } from '../eval/claude-harness.ts';
import { runCodexEvalTrial, type CodexCommandRunner } from '../eval/codex-harness.ts';
import { normalizeEvalConfig } from '../eval/config.ts';
import { redactEvalCredentialText } from '../eval/credentials.ts';
import { discoverEvalSuites, type DiscoveredEvalSuite } from '../eval/discovery.ts';
import { planEvalFixture, type EvalFixturePlan } from '../eval/fixtures.ts';
import type { EvalTrialRecord, EvalTrialWriter } from '../eval/run-store.ts';
import type { EvalCase } from '../eval/types.ts';
import type { NativeClaudeProcessRunner } from '../host-contracts/native-claude-contract.ts';
import type { PlaygroundEventInput, PlaygroundJsonObject } from '../services/playground-service.ts';
import type { ArtifactEpoch } from './types.ts';
import { workspaceDiff, type WorkspaceDiff } from '../eval/workspace-diff.ts';

export type NativePlaygroundHost = 'claude' | 'codex';

/** The exact browser shape accepted only after route-level strict decoding. */
export interface NativePlaygroundRequest {
  readonly caseId: string;
  readonly epochId?: string;
  readonly fixtureId: string;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
  readonly operation: 'native.prompt';
  readonly prompt: string;
  readonly target: string;
}

export interface NativePlaygroundEpochReference {
  close(): Promise<void>;
  readonly epoch: ArtifactEpoch;
  readonly root: string;
}

export interface NativePlaygroundCatalogItem {
  readonly id: string;
  readonly label: string;
}

export interface NativePlaygroundModelPin extends NativePlaygroundCatalogItem {
  readonly host: NativePlaygroundHost;
}

export interface NativePlaygroundCatalog {
  readonly cases: readonly NativePlaygroundCatalogItem[];
  readonly epochId: string;
  readonly fixtures: readonly NativePlaygroundCatalogItem[];
  readonly modelPins: readonly NativePlaygroundModelPin[];
}

export type NativePlaygroundProgress = 'codex.setup' | 'fixture.materialized' | 'host.started' | 'preflight';

export interface NativePlaygroundPrepared {
  readonly artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>;
  readonly epochId: string;
  readonly evalCase: EvalCase;
  readonly fixtureDigest: string;
  readonly fixturePlan: EvalFixturePlan;
  readonly host: NativePlaygroundHost;
  readonly prompt: string;
  readonly suiteDir: string;
  readonly target: string;
}

export interface NativePlaygroundRunResult {
  readonly events: readonly PlaygroundEventInput[];
  readonly response?: string;
  readonly status: 'failed' | 'passed';
  readonly workspace?: PlaygroundJsonObject;
}

export interface NativePlaygroundServiceOptions {
  /** Test seams preserve the same production discovery and harness contracts. */
  readonly discover?: (projectRoot: string) => Promise<readonly DiscoveredEvalSuite[]>;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly inspectArtifact?: (reference: NativePlaygroundEpochReference) => Promise<Pick<PreparedEvalArtifact, 'binding' | 'root'>>;
  readonly native?: Readonly<{
    readonly claudeRun?: NativeClaudeProcessRunner;
    readonly codexRun?: CodexCommandRunner;
  }>;
  readonly planFixture?: (options: { readonly baseDir: string; readonly fixture: EvalCase['fixture'] }) => Promise<EvalFixturePlan>;
  readonly projectRoot: string;
  /** @internal Deterministic cleanup seam for lifecycle tests. */
  readonly removeWorkspace?: (root: string) => Promise<void>;
}

interface CatalogSelection {
  readonly evalCase: EvalCase;
  readonly fixtureId: string;
  readonly fixturePlan: EvalFixturePlan;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
  readonly suiteDir: string;
}

interface CatalogSnapshot {
  readonly artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>;
  readonly catalog: NativePlaygroundCatalog;
  readonly selections: ReadonlyMap<string, CatalogSelection>;
}

interface NativePlaygroundOperation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
}

class MemoryTrialWriter implements EvalTrialWriter {
  async writeArtifactFile(relativePath: string, contents: string): Promise<string> {
    return `native-raw-${digest({ contents, relativePath })}`;
  }

  async writeTrial(trial: Omit<EvalTrialRecord, 'schemaVersion'>): Promise<EvalTrialRecord> {
    return Object.freeze({ ...trial, schemaVersion: 1 });
  }
}

const nativeHosts = new Set<NativePlaygroundHost>(['claude', 'codex']);

const catalogSelectionKey = (
  caseId: string,
  fixtureId: string,
  host: NativePlaygroundHost,
  modelPinId: string,
): string => JSON.stringify([caseId, fixtureId, host, modelPinId]);

const opaqueId = (epoch: ArtifactEpoch, kind: string, content: unknown): string =>
  digest({
    content,
    epoch: Object.freeze({
      configDigest: epoch.configDigest,
      id: epoch.id,
      modelDigest: epoch.modelDigest,
      projectRevision: epoch.projectRevision,
      targetDigests: epoch.targetDigests,
    }),
    kind,
  });

const hardcodedProgress = (phase: NativePlaygroundProgress): PlaygroundEventInput => Object.freeze({
  kind: `native.${phase}`,
  raw: Object.freeze({ phase }),
  source: 'host-preflight',
  summary: phase === 'preflight'
    ? 'Native host preflight completed.'
    : phase === 'fixture.materialized'
      ? 'Native fixture materialized.'
      : phase === 'codex.setup'
        ? 'Codex temporary environment setup started.'
        : 'Native host process started.',
});

/** A completed response is user-facing evidence, but never a raw host stream. */
const safeResponse = (value: string): string => redactEvalCredentialText(value)
  .replace(/(?:[A-Za-z]:)?(?:[/\\][^\s`'"<>|]*)+/gu, '[path]')
  .replaceAll('\0', '');

const workspaceEvidence = (diff: WorkspaceDiff): PlaygroundJsonObject => Object.freeze({
  changes: Object.freeze(diff.changes.map((change) => Object.freeze({
    digest: change.digest,
    id: change.id,
    kind: change.kind,
  }))),
  ...(diff.truncated === true ? { truncated: true } : {}),
});

const normalizedTrialEvents = (trial: EvalTrialRecord, diff: WorkspaceDiff | undefined): readonly PlaygroundEventInput[] => Object.freeze([
  Object.freeze({
    kind: 'native.activation',
    raw: Object.freeze({ activated: trial.evidence.skillActivation.activated, level: trial.evidence.skillActivation.level }),
    source: 'skill-evidence',
    summary: 'Recorded normalized native Skill activation evidence.',
  }),
  Object.freeze({
    kind: 'native.mcp',
    raw: Object.freeze({
      calls: Object.freeze(trial.evidence.mcp.calls.map((call) => Object.freeze({ server: call.server, tool: call.tool }))),
      level: trial.evidence.mcp.level,
    }),
    source: 'mcp',
    summary: 'Recorded normalized native MCP evidence.',
  }),
  Object.freeze({
    kind: 'native.assertions',
    raw: Object.freeze({
      assertions: Object.freeze(trial.assertions.map((assertion) => Object.freeze({
        evidence: assertion.evidence,
        id: assertion.assertionId,
        kind: assertion.kind,
        outcome: assertion.outcome,
      }))),
    }),
    source: 'diagnostics',
    summary: 'Recorded normalized native assertion evidence.',
  }),
  ...(trial.harnessFailure === undefined
    ? []
    : [Object.freeze({
      kind: 'native.harness.failed',
      raw: Object.freeze({ code: trial.harnessFailure.code, stage: trial.harnessFailure.stage }),
      source: 'host-preflight' as const,
      summary: 'Native host could not complete the requested run.',
    })]),
  ...(trial.rawArtifacts.length === 0
    ? []
    : [Object.freeze({
      kind: 'native.raw.references',
      raw: Object.freeze({ refs: trial.rawArtifacts }),
      source: 'diagnostics' as const,
      summary: 'Recorded opaque normalized native raw references.',
    })]),
  ...(diff === undefined
    ? []
    : [Object.freeze({
      kind: 'native.workspace',
      raw: workspaceEvidence(diff),
      source: 'workspace-change' as const,
      summary: 'Recorded bounded native workspace changes.',
    })]),
]);

/**
 * The native Playground adapter only resolves immutable server-owned catalog
 * selections and drives the established host harnesses. Durable Playground
 * admission, append ordering, cancellation, terminalization, and epoch leases
 * remain in PlaygroundOrchestrationService.
 */
export class NativePlaygroundService {
  readonly #catalogs = new Map<string, Promise<CatalogSnapshot>>();
  readonly #cleanupFailures = new Set<unknown>();
  readonly #discover: NonNullable<NativePlaygroundServiceOptions['discover']>;
  readonly #environment: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly #inspectArtifact: NonNullable<NativePlaygroundServiceOptions['inspectArtifact']>;
  readonly #native: NativePlaygroundServiceOptions['native'];
  readonly #operations = new Set<NativePlaygroundOperation>();
  readonly #planFixture: NonNullable<NativePlaygroundServiceOptions['planFixture']>;
  readonly #projectRoot: string;
  readonly #removeWorkspace: NonNullable<NativePlaygroundServiceOptions['removeWorkspace']>;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: NativePlaygroundServiceOptions) {
    this.#projectRoot = options.projectRoot;
    this.#removeWorkspace = options.removeWorkspace ?? (async (root) => rm(root, { force: true, recursive: true }));
    this.#environment = options.environment;
    this.#native = options.native;
    this.#discover = options.discover ?? (async (projectRoot) => {
      const loaded = await loadConfig({ command: 'eval', mode: 'development', root: projectRoot });
      return discoverEvalSuites({ config: normalizeEvalConfig(loaded.config.evals), projectRoot });
    });
    this.#inspectArtifact = options.inspectArtifact ?? (async (reference) => Object.freeze({
      binding: Object.freeze({
        manifestPath: reference.epoch.manifestPath,
        source: 'explicit' as const,
        targetDigests: Object.freeze({ ...reference.epoch.targetDigests }),
      }),
      root: reference.root,
    }));
    this.#planFixture = options.planFixture ?? planEvalFixture;
  }

  async catalog(reference: NativePlaygroundEpochReference): Promise<NativePlaygroundCatalog> {
    this.#assertOpen();
    return (await this.#snapshot(reference)).catalog;
  }

  async prepare(
    reference: NativePlaygroundEpochReference,
    request: NativePlaygroundRequest,
  ): Promise<NativePlaygroundPrepared> {
    this.#assertOpen();
    if (request.epochId !== undefined && request.epochId !== reference.epoch.id) {
      throw new Error('Native Playground catalog selection is not bound to the requested epoch.');
    }
    const snapshot = await this.#snapshot(reference);
    const selected = snapshot.selections.get(catalogSelectionKey(
      request.caseId,
      request.fixtureId,
      request.host,
      request.modelPinId,
    ));
    if (
      selected === undefined ||
      selected.fixtureId !== request.fixtureId ||
      selected.host !== request.host ||
      selected.modelPinId !== request.modelPinId ||
      !nativeHosts.has(request.host) ||
      snapshot.artifact.binding.targetDigests[request.target] === undefined
    ) {
      throw new Error('Native Playground catalog selection is not available for this exact epoch.');
    }
    return Object.freeze({
      artifact: snapshot.artifact,
      epochId: reference.epoch.id,
      evalCase: Object.freeze({ ...selected.evalCase, prompt: request.prompt }),
      fixtureDigest: selected.fixturePlan.digest,
      fixturePlan: selected.fixturePlan,
      host: selected.host,
      prompt: request.prompt,
      suiteDir: selected.suiteDir,
      target: request.target,
    });
  }

  async run(
    prepared: NativePlaygroundPrepared,
    options: Readonly<{
      readonly emit: (event: PlaygroundEventInput) => Promise<void>;
      readonly signal: AbortSignal;
    }>,
  ): Promise<NativePlaygroundRunResult> {
    this.#assertOpen();
    const controller = new AbortController();
    let settle!: () => void;
    const operation: NativePlaygroundOperation = {
      controller,
      settled: new Promise<void>((resolvePromise) => { settle = resolvePromise; }),
      settle: () => { settle(); },
    };
    this.#operations.add(operation);
    const signal = AbortSignal.any([controller.signal, options.signal]);
    let nativeRoot: string | undefined;
    let completedResponse: string | undefined;
    let completedWorkspace: WorkspaceDiff | undefined;
    const onProgress = async (phase: NativePlaygroundProgress): Promise<void> => {
      await options.emit(hardcodedProgress(phase));
    };
    const onCompleted = async (result: Readonly<{ readonly response?: string; readonly workspacePath?: string }>): Promise<void> => {
      if (result.response !== undefined) completedResponse = safeResponse(result.response);
      if (result.workspacePath !== undefined) completedWorkspace = await this.#workspaceDiff(result.workspacePath, prepared);
    };
    try {
      nativeRoot = await this.#createWorkspaceRoot();
      const writer = new MemoryTrialWriter();
      let trial: EvalTrialRecord;
      if (prepared.host === 'claude') {
        trial = await runClaudeTrial({
          artifact: prepared.artifact as PreparedEvalArtifact,
          ...(this.#environment === undefined ? {} : { environment: this.#environment }),
          evalCase: prepared.evalCase,
          fixturePlan: prepared.fixturePlan,
          host: prepared.host,
          ...(this.#native?.claudeRun === undefined ? {} : { run: this.#native.claudeRun }),
          onCompleted,
          onProgress,
          signal,
          suiteDir: prepared.suiteDir,
          target: prepared.target,
          trialIndex: 0,
          workspaceRoot: nativeRoot,
          writer,
        });
      } else {
        trial = await runCodexEvalTrial({
          artifact: prepared.artifact,
          ...(this.#environment === undefined ? {} : { environment: this.#environment }),
          evalCase: prepared.evalCase,
          fixturePlan: prepared.fixturePlan,
          host: prepared.host,
          ...(this.#native?.codexRun === undefined ? {} : { run: this.#native.codexRun }),
          onCompleted: async (result) => onCompleted(result),
          onProgress,
          signal,
          suiteDir: prepared.suiteDir,
          target: prepared.target,
          trialIndex: 0,
          workspaceRoot: nativeRoot,
          writer,
        });
      }
      return Object.freeze({
        events: normalizedTrialEvents(trial, completedWorkspace),
        ...(completedResponse === undefined ? {} : { response: completedResponse }),
        status: trial.harnessFailure === undefined && trial.outcome === 'pass' ? 'passed' : 'failed',
        ...(completedWorkspace === undefined ? {} : { workspace: workspaceEvidence(completedWorkspace) }),
      });
    } finally {
      try {
        if (nativeRoot !== undefined) await this.#cleanupWorkspace(nativeRoot);
      } finally {
        this.#operations.delete(operation);
        operation.settle();
      }
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const operations = [...this.#operations];
    for (const operation of operations) operation.controller.abort(new Error('Native Playground service is closed.'));
    await Promise.allSettled(operations.map((operation) => operation.settled));
    this.#catalogs.clear();
    if (this.#cleanupFailures.size > 0) {
      throw new AggregateError([...this.#cleanupFailures], 'Native Playground workspace cleanup failed.');
    }
  }

  async #cleanupWorkspace(root: string): Promise<void> {
    try {
      await this.#removeWorkspace(root);
    } catch (error) {
      this.#cleanupFailures.add(error);
      throw error;
    }
  }

  async #snapshot(reference: NativePlaygroundEpochReference): Promise<CatalogSnapshot> {
    const existing = this.#catalogs.get(reference.epoch.id);
    if (existing !== undefined) return existing;
    const created = this.#createSnapshot(reference);
    this.#catalogs.set(reference.epoch.id, created);
    try { return await created; }
    catch (error) {
      if (this.#catalogs.get(reference.epoch.id) === created) this.#catalogs.delete(reference.epoch.id);
      throw error;
    }
  }

  async #createSnapshot(reference: NativePlaygroundEpochReference): Promise<CatalogSnapshot> {
    const [artifact, suites] = await Promise.all([
      this.#inspectArtifact(reference),
      this.#discover(this.#projectRoot),
    ]);
    const cases: NativePlaygroundCatalogItem[] = [];
    const fixtures: NativePlaygroundCatalogItem[] = [];
    const modelPins: NativePlaygroundModelPin[] = [];
    const selections = new Map<string, CatalogSelection>();
    for (const discovered of suites) {
      for (const evalCase of discovered.suite.cases) {
        const fixturePlan = await this.#planFixture({ baseDir: this.#suiteDirectory(discovered.sourcePath), fixture: evalCase.fixture });
        const caseId = opaqueId(reference.epoch, 'case', { digest: evalCase.digest, suite: discovered.suite.digest });
        const fixtureId = opaqueId(reference.epoch, 'fixture', { case: evalCase.digest, digest: fixturePlan.digest });
        cases.push(Object.freeze({ id: caseId, label: `${discovered.suite.name} / ${evalCase.id}` }));
        fixtures.push(Object.freeze({ id: fixtureId, label: `${discovered.suite.name} / ${evalCase.id}` }));
        for (const host of Object.keys(evalCase.hosts).filter((host): host is NativePlaygroundHost => nativeHosts.has(host as NativePlaygroundHost)).sort()) {
          const modelPinId = opaqueId(reference.epoch, 'model', { case: evalCase.digest, host, model: evalCase.hosts[host]!.model });
          modelPins.push(Object.freeze({ host, id: modelPinId, label: `${host} pinned model` }));
          selections.set(catalogSelectionKey(caseId, fixtureId, host, modelPinId), Object.freeze({
            evalCase,
            fixtureId,
            fixturePlan,
            host,
            modelPinId,
            suiteDir: this.#suiteDirectory(discovered.sourcePath),
          }));
        }
      }
    }
    return Object.freeze({
      artifact,
      catalog: Object.freeze({
        cases: Object.freeze(cases),
        epochId: reference.epoch.id,
        fixtures: Object.freeze(fixtures),
        modelPins: Object.freeze(modelPins),
      }),
      selections,
    });
  }

  async #createWorkspaceRoot(): Promise<string> {
    const root = join(this.#projectRoot, '.agent-bundle');
    await mkdir(root, { recursive: true });
    return mkdtemp(join(root, 'native-playground-'));
  }

  async #workspaceDiff(workspace: string, prepared: NativePlaygroundPrepared): Promise<WorkspaceDiff | undefined> {
    try {
      return await workspaceDiff({
        plan: prepared.fixturePlan,
        workspace,
      });
    } catch { return undefined; }
  }

  #suiteDirectory(sourcePath: string): string {
    const separator = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
    return separator < 0 ? this.#projectRoot : sourcePath.slice(0, separator);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Native Playground service is closed.');
  }
}
