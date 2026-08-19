import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
import { provenanceIdentifierPattern } from '../eval/provenance.ts';
import type { EvalTrialRecord, EvalTrialWriter } from '../eval/run-store.ts';
import { normalizeEvalCase } from '../eval/suite.ts';
import type { EvalCase } from '../eval/types.ts';
import type { NativeClaudeProcessRunner } from '../host-contracts/native-claude-contract.ts';
import type { PlaygroundEventInput, PlaygroundJsonObject } from '../services/playground-service.ts';
import { safeDevWireText } from './dev-log-service.ts';
import type { ArtifactEpoch } from './types.ts';
import { workspaceDiff, type WorkspaceDiff } from '../eval/workspace-diff.ts';
import { isInsideOrEqual } from '../core/paths.ts';
import { isErrno } from '../core/errors.ts';

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
  /** @internal Fault-injection seam for durable epoch-sidecar publication. */
  readonly catalogStorage?: NativePlaygroundCatalogStorage;
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

export interface NativePlaygroundCatalogStorage {
  readonly link: typeof link;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly remove: typeof rm;
}

/**
 * Publication-time authority. Artifact publication calls this before flipping
 * active epoch metadata, so an unvisited epoch never lazily observes a later
 * authored eval configuration.
 */
export interface NativePlaygroundCatalogPublicationOptions {
  readonly catalogDirectory?: string;
  readonly catalogStorage?: NativePlaygroundCatalogStorage;
  readonly discover?: NativePlaygroundServiceOptions['discover'];
  readonly epoch: ArtifactEpoch;
  readonly planFixture?: NativePlaygroundServiceOptions['planFixture'];
  readonly projectRoot: string;
}

export interface NativePlaygroundCatalogPublicationReceipt {
  /** True only when this publisher installed the exact sidecar inode. */
  readonly created: boolean;
  /** Opaque inode-and-content identity used to make rollback ownership-safe. */
  readonly identity: string;
  rollback(): Promise<void>;
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

/** Persisted paths are deliberately relative to their owning project/suite. */
interface PersistedFixturePlan {
  readonly digest: string;
  readonly entries: readonly EvalFixturePlan['entries'][number][];
  readonly git: boolean;
  readonly sourcePath: string;
}

interface PersistedCatalogSelection {
  readonly caseId: string;
  readonly caseLabel: string;
  readonly evalCase: EvalCase;
  readonly fixtureId: string;
  readonly fixtureLabel: string;
  readonly fixturePlan: PersistedFixturePlan;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
  readonly modelPinLabel: string;
  readonly suiteDir: string;
  readonly suiteDigest: string;
  readonly suiteName: string;
}

interface CatalogSnapshot {
  readonly artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>;
  readonly catalog: NativePlaygroundCatalog;
  readonly selections: ReadonlyMap<string, CatalogSelection>;
}

interface PersistedCatalogSnapshot {
  readonly epochId: string;
  readonly selections: readonly PersistedCatalogSelection[];
}

interface SidecarFile {
  readonly identity: string;
  readonly raw: string;
}

interface PersistedCatalogPublication {
  readonly receipt: NativePlaygroundCatalogPublicationReceipt;
  readonly snapshot: PersistedCatalogSnapshot;
}

/** Native raw trial artifacts have no durable backing store; durable Playground events are the only exposed evidence. */
class DiscardingTrialWriter implements EvalTrialWriter {
  async writeArtifactFile(relativePath: string, _contents: string): Promise<string> {
    return relativePath;
  }

