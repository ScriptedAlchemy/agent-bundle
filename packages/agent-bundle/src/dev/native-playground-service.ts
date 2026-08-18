import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { digest, stableJson } from '../core/digest.ts';
import { parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue, type JsonValue } from '../core/strict-json.ts';
import { loadConfig } from '../config/load.ts';
import { prepareEvalArtifact, type PreparedEvalArtifact } from '../eval/artifact.ts';
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
import { safeDevWireText } from './dev-log-service.ts';
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

/** One browser-admissible opaque selection. IDs are meaningful only as this complete tuple. */
export interface NativePlaygroundCatalogSelection {
  readonly caseId: string;
  readonly fixtureId: string;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
}

export interface NativePlaygroundCatalog {
  readonly cases: readonly NativePlaygroundCatalogItem[];
  readonly epochId: string;
  readonly fixtures: readonly NativePlaygroundCatalogItem[];
  readonly modelPins: readonly NativePlaygroundModelPin[];
  readonly selections: readonly NativePlaygroundCatalogSelection[];
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
  /** Test-only storage override; production snapshots live beside retained epoch metadata. */
  readonly catalogDirectory?: string;
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
}

interface CatalogSelection {
  readonly caseId: string;
  readonly caseLabel: string;
  readonly evalCase: EvalCase;
  readonly fixtureId: string;
  readonly fixtureLabel: string;
  readonly fixturePlan: EvalFixturePlan;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
  readonly modelPinLabel: string;
  readonly suiteDir: string;
}

interface CatalogSnapshot {
  readonly artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>;
  readonly catalog: NativePlaygroundCatalog;
  readonly selections: ReadonlyMap<string, CatalogSelection>;
}

type PersistedCatalogSelection = CatalogSelection;

interface PersistedCatalogSnapshot {
  readonly epochId: string;
  readonly selections: readonly PersistedCatalogSelection[];
  readonly version: 1;
}

/** Native raw trial artifacts have no durable backing store; durable Playground events are the only exposed evidence. */
class DiscardingTrialWriter implements EvalTrialWriter {
  async writeArtifactFile(relativePath: string, _contents: string): Promise<string> {
    return relativePath;
  }

  async writeTrial(trial: Omit<EvalTrialRecord, 'schemaVersion'>): Promise<EvalTrialRecord> {
    return Object.freeze({ ...trial, schemaVersion: 1 });
  }
}

const nativeHosts = new Set<NativePlaygroundHost>(['claude', 'codex']);
const catalogSnapshotVersion = 1 as const;
const maximumCatalogSelections = 256;
const maximumFixtureEntries = 4_096;
const maximumSnapshotDepth = 16;
const maximumSnapshotStringLength = 16_384;
const safeEpochSegment = /^[a-z0-9][a-z0-9._-]*$/iu;

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