  async writeTrial(trial: EvalTrialRecord): Promise<EvalTrialRecord> {
    return Object.freeze({ ...trial });
  }
}

const nativeHosts = new Set<NativePlaygroundHost>(['claude', 'codex']);
const catalogDurabilityPlatformKey = Symbol.for('agent-bundle.native-playground-service.catalog-durability-platform');
const maximumCatalogSelections = 256;
const maximumFixtureEntries = 4_096;
const maximumSnapshotStringLength = 16_384;
const safeEpochSegment = /^[a-z0-9][a-z0-9._-]*$/iu;
const safeDigestText = /^[a-z0-9._:-]+$/iu;

const catalogDurabilityPlatform = (): NodeJS.Platform => {
  if (process.env.NODE_ENV !== 'test') return process.platform;
  const platforms = globalThis as typeof globalThis & Record<symbol, NodeJS.Platform | undefined>;
  return platforms[catalogDurabilityPlatformKey] ?? process.platform;
};

const isSafeRelativePath = (value: JsonValue | undefined, allowCurrentDirectory = false): value is string =>
  nonemptySnapshotText(value) &&
  !isAbsolute(value) &&
  (allowCurrentDirectory && value === '.' ||
    value !== '.' &&
    !value.split(/[\\/]/u).some((part) => part.length === 0 || part === '.' || part === '..'));

const relativePathInside = (root: string, path: string, allowCurrentDirectory = false): string => {
  const normalizedRoot = resolve(root);
  const candidate = resolve(path);
  if (!isInsideOrEqual(normalizedRoot, candidate)) {
    throw new Error('Native Playground catalog snapshot contains an invalid path.');
  }
  const value = relative(normalizedRoot, candidate) || '.';
  if (!isSafeRelativePath(value, allowCurrentDirectory)) {
    throw new Error('Native Playground catalog snapshot contains an invalid path.');
  }
  return value;
};

const resolveContainedPath = (root: string, value: string, allowCurrentDirectory = false): string => {
  if (!isSafeRelativePath(value, allowCurrentDirectory)) {
    throw new Error('Native Playground catalog snapshot is invalid.');
  }
  const candidate = resolve(root, value);
  if (!isInsideOrEqual(resolve(root), candidate)) {
    throw new Error('Native Playground catalog snapshot is invalid.');
  }
  return candidate;
};

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

const catalogSelectionIdentity = (options: Readonly<{
  readonly epoch: ArtifactEpoch;
  readonly evalCase: EvalCase;
  readonly fixturePlan: Pick<PersistedFixturePlan, 'digest'>;
  readonly host: NativePlaygroundHost;
  readonly suiteDigest: string;
  readonly suiteName: string;
}>): Readonly<{
  readonly caseId: string;
  readonly caseLabel: string;
  readonly fixtureId: string;
  readonly fixtureLabel: string;
  readonly modelPinId: string;
  readonly modelPinLabel: string;
}> => Object.freeze({
  caseId: opaqueId(options.epoch, 'case', { digest: options.evalCase.digest, suite: options.suiteDigest }),
  caseLabel: `${options.suiteName} / ${options.evalCase.id}`,
  fixtureId: opaqueId(options.epoch, 'fixture', { case: options.evalCase.digest, digest: options.fixturePlan.digest }),
  fixtureLabel: `${options.suiteName} / ${options.evalCase.id}`,
  modelPinId: opaqueId(options.epoch, 'model', { case: options.evalCase.digest, host: options.host, model: options.evalCase.hosts[options.host]!.model }),
  modelPinLabel: `${options.host} pinned model`,
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

const safeNativeProvenanceText = (value: string, projectRoot: string): string => {
  const redacted = safeDevWireText(redactEvalCredentialText(value), projectRoot);
  return provenanceIdentifierPattern.test(redacted) ? redacted : '[REDACTED]';
};

const nativeTrialProvenance = (trial: EvalTrialRecord, projectRoot: string): PlaygroundJsonObject => {
  const provenance = trial.provenance;
  const semanticGrader = provenance?.semanticGrader;
  return Object.freeze({
    ...(provenance?.hostCliVersion === undefined
      ? {}
      : { hostCliVersion: safeNativeProvenanceText(provenance.hostCliVersion, projectRoot) }),
    ...(provenance === undefined
      ? {}
      : {
        invocation: Object.freeze({
          mode: provenance.invocation.mode,
          ...(provenance.invocation.skill === undefined
            ? {}
            : { skill: safeNativeProvenanceText(provenance.invocation.skill, projectRoot) }),
        }),
        ...(semanticGrader === undefined
          ? {}
          : { semanticGrader: semanticGrader === null
            ? null
            : 'state' in semanticGrader
              ? Object.freeze({ state: 'unrecorded' })
              : Object.freeze({
                id: safeNativeProvenanceText(semanticGrader.id, projectRoot),
                model: safeNativeProvenanceText(semanticGrader.model, projectRoot),
              }) }),
      }),
    model: safeNativeProvenanceText(trial.model, projectRoot),
  });
};

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
    kind: 'native.provenance',
    raw: nativeTrialProvenance(trial, projectRoot),
    source: 'host-preflight',
    summary: 'Recorded safe native model and host provenance.',
  }),
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

const nonemptySnapshotText = (value: JsonValue | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumSnapshotStringLength;

const exactKeys = (value: Readonly<Record<string, JsonValue>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const activationEvidence = (value: JsonValue | undefined): value is 'inferred' | 'observed' | 'unavailable' =>
  value === 'inferred' || value === 'observed' || value === 'unavailable';

const safeInteger = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

const persistedAssertion = (value: JsonValue): EvalCase['assertions'][number] | undefined => {
  if (!isRecord(value) || !nonemptySnapshotText(value.id) || !activationEvidence(value.minimumEvidence) || typeof value.kind !== 'string') return undefined;
  if (value.kind === 'exit-code' && exactKeys(value, ['expected', 'id', 'kind', 'minimumEvidence']) && safeInteger(value.expected)) {
    return Object.freeze({ expected: value.expected, id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence });
  }
  if (value.kind === 'mcp-call' && exactKeys(value, ['atLeast', 'id', 'kind', 'minimumEvidence', 'server', 'tool']) &&
    safeInteger(value.atLeast) && value.atLeast >= 0 && nonemptySnapshotText(value.server) && nonemptySnapshotText(value.tool)) {
    return Object.freeze({ atLeast: value.atLeast, id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence, server: value.server, tool: value.tool });
  }
  if (value.kind === 'no-mcp-call' && nonemptySnapshotText(value.server) &&
    ((exactKeys(value, ['id', 'kind', 'minimumEvidence', 'server'])) ||
      (exactKeys(value, ['id', 'kind', 'minimumEvidence', 'server', 'tool']) && nonemptySnapshotText(value.tool)))) {
    return Object.freeze({
      ...(value.tool === undefined ? {} : { tool: value.tool as string }),
      id: value.id,
      kind: value.kind,
      minimumEvidence: value.minimumEvidence,
      server: value.server,
    });
  }
  if (value.kind === 'no-skill-activation' &&
    ((exactKeys(value, ['id', 'kind', 'minimumEvidence'])) || (exactKeys(value, ['id', 'kind', 'minimumEvidence', 'skill']) && nonemptySnapshotText(value.skill)))) {
    return Object.freeze({ ...(value.skill === undefined ? {} : { skill: value.skill as string }), id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence });
  }
  if (value.kind === 'outcome' && exactKeys(value, ['id', 'kind', 'minimumEvidence', 'script']) && nonemptySnapshotText(value.script)) {
    return Object.freeze({ id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence, script: value.script });
  }
  if (value.kind === 'skill-activation' && exactKeys(value, ['id', 'kind', 'minimumEvidence', 'skill']) && nonemptySnapshotText(value.skill)) {
    return Object.freeze({ id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence, skill: value.skill });
  }
  return undefined;
};

const persistedEvalCase = (value: JsonValue): EvalCase | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['assertions', 'digest', 'fixture', 'hosts', 'id', 'invocation', 'prompt', 'trials']) ||
    !Array.isArray(value.assertions) || value.assertions.length > maximumFixtureEntries ||
    !nonemptySnapshotText(value.digest) || !nonemptySnapshotText(value.id) || !nonemptySnapshotText(value.prompt) ||
    !safeInteger(value.trials) || value.trials < 1 || !isRecord(value.fixture) || !isRecord(value.hosts) || !isRecord(value.invocation)) return undefined;
  if (!exactKeys(value.fixture, ['git', 'include', 'path']) || typeof value.fixture.git !== 'boolean' ||
    !Array.isArray(value.fixture.include) || value.fixture.include.length > maximumFixtureEntries ||
    !value.fixture.include.every(nonemptySnapshotText) || !isSafeRelativePath(value.fixture.path, true)) return undefined;
  const hostEntries = Object.entries(value.hosts);
  if (hostEntries.length > maximumFixtureEntries || hostEntries.some(([host, binding]) => !nonemptySnapshotText(host) ||
    !isRecord(binding) || !exactKeys(binding, ['model']) || !nonemptySnapshotText(binding.model))) return undefined;
  const invocation = value.invocation;
  if (!((invocation.mode === 'automatic' || invocation.mode === 'none') && exactKeys(invocation, ['mode'])) &&
    !(invocation.mode === 'explicit' && exactKeys(invocation, ['mode', 'skill']) && nonemptySnapshotText(invocation.skill))) return undefined;
  const assertions = value.assertions.map(persistedAssertion);
  if (assertions.some((assertion) => assertion === undefined)) return undefined;
  try {
    const normalized = normalizeEvalCase({
      assertions: assertions as EvalCase['assertions'][number][],
      fixture: Object.freeze({ git: value.fixture.git, include: Object.freeze([...value.fixture.include] as string[]), path: value.fixture.path }),
      hosts: Object.freeze(Object.fromEntries(hostEntries.map(([host, binding]) => [host, Object.freeze({ model: (binding as Readonly<Record<string, string>>).model })]))),
      id: value.id,
      invocation: Object.freeze(invocation.mode === 'explicit' ? { mode: 'explicit' as const, skill: invocation.skill as string } : { mode: invocation.mode }),
      prompt: value.prompt,
      trials: value.trials,
    });
    return normalized.digest === value.digest ? normalized : undefined;
  } catch {
    return undefined;
  }
};

const persistedFixturePlan = (value: JsonValue): PersistedFixturePlan | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['digest', 'entries', 'git', 'sourcePath']) ||
    !nonemptySnapshotText(value.digest) || typeof value.git !== 'boolean' || !isSafeRelativePath(value.sourcePath, true) ||
    !Array.isArray(value.entries) || value.entries.length > maximumFixtureEntries) return undefined;
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ['executable', 'path', 'sha256']) || typeof entry.executable !== 'boolean' ||
      !isSafeRelativePath(entry.path) || !nonemptySnapshotText(entry.sha256) || !safeDigestText.test(entry.sha256)) return undefined;
    return Object.freeze({ executable: entry.executable, path: entry.path, sha256: entry.sha256 });
  });
  if (entries.some((entry) => entry === undefined) || new Set(entries.map((entry) => entry?.path)).size !== entries.length) return undefined;
  const normalizedEntries = Object.freeze(entries as EvalFixturePlan['entries'][number][]);
  return digest({ entries: normalizedEntries, git: value.git }) === value.digest
    ? Object.freeze({ digest: value.digest, entries: normalizedEntries, git: value.git, sourcePath: value.sourcePath })
    : undefined;
};

const persistedSelection = (value: JsonValue): PersistedCatalogSelection | undefined => {
  if (!isRecord(value) || !exactKeys(value, [
    'caseId', 'caseLabel', 'evalCase', 'fixtureId', 'fixtureLabel', 'fixturePlan', 'host', 'modelPinId', 'modelPinLabel', 'suiteDigest', 'suiteDir', 'suiteName',
  ]) ||
  !nonemptySnapshotText(value.caseId) || !nonemptySnapshotText(value.caseLabel) ||
  !nonemptySnapshotText(value.fixtureId) || !nonemptySnapshotText(value.fixtureLabel) ||
  !nonemptySnapshotText(value.modelPinId) || !nonemptySnapshotText(value.modelPinLabel) ||
  !nonemptySnapshotText(value.suiteDigest) || !nonemptySnapshotText(value.suiteName) ||
  !isSafeRelativePath(value.suiteDir, true) ||
  (value.host !== 'claude' && value.host !== 'codex')) return undefined;
  const evalCase = persistedEvalCase(value.evalCase);
  const fixturePlan = persistedFixturePlan(value.fixturePlan);
  if (evalCase === undefined || fixturePlan === undefined || evalCase.hosts[value.host] === undefined) return undefined;
  return Object.freeze({
    caseId: value.caseId,
    caseLabel: value.caseLabel,
    evalCase,
    fixtureId: value.fixtureId,
    fixtureLabel: value.fixtureLabel,
    fixturePlan,
    host: value.host,
    modelPinId: value.modelPinId,
    modelPinLabel: value.modelPinLabel,
    suiteDir: value.suiteDir,
    suiteDigest: value.suiteDigest,
    suiteName: value.suiteName,
  });
};