const normalizedTrialEvents = (
  trial: EvalTrialRecord,
  diff: WorkspaceDiff | undefined,
  hookEvents: readonly string[],
  projectRoot: string,
  response: string | undefined,
): readonly PlaygroundEventInput[] => Object.freeze([
  Object.freeze({
    kind: 'native.activation',
    raw: Object.freeze({
      activated: Object.freeze(trial.evidence.skillActivation.activated.map((name) => safeDevWireText(name, projectRoot))),
      level: trial.evidence.skillActivation.level,
    }),
    source: 'skill-evidence',
    summary: 'Recorded normalized native Skill activation evidence.',
  }),
  Object.freeze({
    kind: 'native.mcp',
    raw: Object.freeze({
      calls: Object.freeze(trial.evidence.mcp.calls.map((call) => Object.freeze({
        server: safeDevWireText(call.server, projectRoot),
        tool: safeDevWireText(call.tool, projectRoot),
      }))),
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
        id: safeDevWireText(assertion.assertionId, projectRoot),
        kind: safeDevWireText(assertion.kind, projectRoot),
        outcome: assertion.outcome,
      }))),
    }),
    source: 'diagnostics',
    summary: 'Recorded normalized native assertion evidence.',
  }),
  ...(hookEvents.length === 0
    ? []
    : [Object.freeze({
      kind: 'native.hooks',
      raw: Object.freeze({ events: Object.freeze(hookEvents.map((event) => safeDevWireText(event, projectRoot))) }),
      source: 'hook' as const,
      summary: 'Recorded normalized native Hook evidence.',
    })]),
  ...(Object.keys(trial.evidence.scripts.results).length === 0
    ? []
    : [Object.freeze({
      kind: 'native.scripts',
      raw: Object.freeze({
        level: trial.evidence.scripts.level,
        results: Object.freeze(Object.entries(trial.evidence.scripts.results).map(([id, result]) => Object.freeze({
          detail: safeDevWireText(result.detail, projectRoot),
          id: safeDevWireText(id, projectRoot),
          outcome: result.outcome,
        }))),
      }),
      source: 'script' as const,
      summary: 'Recorded normalized native script evidence.',
    })]),
  ...(response === undefined
    ? []
    : [Object.freeze({
      kind: 'native.response',
      raw: Object.freeze({ text: response }),
      source: 'response' as const,
      summary: 'Recorded normalized native host response.',
    })]),
  ...(trial.harnessFailure === undefined
    ? []
    : [Object.freeze({
      kind: 'native.harness.failed',
      raw: Object.freeze({ code: trial.harnessFailure.code, stage: trial.harnessFailure.stage }),
      source: 'host-preflight' as const,
      summary: 'Native host could not complete the requested run.',
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

const selectionKey = (selection: NativePlaygroundCatalogSelection): string =>
  `${selection.caseId}\u0000${selection.fixtureId}\u0000${selection.host}\u0000${selection.modelPinId}`;

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedJson = (value: JsonValue, depth = 0): boolean => {
  if (depth > maximumSnapshotDepth) return false;
  if (typeof value === 'string') return value.length <= maximumSnapshotStringLength;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (Array.isArray(value)) return value.length <= maximumFixtureEntries && value.every((entry) => boundedJson(entry, depth + 1));
  const entries = Object.entries(value);
  return entries.length <= maximumFixtureEntries && entries.every(([key, entry]) =>
    key.length <= 256 && boundedJson(entry, depth + 1));
};

const nonemptySnapshotText = (value: JsonValue | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumSnapshotStringLength;

const exactKeys = (value: Readonly<Record<string, JsonValue>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const persistedSelection = (value: JsonValue): PersistedCatalogSelection | undefined => {
  if (!isRecord(value) || !exactKeys(value, [
    'caseId', 'caseLabel', 'evalCase', 'fixtureId', 'fixtureLabel', 'fixturePlan', 'host', 'modelPinId', 'modelPinLabel', 'suiteDir',
  ])) return undefined;
  if (
    !nonemptySnapshotText(value.caseId) || !nonemptySnapshotText(value.caseLabel) ||
    !nonemptySnapshotText(value.fixtureId) || !nonemptySnapshotText(value.fixtureLabel) ||
    !nonemptySnapshotText(value.modelPinId) || !nonemptySnapshotText(value.modelPinLabel) ||
    !nonemptySnapshotText(value.suiteDir) ||
    (value.host !== 'claude' && value.host !== 'codex') ||
    !isRecord(value.evalCase) || !isRecord(value.fixturePlan) ||
    !boundedJson(value.evalCase) || !boundedJson(value.fixturePlan)
  ) return undefined;
  const evalCase = value.evalCase as unknown as EvalCase;
  const fixturePlan = value.fixturePlan as unknown as EvalFixturePlan;
  if (
    !nonemptySnapshotText((evalCase as unknown as Record<string, JsonValue>).digest) ||
    !Array.isArray(fixturePlan.entries) || fixturePlan.entries.length > maximumFixtureEntries ||
    !nonemptySnapshotText(fixturePlan.digest) || !nonemptySnapshotText(fixturePlan.sourcePath) ||
    typeof fixturePlan.git !== 'boolean'
  ) return undefined;
  return Object.freeze({
    caseId: value.caseId,
    caseLabel: value.caseLabel,
    evalCase: Object.freeze(evalCase),
    fixtureId: value.fixtureId,
    fixtureLabel: value.fixtureLabel,
    fixturePlan: Object.freeze(fixturePlan),
    host: value.host,
    modelPinId: value.modelPinId,
    modelPinLabel: value.modelPinLabel,
    suiteDir: value.suiteDir,
  });
};

/**
 * The native Playground adapter only resolves immutable server-owned catalog
 * selections and drives the established host harnesses. Durable Playground
 * admission, append ordering, cancellation, terminalization, and epoch leases
 * remain in PlaygroundOrchestrationService.
 */
export class NativePlaygroundService {
  readonly #catalogDirectory: string | undefined;
  readonly #catalogs = new Map<string, Promise<CatalogSnapshot>>();
  readonly #controllers = new Set<AbortController>();
  readonly #runs = new Set<Promise<NativePlaygroundRunResult>>();
  readonly #discover: NonNullable<NativePlaygroundServiceOptions['discover']>;
  readonly #environment: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly #inspectArtifact: NonNullable<NativePlaygroundServiceOptions['inspectArtifact']>;
  readonly #native: NativePlaygroundServiceOptions['native'];
  readonly #planFixture: NonNullable<NativePlaygroundServiceOptions['planFixture']>;
  readonly #projectRoot: string;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: NativePlaygroundServiceOptions) {
    this.#catalogDirectory = options.catalogDirectory;
    this.#projectRoot = options.projectRoot;
    this.#environment = options.environment;
    this.#native = options.native;
    this.#discover = options.discover ?? (async (projectRoot) => {
      const loaded = await loadConfig({ command: 'eval', mode: 'development', root: projectRoot });
      return discoverEvalSuites({ config: normalizeEvalConfig(loaded.config.evals), projectRoot });
    });
    this.#inspectArtifact = options.inspectArtifact ?? (async (reference) =>
      prepareEvalArtifact({ artifact: reference.root, projectRoot: this.#projectRoot, runDirectory: reference.root }));
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
    const selected = snapshot.selections.get(selectionKey(request));
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

  run(
    prepared: NativePlaygroundPrepared,
    options: Readonly<{
      readonly emit: (event: PlaygroundEventInput) => Promise<void>;
      readonly signal: AbortSignal;
    }>,
  ): Promise<NativePlaygroundRunResult> {
    this.#assertOpen();
    const controller = new AbortController();
    this.#controllers.add(controller);
    const running = this.#run(prepared, options, controller).finally(() => {
      this.#controllers.delete(controller);
      this.#runs.delete(running);
    });
    this.#runs.add(running);
    return running;
  }

  async #run(
    prepared: NativePlaygroundPrepared,
    options: Readonly<{
      readonly emit: (event: PlaygroundEventInput) => Promise<void>;
      readonly signal: AbortSignal;
    }>,
    controller: AbortController,
  ): Promise<NativePlaygroundRunResult> {
    const signal = AbortSignal.any([controller.signal, options.signal]);
    const nativeRoot = await this.#createWorkspaceRoot();
    let completedResponse: string | undefined;
    let completedWorkspace: WorkspaceDiff | undefined;
    let completedHooks: readonly string[] = Object.freeze([]);
    const onProgress = async (phase: NativePlaygroundProgress): Promise<void> => {
      await options.emit(hardcodedProgress(phase));
    };
    const onCompleted = async (result: Readonly<{
      readonly hookEvents?: readonly string[];
      readonly response?: string;
      readonly workspacePath?: string;
    }>): Promise<void> => {
      if (result.hookEvents !== undefined) completedHooks = Object.freeze([...result.hookEvents]);
      if (result.response !== undefined) completedResponse = safeResponse(result.response);
      if (result.workspacePath !== undefined) completedWorkspace = await this.#workspaceDiff(result.workspacePath, prepared);
    };
    try {
      const writer = new DiscardingTrialWriter();
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
        events: normalizedTrialEvents(trial, completedWorkspace, completedHooks, this.#projectRoot, completedResponse),
        ...(completedResponse === undefined ? {} : { response: completedResponse }),
        status: trial.harnessFailure === undefined && trial.outcome === 'pass' ? 'passed' : 'failed',
        ...(completedWorkspace === undefined ? {} : { workspace: workspaceEvidence(completedWorkspace) }),
      });
    } finally {
      await rm(nativeRoot, { force: true, recursive: true });
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort(new Error('Native Playground service is closed.'));
    await Promise.allSettled([...this.#runs]);
    this.#catalogs.clear();
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
    const artifact = await this.#inspectArtifact(reference);
    const persisted = await this.#readSnapshot(reference);
    const snapshot = persisted ?? await this.#persistSnapshot(reference, await this.#discoverSnapshot(reference));
    return this.#hydrateSnapshot(artifact, snapshot);
  }

  async #discoverSnapshot(reference: NativePlaygroundEpochReference): Promise<PersistedCatalogSnapshot> {
    const suites = await this.#discover(this.#projectRoot);
    const selections: PersistedCatalogSelection[] = [];
    for (const discovered of suites) {
      for (const evalCase of discovered.suite.cases) {
        const fixturePlan = await this.#planFixture({ baseDir: this.#suiteDirectory(discovered.sourcePath), fixture: evalCase.fixture });
        const caseId = opaqueId(reference.epoch, 'case', { digest: evalCase.digest, suite: discovered.suite.digest });
        const fixtureId = opaqueId(reference.epoch, 'fixture', { case: evalCase.digest, digest: fixturePlan.digest });
        const caseLabel = `${discovered.suite.name} / ${evalCase.id}`;
        const suiteDir = this.#suiteDirectory(discovered.sourcePath);
        for (const host of Object.keys(evalCase.hosts).filter((host): host is NativePlaygroundHost => nativeHosts.has(host as NativePlaygroundHost)).sort()) {
          const modelPinId = opaqueId(reference.epoch, 'model', { case: evalCase.digest, host, model: evalCase.hosts[host]!.model });
          selections.push(Object.freeze({
            caseId,
            caseLabel,
            evalCase,
            fixtureId,
            fixtureLabel: caseLabel,
            fixturePlan,
            host,
            modelPinId,
            modelPinLabel: `${host} pinned model`,
            suiteDir,
          }));
        }
      }
    }
    if (selections.length > maximumCatalogSelections) {
      throw new Error('Native Playground catalog has too many selections.');
    }
    return Object.freeze({
      epochId: reference.epoch.id,
      selections: Object.freeze([...selections].sort((left, right) => selectionKey(left).localeCompare(selectionKey(right)))),
      version: catalogSnapshotVersion,
    });
  }

  #hydrateSnapshot(
    artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>,
    snapshot: PersistedCatalogSnapshot,
  ): CatalogSnapshot {
    const cases = new Map<string, NativePlaygroundCatalogItem>();
    const fixtures = new Map<string, NativePlaygroundCatalogItem>();
    const modelPins = new Map<string, NativePlaygroundModelPin>();
    const selections = new Map<string, CatalogSelection>();
    for (const selection of snapshot.selections) {
      const key = selectionKey(selection);
      if (selections.has(key)) throw new Error('Native Playground catalog snapshot contains duplicate selections.');
      cases.set(selection.caseId, Object.freeze({ id: selection.caseId, label: selection.caseLabel }));
      fixtures.set(selection.fixtureId, Object.freeze({ id: selection.fixtureId, label: selection.fixtureLabel }));
      modelPins.set(selection.modelPinId, Object.freeze({
        host: selection.host,
        id: selection.modelPinId,
        label: selection.modelPinLabel,
      }));
      selections.set(key, selection);
    }
    return Object.freeze({
      artifact,
      catalog: Object.freeze({
        cases: Object.freeze([...cases.values()].sort((left, right) => left.id.localeCompare(right.id))),
        epochId: snapshot.epochId,
        fixtures: Object.freeze([...fixtures.values()].sort((left, right) => left.id.localeCompare(right.id))),
        modelPins: Object.freeze([...modelPins.values()].sort((left, right) => left.id.localeCompare(right.id))),
        selections: Object.freeze(snapshot.selections.map((selection) => Object.freeze({
          caseId: selection.caseId,
          fixtureId: selection.fixtureId,
          host: selection.host,
          modelPinId: selection.modelPinId,
        }))),
      }),
      selections,
    });
  }

  async #readSnapshot(reference: NativePlaygroundEpochReference): Promise<PersistedCatalogSnapshot | undefined> {
    const path = this.#snapshotPath(reference);
    let raw: string;
    try { raw = await readFile(path, 'utf8'); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new Error('Native Playground catalog snapshot could not be read.', { cause: error });
    }
    let value: JsonValue;
    try { value = snapshotStrictJsonValue(parseJsonWithoutDuplicateKeys(raw)); }
    catch { throw new Error('Native Playground catalog snapshot is invalid.'); }
    if (!isRecord(value) || !exactKeys(value, ['epochId', 'selections', 'version']) || value.version !== catalogSnapshotVersion ||
      value.epochId !== reference.epoch.id || !Array.isArray(value.selections) || value.selections.length > maximumCatalogSelections) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    const selections = value.selections.map(persistedSelection);
    if (selections.some((selection) => selection === undefined)) throw new Error('Native Playground catalog snapshot is invalid.');
    const resolved = selections as PersistedCatalogSelection[];
    if (new Set(resolved.map(selectionKey)).size !== resolved.length) throw new Error('Native Playground catalog snapshot is invalid.');
    return Object.freeze({ epochId: value.epochId, selections: Object.freeze(resolved), version: catalogSnapshotVersion });
  }

  async #persistSnapshot(
    reference: NativePlaygroundEpochReference,
    snapshot: PersistedCatalogSnapshot,
  ): Promise<PersistedCatalogSnapshot> {
    const path = this.#snapshotPath(reference);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${reference.epoch.id}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`);
    try {
      await writeFile(temporary, `${stableJson(snapshot)}\n`, 'utf8');
      try { await link(temporary, path); }
      catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    const persisted = await this.#readSnapshot(reference);
    if (persisted === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
    return persisted;
  }

  #snapshotPath(reference: NativePlaygroundEpochReference): string {
    if (!safeEpochSegment.test(reference.epoch.id)) throw new Error('Native Playground epoch id is not safe for catalog storage.');
    const directory = this.#catalogDirectory ?? join(dirname(reference.root), '.metadata', 'native-playground');
    return join(directory, `${reference.epoch.id}.json`);
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