const hasCanonicalSelectionIdentity = (epoch: ArtifactEpoch, selection: PersistedCatalogSelection): boolean => {
  const expected = catalogSelectionIdentity({
    epoch,
    evalCase: selection.evalCase,
    fixturePlan: selection.fixturePlan,
    host: selection.host,
    suiteDigest: selection.suiteDigest,
    suiteName: selection.suiteName,
  });
  return selection.caseId === expected.caseId &&
    selection.caseLabel === expected.caseLabel &&
    selection.fixtureId === expected.fixtureId &&
    selection.fixtureLabel === expected.fixtureLabel &&
    selection.modelPinId === expected.modelPinId &&
    selection.modelPinLabel === expected.modelPinLabel;
};

/**
 * The native Playground adapter only resolves immutable server-owned catalog
 * selections and drives the established host harnesses. Durable Playground
 * admission, append ordering, cancellation, terminalization, and epoch leases
 * remain in PlaygroundOrchestrationService.
 */
export class NativePlaygroundService {
  readonly #catalogDirectory: string | undefined;
  readonly #catalogStorage: NativePlaygroundCatalogStorage;
  readonly #catalogs = new Map<string, Promise<CatalogSnapshot>>();
  readonly #catalogPublications = new Map<string, NativePlaygroundCatalogPublicationReceipt>();
  /** Abort listeners run synchronously and cannot await the close they help complete. */
  readonly #abortReentryCompletion = Promise.resolve();
  readonly #controllers = new Set<AbortController>();
  readonly #runs = new Set<Promise<NativePlaygroundRunResult>>();
  readonly #discover: NonNullable<NativePlaygroundServiceOptions['discover']>;
  readonly #environment: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly #inspectArtifact: NonNullable<NativePlaygroundServiceOptions['inspectArtifact']>;
  readonly #native: NativePlaygroundServiceOptions['native'];
  readonly #planFixture: NonNullable<NativePlaygroundServiceOptions['planFixture']>;
  readonly #projectRoot: string;
  #abortDispatchDepth = 0;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: NativePlaygroundServiceOptions) {
    this.#catalogDirectory = options.catalogDirectory;
    this.#catalogStorage = options.catalogStorage ?? Object.freeze({ link, mkdir, open, remove: rm });
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

  /** Captures an epoch publication receipt without exposing native catalog contents. */
  async publishCatalogSnapshot(reference: NativePlaygroundEpochReference): Promise<NativePlaygroundCatalogPublicationReceipt> {
    this.#assertOpen();
    await this.#snapshot(reference);
    return this.#catalogPublications.get(reference.epoch.id) ?? await this.#acceptedPublicationReceipt(reference);
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
    const externalSignal = options.signal;
    const abortFromExternal = (): void => this.#dispatchAbort(controller, externalSignal.reason);
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    this.#controllers.add(controller);
    const running = this.#run(prepared, Object.freeze({ ...options, signal: controller.signal })).finally(() => {
      externalSignal.removeEventListener('abort', abortFromExternal);
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
  ): Promise<NativePlaygroundRunResult> {
    const signal = options.signal;
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
          onCompleted,
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
    if (this.#abortDispatchDepth > 0) return this.#abortReentryCompletion;
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    let resolvePromise!: () => void;
    let rejectPromise!: (reason: unknown) => void;
    const closing = new Promise<void>((resolvePromiseInput, rejectPromiseInput) => {
      resolvePromise = resolvePromiseInput;
      rejectPromise = rejectPromiseInput;
    });
    this.#closePromise = closing;
    void this.#close().then(resolvePromise, rejectPromise);
    return closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) {
      this.#dispatchAbort(controller, new Error('Native Playground service is closed.'));
    }
    await Promise.allSettled([...this.#runs, ...this.#catalogs.values()]);
    this.#catalogs.clear();
    this.#catalogPublications.clear();
  }

  #dispatchAbort(controller: AbortController, reason: unknown): void {
    this.#abortDispatchDepth += 1;
    try { controller.abort(reason); }
    finally { this.#abortDispatchDepth -= 1; }
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
    this.#assertOpen();
    const discovered = persisted ?? await this.#discoverSnapshot(reference);
    this.#assertOpen();
    const publication = persisted === undefined ? await this.#persistSnapshot(reference, discovered) : undefined;
    const snapshot = publication?.snapshot ?? persisted;
    if (snapshot === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
    const receipt = publication?.receipt ?? await this.#acceptedPublicationReceipt(reference);
    this.#catalogPublications.set(reference.epoch.id, receipt);
    try {
      this.#assertOpen();
      return await this.#hydrateSnapshot(artifact, snapshot);
    } catch (error) {
      return this.#rollbackPublicationAndThrow(receipt, error, 'Native Playground catalog hydration and rollback both failed.');
    }
  }

  async #discoverSnapshot(reference: NativePlaygroundEpochReference): Promise<PersistedCatalogSnapshot> {
    const suites = await this.#discover(this.#projectRoot);
    const selections: PersistedCatalogSelection[] = [];
    for (const discovered of suites) {
      for (const evalCase of discovered.suite.cases) {
        const fixturePlan = await this.#planFixture({ baseDir: this.#suiteDirectory(discovered.sourcePath), fixture: evalCase.fixture });
        const suiteDir = this.#suiteDirectory(discovered.sourcePath);
        const persistedEvalCase = normalizeEvalCase({
          ...evalCase,
          fixture: Object.freeze({
            ...evalCase.fixture,
            path: relativePathInside(suiteDir, resolve(suiteDir, evalCase.fixture.path), true),
          }),
        });
        const persistedFixturePlan = Object.freeze({
          digest: fixturePlan.digest,
          entries: Object.freeze(fixturePlan.entries.map((entry) => Object.freeze({ ...entry }))),
          git: fixturePlan.git,
          sourcePath: relativePathInside(suiteDir, fixturePlan.sourcePath, true),
        });
        for (const host of Object.keys(evalCase.hosts).filter((host): host is NativePlaygroundHost => nativeHosts.has(host as NativePlaygroundHost)).sort()) {
          const identity = catalogSelectionIdentity({
            epoch: reference.epoch,
            evalCase: persistedEvalCase,
            fixturePlan: persistedFixturePlan,
            host,
            suiteDigest: discovered.suite.digest,
            suiteName: discovered.suite.name,
          });
          selections.push(Object.freeze({
            caseId: identity.caseId,
            caseLabel: identity.caseLabel,
            evalCase: persistedEvalCase,
            fixtureId: identity.fixtureId,
            fixtureLabel: identity.fixtureLabel,
            fixturePlan: persistedFixturePlan,
            host,
            modelPinId: identity.modelPinId,
            modelPinLabel: identity.modelPinLabel,
            suiteDir: relativePathInside(this.#projectRoot, suiteDir, true),
            suiteDigest: discovered.suite.digest,
            suiteName: discovered.suite.name,
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
    });
  }

  async #hydrateSnapshot(
    artifact: Pick<PreparedEvalArtifact, 'binding' | 'root'>,
    snapshot: PersistedCatalogSnapshot,
  ): Promise<CatalogSnapshot> {
    const cases = new Map<string, NativePlaygroundCatalogItem>();
    const fixtures = new Map<string, NativePlaygroundCatalogItem>();
    const modelPins = new Map<string, NativePlaygroundModelPin>();
    const selections = new Map<string, CatalogSelection>();
    for (const persisted of snapshot.selections) {
      const selection = await this.#hydrateSelection(persisted);
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

  async #hydrateSelection(persisted: PersistedCatalogSelection): Promise<CatalogSelection> {
    const suiteDir = resolveContainedPath(this.#projectRoot, persisted.suiteDir, true);
    const sourcePath = resolveContainedPath(suiteDir, persisted.fixturePlan.sourcePath, true);
    await this.#assertLivePath(suiteDir, 'directory', this.#projectRoot);
    await this.#assertLivePath(sourcePath, 'directory', suiteDir);
    const entries = await Promise.all(persisted.fixturePlan.entries.map(async (entry) => {
      const source = resolveContainedPath(sourcePath, entry.path);
      await this.#assertLivePath(source, 'file', sourcePath);
      return Object.freeze({ ...entry });
    }));
    return Object.freeze({
      caseId: persisted.caseId,
      caseLabel: persisted.caseLabel,
      evalCase: persisted.evalCase,
      fixtureId: persisted.fixtureId,
      fixtureLabel: persisted.fixtureLabel,
      fixturePlan: Object.freeze({
        digest: persisted.fixturePlan.digest,
        entries: Object.freeze(entries),
        git: persisted.fixturePlan.git,
        sourcePath,
      }),
      host: persisted.host,
      modelPinId: persisted.modelPinId,
      modelPinLabel: persisted.modelPinLabel,
      suiteDir,
    });
  }

  async #assertLivePath(path: string, kind: 'directory' | 'file', root: string): Promise<void> {
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) {
      // A retained catalog remains browseable after authored sources disappear;
      // materialization will report its existing stable fixture failure later.
      if (isErrno(error, 'ENOENT')) return;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    }
    if (metadata.isSymbolicLink() || (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    try {
      if (!isInsideOrEqual(await realpath(root), await realpath(path))) {
        throw new Error('Native Playground catalog snapshot is invalid.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Native Playground catalog snapshot is invalid.') throw error;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    }
  }

  async #readSnapshot(reference: NativePlaygroundEpochReference): Promise<PersistedCatalogSnapshot | undefined> {
    const path = this.#snapshotPath(reference);
    await this.#assertCatalogDirectory(reference, dirname(path), true);
    const sidecar = await this.#readSidecar(path);
    if (sidecar === undefined) return undefined;
    let value: JsonValue;
    try { value = snapshotStrictJsonValue(parseJsonWithoutDuplicateKeys(sidecar.raw)); }
    catch { throw new Error('Native Playground catalog snapshot is invalid.'); }
    if (!isRecord(value) || !exactKeys(value, ['epochId', 'selections']) ||
      value.epochId !== reference.epoch.id || !Array.isArray(value.selections) || value.selections.length > maximumCatalogSelections) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    const selections = value.selections.map(persistedSelection);
    if (selections.some((selection) => selection === undefined)) throw new Error('Native Playground catalog snapshot is invalid.');
    const resolved = selections as PersistedCatalogSelection[];
    if (new Set(resolved.map(selectionKey)).size !== resolved.length || !resolved.every((selection) => hasCanonicalSelectionIdentity(reference.epoch, selection))) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    return Object.freeze({ epochId: value.epochId, selections: Object.freeze(resolved) });
  }

  async #readSidecar(path: string): Promise<SidecarFile | undefined> {
    let before;
    try { before = await lstat(path); }
    catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Native Playground catalog snapshot is invalid.');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('Native Playground catalog snapshot is invalid.');
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      return Object.freeze({ identity: digest({ contents: raw, dev: opened.dev, ino: opened.ino }), raw });
    } catch (error) {
      if (error instanceof Error && error.message === 'Native Playground catalog snapshot is invalid.') throw error;
      throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #persistSnapshot(
    reference: NativePlaygroundEpochReference,
    snapshot: PersistedCatalogSnapshot,
  ): Promise<PersistedCatalogPublication> {
    const path = this.#snapshotPath(reference);
    const directory = dirname(path);
    await this.#catalogStorage.mkdir(directory, { recursive: true });
    await this.#assertCatalogDirectory(reference, directory, false);
    const temporary = join(directory, `.${reference.epoch.id}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    let primary: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      handle = await this.#catalogStorage.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${stableJson(snapshot)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await this.#catalogStorage.link(temporary, path);
        created = true;
      }
      catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      await this.#syncCatalogDirectory(directory);
    } catch (error) {
      primary = error;
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); }
        catch (error) { cleanupFailures.push(error); }
      }
      try { await this.#catalogStorage.remove(temporary, { force: true }); }
      catch (error) { cleanupFailures.push(error); }
      if (primary !== undefined && created) {
        try {
          await (await this.#snapshotReceipt(reference, true)).rollback();
        } catch (error) { cleanupFailures.push(error); }
      }
    }
    if (primary !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError([primary, ...cleanupFailures], 'Native Playground catalog publication and cleanup both failed.', { cause: primary });
      }
      throw primary;
    }
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Native Playground catalog staging cleanup failed.', { cause: cleanupFailures[0] });
    const receipt = await this.#snapshotReceipt(reference, created);
    try {
      const persisted = await this.#readSnapshot(reference);
      if (persisted === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
      return Object.freeze({ receipt, snapshot: persisted });
    } catch (error) {
      return this.#rollbackPublicationAndThrow(receipt, error, 'Native Playground catalog validation and rollback both failed.');
    }
  }

  async #acceptedPublicationReceipt(reference: NativePlaygroundEpochReference): Promise<NativePlaygroundCatalogPublicationReceipt> {
    return this.#snapshotReceipt(reference, false);
  }

  async #snapshotReceipt(
    reference: NativePlaygroundEpochReference,
    created: boolean,
  ): Promise<NativePlaygroundCatalogPublicationReceipt> {
    const path = this.#snapshotPath(reference);
    await this.#assertCatalogDirectory(reference, dirname(path), false);
    const sidecar = await this.#readSidecar(path);
    if (sidecar === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
    return this.#publicationReceipt(path, sidecar.identity, created);
  }

  #publicationReceipt(
    path: string,
    identity: string,
    created: boolean,
  ): NativePlaygroundCatalogPublicationReceipt {
    return Object.freeze({
      created,
      identity,
      rollback: async () => {
        if (!created) return;
        const current = await this.#readSidecar(path);
        if (current === undefined || current.identity !== identity) return;
        await this.#catalogStorage.remove(path, { force: true });
      },
    });
  }

  async #syncCatalogDirectory(directory: string): Promise<void> {
    const handle = await this.#catalogStorage.open(directory, 'r');
    try {
      await handle.sync();
    } catch (error) {
      if (catalogDurabilityPlatform() === 'win32' && (isErrno(error, 'EACCES') || isErrno(error, 'EINVAL'))) return;
      throw error;
    } finally {
      await handle.close();
    }
  }

  async #rollbackPublicationAndThrow(
    receipt: NativePlaygroundCatalogPublicationReceipt,
    primary: unknown,
    message: string,
  ): Promise<never> {
    if (!receipt.created) throw primary;
    try { await receipt.rollback(); }
    catch (rollbackFailure) { throw new AggregateError([primary, rollbackFailure], message, { cause: rollbackFailure }); }
    throw primary;
  }

  #snapshotPath(reference: NativePlaygroundEpochReference): string {
    if (!safeEpochSegment.test(reference.epoch.id)) throw new Error('Native Playground epoch id is not safe for catalog storage.');
    const directory = this.#catalogDirectory ?? join(dirname(reference.root), '.metadata', 'native-playground');
    return join(directory, `${reference.epoch.id}.json`);
  }

  async #assertCatalogDirectory(
    reference: NativePlaygroundEpochReference,
    directory: string,
    allowMissing: boolean,
  ): Promise<void> {
    let metadata;
    try { metadata = await lstat(directory); }
    catch (error) {
      if (allowMissing && isErrno(error, 'ENOENT')) return;
      throw new Error('Native Playground catalog directory is invalid.', { cause: error });
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Native Playground catalog directory is invalid.');
    }
    if (this.#catalogDirectory !== undefined) return;
    try {
      const resolvedEpochRoot = await realpath(dirname(reference.root));
      const resolvedDirectory = await realpath(directory);
      if (!isInsideOrEqual(resolvedEpochRoot, resolvedDirectory)) {
        throw new Error('Native Playground catalog directory is invalid.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Native Playground catalog directory is invalid.') throw error;
      throw new Error('Native Playground catalog directory is invalid.', { cause: error });
    }
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

/** Captures the complete native selection set while its artifact epoch publishes. */
export const publishNativePlaygroundCatalogSnapshot = async (
  options: NativePlaygroundCatalogPublicationOptions,
): Promise<NativePlaygroundCatalogPublicationReceipt> => {
  const root = join(resolve(options.projectRoot), '.agent-bundle', 'epochs', options.epoch.id);
  const service = new NativePlaygroundService({
    ...(options.catalogDirectory === undefined ? {} : { catalogDirectory: options.catalogDirectory }),
    ...(options.catalogStorage === undefined ? {} : { catalogStorage: options.catalogStorage }),
    ...(options.discover === undefined ? {} : { discover: options.discover }),
    inspectArtifact: async (reference) => Object.freeze({
      binding: Object.freeze({
        manifestPath: join(reference.root, 'agent-bundle.manifest.json'),
        source: 'explicit' as const,
        targetDigests: reference.epoch.targetDigests,
      }),
      root: reference.root,
    }),
    ...(options.planFixture === undefined ? {} : { planFixture: options.planFixture }),
    projectRoot: options.projectRoot,
  });
  try {
    return await service.publishCatalogSnapshot(Object.freeze({ close: async () => undefined, epoch: options.epoch, root }));
  } finally {
    await service.close();
  }
};
