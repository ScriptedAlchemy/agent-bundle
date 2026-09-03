import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { digest, stableJson } from '../../core/digest.ts';
import { hasExactOwnKeys, isJsonRecord, parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue, type JsonValue } from '../../core/strict-json.ts';
import { loadConfig } from '../../config/load.ts';
import type { PreparedEvalArtifact } from '../../eval/artifact.ts';
import { runClaudeTrial } from '../../eval/claude-harness.ts';
import { runCodexEvalTrial, type CodexCommandRunner } from '../../eval/codex-harness.ts';
import { normalizeEvalConfig } from '../../eval/config.ts';
import { redactEvalCredentialText } from '../../eval/credentials.ts';
import { discoverEvalSuites, type DiscoveredEvalSuite } from '../../eval/discovery.ts';
import { planEvalFixture, type EvalFixturePlan } from '../../eval/fixtures.ts';
import { provenanceIdentifierPattern } from '../../eval/provenance.ts';
import type { EvalTrialRecord, EvalTrialWriter } from '../../eval/run-store.ts';
import { normalizeEvalCase } from '../../eval/suite.ts';
import type { EvalCase } from '../../eval/types.ts';
import type { NativeClaudeProcessRunner } from '../../host-contracts/native-claude-contract.ts';
import { NATIVE_HOSTS } from '../../host-contracts/native-hosts.ts';
import type { PlaygroundEventInput, PlaygroundJsonObject } from './playground-store.ts';
import type { NativePlaygroundHost } from './native-playground-types.ts';
import { safeDevWireText } from '../logs/dev-log-service.ts';
import type { ArtifactEpoch } from '../types.ts';
import { workspaceDiff, type WorkspaceDiff } from '../../eval/workspace-diff.ts';
import { isErrno } from '../../core/errors.ts';
import { isInsideOrEqual, sameFile } from '../../core/paths.ts';

export type { NativePlaygroundHost } from './native-playground-types.ts';

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
  /** @internal How long a reader waits for a concurrent hard-link publisher before recovering an abandoned staging link. */
  readonly catalogStagingSettleDeadlineMs?: number;
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

export interface NativePlaygroundCatalogStorage {
  readonly link: typeof link;
  readonly mkdir: typeof mkdir;
  /** @internal Deterministic rollback-race seam. */
  readonly move?: typeof rename;
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

interface PersistedCatalogSelection {
  readonly caseId: string;
  readonly caseLabel: string;
  readonly evalCase: EvalCase;
  readonly fixtureId: string;
  readonly fixtureLabel: string;
  readonly fixturePlan: EvalFixturePlan;
  readonly host: NativePlaygroundHost;
  readonly modelPinId: string;
  readonly modelPinLabel: string;
  readonly suiteCaseDigests: readonly string[];
  readonly suiteDigest: string;
  readonly suiteName: string;
  readonly suiteSourcePath: string;
}

interface CatalogSelection extends PersistedCatalogSelection {
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

const nativeHosts = new Set<NativePlaygroundHost>(NATIVE_HOSTS);
const catalogDurabilityPlatformKey = Symbol.for('agent-bundle.native-playground-service.catalog-durability-platform');
const maximumCatalogSelections = 256;
const maximumCatalogSnapshotBytes = 8 * 1_024 * 1_024;
/** How long a reader waits for a hard-link publisher to release its staging link before treating it as abandoned. */
const stagingPublicationSettleDeadlineMs = 5_000;
const stagingPublicationPollMs = 10;

/**
 * Whether the publisher named by a `.<epoch>.stage-<pid>-<nonce>` entry is
 * gone. The current process and any pid that still answers signal 0 (or that
 * this user may not signal) count as alive; only a missing process is exited.
 */
const stagingPublisherExited = (stagingEntry: string): boolean => {
  const pid = Number(/\.stage-(\d+)-/u.exec(stagingEntry)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, 'ESRCH');
  }
};
const maximumCatalogSnapshotNodes = 65_536;
const maximumFixtureEntries = 4_096;
const maximumSnapshotDepth = 16;
const maximumSnapshotStringLength = 16_384;
const maximumNativeEvidenceEntries = 64;
const maximumNativeEvidenceTextBytes = 4 * 1024;
const maximumNativeResponseBytes = 256 * 1024;
const sha256 = /^[a-f0-9]{64}$/u;
const safeEpochSegment = /^[a-z0-9][a-z0-9._-]*$/iu;
const safeIdentifier = /^[a-z0-9][a-z0-9._-]*$/iu;
const catalogOpenFlags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);

const catalogDurabilityPlatform = (): NodeJS.Platform => {
  if (process.env.NODE_ENV !== 'test') return process.platform;
  const platforms = globalThis as typeof globalThis & Record<symbol, NodeJS.Platform | undefined>;
  return platforms[catalogDurabilityPlatformKey] ?? process.platform;
};

const containedPath = (root: string, candidate: string, allowRoot = false): boolean => {
  const path = relative(resolve(root), resolve(candidate));
  return (allowRoot && path.length === 0) || (
    path.length > 0 && !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
  );
};

const safeRelativePath = (value: string): boolean => {
  const segments = value.split('/');
  return value.length > 0 && !isAbsolute(value) && !/^[a-z]:/iu.test(value) && !value.includes('\\') && !value.includes('\0')
    && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && segments.join('/') === value;
};

const projectRelativePath = (projectRoot: string, candidate: string): string | undefined => {
  if (!containedPath(projectRoot, candidate)) return undefined;
  const path = relative(resolve(projectRoot), resolve(candidate)).replaceAll('\\', '/');
  return safeRelativePath(path) ? path : undefined;
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  const suffix = '…';
  const budget = maximumBytes - Buffer.byteLength(suffix, 'utf8');
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return `${result}${suffix}`;
};

const safeNativeEvidenceText = (value: string, projectRoot: string): string =>
  truncateUtf8(safeDevWireText(value, projectRoot), maximumNativeEvidenceTextBytes);

const truncated = (length: number): Readonly<{ readonly truncated: true }> | Readonly<Record<string, never>> =>
  length > maximumNativeEvidenceEntries ? Object.freeze({ truncated: true as const }) : Object.freeze({});

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
                contractRevision: safeNativeProvenanceText(semanticGrader.contractRevision, projectRoot),
                id: safeNativeProvenanceText(semanticGrader.id, projectRoot),
                model: safeNativeProvenanceText(semanticGrader.model, projectRoot),
              }) }),
      }),
    model: safeNativeProvenanceText(trial.model, projectRoot),
  });
};

/** A completed response is user-facing evidence, but never a raw host stream. */
const safeResponse = (value: string): string => truncateUtf8(
  redactEvalCredentialText(value)
    .replace(/(?:[A-Za-z]:)?(?:[/\\][^\s`'"<>|]*)+/gu, '[path]')
    .replaceAll('\0', ''),
  maximumNativeResponseBytes,
);

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
      activated: Object.freeze(trial.evidence.skillActivation.activated
        .slice(0, maximumNativeEvidenceEntries)
        .map((name) => safeNativeEvidenceText(name, projectRoot))),
      level: trial.evidence.skillActivation.level,
      ...truncated(trial.evidence.skillActivation.activated.length),
    }),
    source: 'skill-evidence',
    summary: 'Recorded normalized native Skill activation evidence.',
  }),
  Object.freeze({
    kind: 'native.mcp',
    raw: Object.freeze({
      calls: Object.freeze(trial.evidence.mcp.calls.slice(0, maximumNativeEvidenceEntries).map((call) => Object.freeze({
        server: safeNativeEvidenceText(call.server, projectRoot),
        tool: safeNativeEvidenceText(call.tool, projectRoot),
      }))),
      level: trial.evidence.mcp.level,
      ...truncated(trial.evidence.mcp.calls.length),
    }),
    source: 'mcp',
    summary: 'Recorded normalized native MCP evidence.',
  }),
  Object.freeze({
    kind: 'native.assertions',
    raw: Object.freeze({
      assertions: Object.freeze(trial.assertions.slice(0, maximumNativeEvidenceEntries).map((assertion) => Object.freeze({
        evidence: assertion.evidence,
        id: safeNativeEvidenceText(assertion.assertionId, projectRoot),
        kind: safeNativeEvidenceText(assertion.kind, projectRoot),
        outcome: assertion.outcome,
      }))),
      ...truncated(trial.assertions.length),
    }),
    source: 'diagnostics',
    summary: 'Recorded normalized native assertion evidence.',
  }),
  ...(hookEvents.length === 0
    ? []
    : [Object.freeze({
      kind: 'native.hooks',
      raw: Object.freeze({
        events: Object.freeze(hookEvents.slice(0, maximumNativeEvidenceEntries)
          .map((event) => safeNativeEvidenceText(event, projectRoot))),
        ...truncated(hookEvents.length),
      }),
      source: 'hook' as const,
      summary: 'Recorded normalized native Hook evidence.',
    })]),
  ...(Object.keys(trial.evidence.scripts.results).length === 0
    ? []
    : [Object.freeze({
      kind: 'native.scripts',
      raw: Object.freeze({
        level: trial.evidence.scripts.level,
        results: Object.freeze(Object.entries(trial.evidence.scripts.results)
          .slice(0, maximumNativeEvidenceEntries)
          .map(([id, result]) => Object.freeze({
          detail: safeNativeEvidenceText(result.detail, projectRoot),
          id: safeNativeEvidenceText(id, projectRoot),
          outcome: result.outcome,
        }))),
        ...truncated(Object.keys(trial.evidence.scripts.results).length),
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

const isRecord = isJsonRecord;

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

const exactKeys: (value: Readonly<Record<string, JsonValue>>, keys: readonly string[]) => boolean =
  hasExactOwnKeys;

const withinCatalogSnapshotNodeBudget = (root: unknown): boolean => {
  let remaining = maximumCatalogSnapshotNodes;
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    remaining -= 1;
    if (remaining < 0) return false;
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const entry of value) pending.push(entry);
    } else if (typeof value === 'object' && value !== null) {
      for (const entry of Object.values(value)) pending.push(entry);
    }
  }
  return true;
};

const persistedFixturePlan = (
  value: JsonValue,
  evalCase: EvalCase,
  suiteDir: string,
): EvalFixturePlan | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['digest', 'entries', 'git', 'sourcePath']) ||
    !nonemptySnapshotText(value.digest) || !sha256.test(value.digest) ||
    !Array.isArray(value.entries) || value.entries.length > maximumFixtureEntries ||
    typeof value.git !== 'boolean' || value.git !== evalCase.fixture.git || !nonemptySnapshotText(value.sourcePath)) return undefined;
  const expectedSourcePath = resolve(suiteDir, evalCase.fixture.path);
  if (resolve(value.sourcePath) !== expectedSourcePath || !containedPath(suiteDir, expectedSourcePath)) return undefined;
  const entries = value.entries.map((entry): EvalFixturePlan['entries'][number] | undefined => {
    if (!isRecord(entry) || !exactKeys(entry, ['executable', 'path', 'sha256']) ||
      typeof entry.executable !== 'boolean' || !nonemptySnapshotText(entry.path) || !safeRelativePath(entry.path) ||
      !nonemptySnapshotText(entry.sha256) || !sha256.test(entry.sha256)) return undefined;
    return Object.freeze({ executable: entry.executable, path: entry.path, sha256: entry.sha256 });
  });
  if (entries.some((entry) => entry === undefined)) return undefined;
  const resolvedEntries = entries as EvalFixturePlan['entries'][number][];
  const paths = resolvedEntries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]!.localeCompare(path) >= 0)) {
    return undefined;
  }
  const frozenEntries = Object.freeze(resolvedEntries);
  if (digest({ entries: frozenEntries, git: value.git }) !== value.digest) return undefined;
  return Object.freeze({ digest: value.digest, entries: frozenEntries, git: value.git, sourcePath: expectedSourcePath });
};

const persistedSelection = (
  value: JsonValue,
  reference: NativePlaygroundEpochReference,
  projectRoot: string,
): PersistedCatalogSelection | undefined => {
  if (!isRecord(value) || !exactKeys(value, [
    'caseId', 'caseLabel', 'evalCase', 'fixtureId', 'fixtureLabel', 'fixturePlan', 'host', 'modelPinId', 'modelPinLabel',
    'suiteCaseDigests', 'suiteDigest', 'suiteName', 'suiteSourcePath',
  ])) return undefined;
  if (
    !nonemptySnapshotText(value.caseId) || !nonemptySnapshotText(value.caseLabel) ||
    !nonemptySnapshotText(value.fixtureId) || !nonemptySnapshotText(value.fixtureLabel) ||
    !nonemptySnapshotText(value.modelPinId) || !nonemptySnapshotText(value.modelPinLabel) ||
    !Array.isArray(value.suiteCaseDigests) || value.suiteCaseDigests.length === 0 ||
    !nonemptySnapshotText(value.suiteDigest) || !sha256.test(value.suiteDigest) ||
    !nonemptySnapshotText(value.suiteName) || !safeIdentifier.test(value.suiteName) ||
    !nonemptySnapshotText(value.suiteSourcePath) || !safeRelativePath(value.suiteSourcePath) ||
    (value.host !== 'claude' && value.host !== 'codex') ||
    !isRecord(value.evalCase) || !isRecord(value.fixturePlan) ||
    !boundedJson(value.evalCase) || !boundedJson(value.fixturePlan)
  ) return undefined;
  const suiteCaseDigests = value.suiteCaseDigests;
  if (suiteCaseDigests.some((entry) => typeof entry !== 'string' || !sha256.test(entry)) ||
    new Set(suiteCaseDigests).size !== suiteCaseDigests.length ||
    digest({ cases: suiteCaseDigests, name: value.suiteName }) !== value.suiteDigest) return undefined;
  let evalCase: EvalCase;
  try { evalCase = normalizeEvalCase(value.evalCase as unknown as EvalCase); }
  catch { return undefined; }
  if (evalCase.digest !== value.evalCase.digest || stableJson(evalCase) !== stableJson(value.evalCase) ||
    !suiteCaseDigests.includes(evalCase.digest)) return undefined;
  const suiteSourcePath = resolve(projectRoot, value.suiteSourcePath);
  if (!containedPath(projectRoot, suiteSourcePath)) return undefined;
  const suiteDir = dirname(suiteSourcePath);
  const fixturePlan = persistedFixturePlan(value.fixturePlan, evalCase, suiteDir);
  const model = evalCase.hosts[value.host]?.model;
  if (fixturePlan === undefined || model === undefined ||
    value.caseLabel !== `${value.suiteName} / ${evalCase.id}` || value.fixtureLabel !== value.caseLabel ||
    value.modelPinLabel !== `${value.host} pinned model` ||
    value.caseId !== opaqueId(reference.epoch, 'case', { digest: evalCase.digest, suite: value.suiteDigest }) ||
    value.fixtureId !== opaqueId(reference.epoch, 'fixture', { case: evalCase.digest, digest: fixturePlan.digest }) ||
    value.modelPinId !== opaqueId(reference.epoch, 'model', { case: evalCase.digest, host: value.host, model })) return undefined;
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
    suiteCaseDigests: Object.freeze([...suiteCaseDigests]),
    suiteDigest: value.suiteDigest,
    suiteName: value.suiteName,
    suiteSourcePath: value.suiteSourcePath,
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
  readonly #catalogMove: typeof rename;
  readonly #catalogStorage: NativePlaygroundCatalogStorage;
  readonly #catalogs = new Map<string, Promise<CatalogSnapshot>>();
  readonly #catalogPublications = new Map<string, NativePlaygroundCatalogPublicationReceipt>();
  readonly #cleanupFailures = new Set<unknown>();
  readonly #closeReason = new Error('Native Playground service is closed.');
  /** Abort listeners run synchronously and cannot await the close they help complete. */
  readonly #abortReentryCompletion = Promise.resolve();
  readonly #discover: NonNullable<NativePlaygroundServiceOptions['discover']>;
  readonly #environment: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly #inspectArtifact: NonNullable<NativePlaygroundServiceOptions['inspectArtifact']>;
  readonly #native: NativePlaygroundServiceOptions['native'];
  readonly #operations = new Set<NativePlaygroundOperation>();
  readonly #planFixture: NonNullable<NativePlaygroundServiceOptions['planFixture']>;
  readonly #projectRoot: string;
  readonly #removeWorkspace: NonNullable<NativePlaygroundServiceOptions['removeWorkspace']>;
  readonly #stagingSettleDeadlineMs: number;
  #abortDispatchDepth = 0;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: NativePlaygroundServiceOptions) {
    this.#catalogDirectory = options.catalogDirectory;
    this.#catalogStorage = options.catalogStorage ?? Object.freeze({ link, mkdir, open, remove: rm });
    this.#stagingSettleDeadlineMs = options.catalogStagingSettleDeadlineMs ?? stagingPublicationSettleDeadlineMs;
    this.#catalogMove = options.catalogStorage?.move ?? rename;
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
    const externalSignal = options.signal;
    const abortFromExternal = (): void => this.#dispatchAbort(controller, externalSignal.reason);
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    const signal = controller.signal;
    let nativeRoot: string | undefined;
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
      nativeRoot = await this.#createWorkspaceRoot();
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
      try {
        if (nativeRoot !== undefined) await this.#cleanupWorkspace(nativeRoot);
      } finally {
        externalSignal.removeEventListener('abort', abortFromExternal);
        this.#operations.delete(operation);
        operation.settle();
      }
    }
  }

  close(): Promise<void> {
    const reentrantAbortListener = this.#abortDispatchDepth > 0;
    if (this.#closePromise === undefined) {
      let resolvePromise!: () => void;
      let rejectPromise!: (reason: unknown) => void;
      const closing = new Promise<void>((resolvePromiseInput, rejectPromiseInput) => {
        resolvePromise = resolvePromiseInput;
        rejectPromise = rejectPromiseInput;
      });
      this.#closePromise = closing;
      void this.#close().then(resolvePromise, rejectPromise);
    }
    return reentrantAbortListener ? this.#abortReentryCompletion : this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const operations = [...this.#operations];
    const catalogs = [...this.#catalogs.values()];
    for (const operation of operations) this.#dispatchAbort(operation.controller, this.#closeReason);
    const results = await Promise.allSettled([
      ...operations.map((operation) => operation.settled),
      ...catalogs,
    ]);
    this.#catalogs.clear();
    this.#catalogPublications.clear();
    const failures = [
      ...results.flatMap((result) =>
        result.status === 'rejected' && result.reason !== this.#closeReason ? [result.reason] : []),
      ...this.#cleanupFailures,
    ];
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Native Playground cleanup failed.', { cause: failures[0] });
    }
  }

  #dispatchAbort(controller: AbortController, reason: unknown): void {
    this.#abortDispatchDepth += 1;
    try { controller.abort(reason); }
    finally { this.#abortDispatchDepth -= 1; }
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
      return this.#hydrateSnapshot(artifact, snapshot);
    } catch (error) {
      this.#catalogPublications.delete(reference.epoch.id);
      return this.#rollbackPublicationAndThrow(
        receipt,
        error,
        'Native Playground catalog hydration and rollback both failed.',
      );
    }
  }

  async #discoverSnapshot(reference: NativePlaygroundEpochReference): Promise<PersistedCatalogSnapshot> {
    const suites = await this.#discover(this.#projectRoot);
    const selections: PersistedCatalogSelection[] = [];
    for (const discovered of suites) {
      const suiteSourcePath = projectRelativePath(this.#projectRoot, discovered.sourcePath);
      const suiteCaseDigests = Object.freeze(discovered.suite.cases.map((entry) => entry.digest));
      if (suiteSourcePath === undefined || digest({ cases: suiteCaseDigests, name: discovered.suite.name }) !== discovered.suite.digest) {
        throw new Error('Native Playground discovered an invalid eval suite.');
      }
      for (const authoredCase of discovered.suite.cases) {
        const evalCase = normalizeEvalCase(authoredCase);
        if (stableJson(evalCase) !== stableJson(authoredCase)) {
          throw new Error('Native Playground discovered an invalid eval case.');
        }
        const plannedFixture = await this.#planFixture({ baseDir: this.#suiteDirectory(discovered.sourcePath), fixture: evalCase.fixture });
        const fixturePlan = persistedFixturePlan(
          plannedFixture as unknown as JsonValue,
          evalCase,
          this.#suiteDirectory(discovered.sourcePath),
        );
        if (fixturePlan === undefined) {
          throw new Error('Native Playground discovered an invalid fixture plan.');
        }
        const caseId = opaqueId(reference.epoch, 'case', { digest: evalCase.digest, suite: discovered.suite.digest });
        const fixtureId = opaqueId(reference.epoch, 'fixture', { case: evalCase.digest, digest: fixturePlan.digest });
        const caseLabel = `${discovered.suite.name} / ${evalCase.id}`;
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
            suiteCaseDigests,
            suiteDigest: discovered.suite.digest,
            suiteName: discovered.suite.name,
            suiteSourcePath,
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
      selections.set(key, Object.freeze({
        ...selection,
        suiteDir: dirname(resolve(this.#projectRoot, selection.suiteSourcePath)),
      }));
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
    await this.#assertCatalogDirectory(reference, dirname(path), true);
    const sidecar = await this.#readSidecar(path);
    if (sidecar === undefined) return undefined;
    let value: JsonValue;
    try {
      const parsed = parseJsonWithoutDuplicateKeys(sidecar.raw);
      if (!withinCatalogSnapshotNodeBudget(parsed)) throw new Error('Native Playground catalog snapshot exceeds its cumulative value budget.');
      value = snapshotStrictJsonValue(parsed);
    }
    catch { throw new Error('Native Playground catalog snapshot is invalid.'); }
    if (!isRecord(value) || !exactKeys(value, ['epochId', 'selections']) ||
      value.epochId !== reference.epoch.id || !Array.isArray(value.selections) || value.selections.length > maximumCatalogSelections) {
      throw new Error('Native Playground catalog snapshot is invalid.');
    }
    const selections = value.selections.map((selection) => persistedSelection(selection, reference, this.#projectRoot));
    if (selections.some((selection) => selection === undefined)) throw new Error('Native Playground catalog snapshot is invalid.');
    const resolved = selections as PersistedCatalogSelection[];
    if (new Set(resolved.map(selectionKey)).size !== resolved.length) throw new Error('Native Playground catalog snapshot is invalid.');
    const suites = new Map<string, string>();
    const cases = new Map<string, string>();
    const fixtures = new Map<string, string>();
    const models = new Map<string, string>();
    const hosts = new Map<string, Set<NativePlaygroundHost>>();
    for (const selection of resolved) {
      const suiteIdentity = stableJson({
        caseDigests: selection.suiteCaseDigests,
        digest: selection.suiteDigest,
        name: selection.suiteName,
      });
      const caseIdentity = stableJson({
        evalCase: selection.evalCase,
        suiteDigest: selection.suiteDigest,
        suiteSourcePath: selection.suiteSourcePath,
      });
      const fixtureIdentity = stableJson({ caseId: selection.caseId, fixturePlan: selection.fixturePlan });
      const modelIdentity = stableJson({
        caseId: selection.caseId,
        host: selection.host,
        model: selection.evalCase.hosts[selection.host]?.model,
      });
      if (
        (suites.has(selection.suiteSourcePath) && suites.get(selection.suiteSourcePath) !== suiteIdentity) ||
        (cases.has(selection.caseId) && cases.get(selection.caseId) !== caseIdentity) ||
        (fixtures.has(selection.fixtureId) && fixtures.get(selection.fixtureId) !== fixtureIdentity) ||
        (models.has(selection.modelPinId) && models.get(selection.modelPinId) !== modelIdentity)
      ) throw new Error('Native Playground catalog snapshot is invalid.');
      suites.set(selection.suiteSourcePath, suiteIdentity);
      cases.set(selection.caseId, caseIdentity);
      fixtures.set(selection.fixtureId, fixtureIdentity);
      models.set(selection.modelPinId, modelIdentity);
      const selectedHosts = hosts.get(selection.caseId) ?? new Set<NativePlaygroundHost>();
      selectedHosts.add(selection.host);
      hosts.set(selection.caseId, selectedHosts);
    }
    for (const selection of resolved) {
      const expectedHosts = Object.keys(selection.evalCase.hosts)
        .filter((host): host is NativePlaygroundHost => nativeHosts.has(host as NativePlaygroundHost))
        .sort();
      const actualHosts = [...(hosts.get(selection.caseId) ?? [])].sort();
      if (stableJson(actualHosts) !== stableJson(expectedHosts)) throw new Error('Native Playground catalog snapshot is invalid.');
    }
    return Object.freeze({ epochId: value.epochId, selections: Object.freeze(resolved) });
  }

  async #readSidecar(path: string, allowMultipleLinks = false): Promise<SidecarFile | undefined> {
    try {
      const file = await open(path, catalogOpenFlags);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.nlink < 1 || metadata.size > maximumCatalogSnapshotBytes) {
          throw new Error('Native Playground catalog snapshot is invalid.');
        }
        if (!allowMultipleLinks && metadata.nlink !== 1) {
          const settled = await this.#awaitStagedPublication(file, path, metadata);
          if (settled === 'withdrawn') return undefined;
        }
        const buffer = Buffer.allocUnsafe(maximumCatalogSnapshotBytes + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > maximumCatalogSnapshotBytes) {
          throw new Error('Native Playground catalog snapshot is invalid.');
        }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
        return Object.freeze({
          identity: digest({ contents: raw, dev: metadata.dev, ino: metadata.ino }),
          raw,
        });
      } finally { await file.close(); }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      if (error instanceof Error && error.message === 'Native Playground catalog snapshot is invalid.') throw error;
      throw new Error('Native Playground catalog snapshot could not be read.', { cause: error });
    }
  }

  /**
   * Hard-link publication leaves a freshly linked sidecar doubly linked until
   * the winner releases its staging file, and that winner may still roll the
   * sidecar back if its directory fsync or staging cleanup fails. A concurrent
   * reader therefore treats a matching staging link as a publication in
   * progress: it waits until the still-open handle reports a single link with
   * the sidecar path still naming this inode (`settled`), or until the sidecar
   * was withdrawn or replaced (`withdrawn`). The extra link is accounted for by
   * identity — exactly one staging sibling of this epoch shares the sidecar's
   * dev/ino; any other extra link is hostile aliasing and stays rejected.
   *
   * A publisher that dies between `link()` and its staging cleanup leaves the
   * sidecar doubly linked forever. Once the deadline passes, a matching staging
   * link whose publisher pid (embedded in its name) is no longer running is an
   * abandoned publication: the sidecar was fsynced before it was linked, so the
   * reader withdraws the orphaned staging link and adopts it. A staging link
   * whose publisher is still alive keeps being rejected rather than yanked.
   */
  async #awaitStagedPublication(file: FileHandle, path: string, metadata: Stats): Promise<'settled' | 'withdrawn'> {
    const invalid = () => new Error('Native Playground catalog snapshot is invalid.');
    const settledOrWithdrawn = async () => ((await this.#sidecarStillLinked(path, metadata)) ? 'settled' as const : 'withdrawn' as const);
    if (metadata.nlink !== 2 || (await this.#stagingLinksFor(path, metadata)).length === 0) {
      if ((await file.stat()).nlink === 1) return settledOrWithdrawn();
      throw invalid();
    }
    const deadline = Date.now() + this.#stagingSettleDeadlineMs;
    for (;;) {
      await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, stagingPublicationPollMs); });
      const current = await file.stat();
      if (current.nlink < 1) return 'withdrawn';
      if (current.nlink === 1) return settledOrWithdrawn();
      if (current.nlink !== 2) throw invalid();
      const staging = await this.#stagingLinksFor(path, metadata);
      if (staging.length === 0) {
        if ((await file.stat()).nlink === 1) return settledOrWithdrawn();
        throw invalid();
      }
      if (!(await this.#sidecarStillLinked(path, metadata))) return 'withdrawn';
      if (Date.now() < deadline) continue;
      if (!staging.every((entry) => stagingPublisherExited(entry))) throw invalid();
      for (const entry of staging) await this.#catalogStorage.remove(join(dirname(path), entry), { force: true });
      // The exited publisher may never have fsynced the directory after link():
      // flush it here so a crash cannot keep the orphan and lose the sidecar.
      try {
        await this.#syncCatalogDirectory(dirname(path));
      } catch (error) {
        await this.#restoreStagingGuard(path, staging);
        throw new Error('Native Playground catalog snapshot is invalid.', { cause: error });
      }
      if ((await file.stat()).nlink === 1) return settledOrWithdrawn();
      throw invalid();
    }
  }

  /**
   * A recovery whose directory fsync failed has not made the orphan's removal
   * crash-durable, so the sidecar must not read as settled: re-create the
   * staging links it removed, and if even that fails, withdraw the sidecar.
   */
  async #restoreStagingGuard(path: string, staging: readonly string[]): Promise<void> {
    const restored = await Promise.allSettled(staging.map((entry) => this.#restoreStagingLink(path, entry)));
    const failures = restored.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
    if (failures.length === 0) return;
    try {
      await this.#catalogStorage.remove(path, { force: true });
      return;
    } catch (error) {
      failures.push(error);
    }
    // Last resort: a fresh guard under this process's pid keeps the sidecar
    // doubly linked (and recoverable once this process exits) rather than
    // leaving a singly linked file that the next reader would adopt.
    const guard = join(dirname(path), `.${basename(path, '.json')}.stage-${process.pid}-guard-${Math.random().toString(16).slice(2)}`);
    try {
      await this.#catalogStorage.link(path, guard);
    } catch (error) {
      failures.push(error);
      throw new AggregateError(failures, 'Native Playground catalog recovery could not keep the sidecar guarded.', { cause: error });
    }
  }

  /** Re-links one staging entry; a concurrent recoverer that already restored the same alias counts as success. */
  async #restoreStagingLink(path: string, entry: string): Promise<void> {
    const stagingPath = join(dirname(path), entry);
    try {
      await this.#catalogStorage.link(path, stagingPath);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      const [existing, sidecar] = await Promise.all([lstat(stagingPath), lstat(path)]);
      if (!existing.isFile() || !sameFile(existing, sidecar)) throw error;
    }
  }

  /** The epoch's own staging entries that alias this sidecar's inode. */
  async #stagingLinksFor(path: string, metadata: Stats): Promise<readonly string[]> {
    const directory = dirname(path);
    const stagingPrefix = `.${basename(path, '.json')}.stage-`;
    const matches: string[] = [];
    for (const entry of await readdir(directory)) {
      if (!entry.startsWith(stagingPrefix)) continue;
      try {
        const staged = await lstat(join(directory, entry));
        if (staged.isFile() && sameFile(staged, metadata)) matches.push(entry);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    return matches;
  }

  async #sidecarStillLinked(path: string, metadata: Stats): Promise<boolean> {
    try {
      const current = await lstat(path);
      return current.isFile() && sameFile(current, metadata);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async #persistSnapshot(
    reference: NativePlaygroundEpochReference,
    snapshot: PersistedCatalogSnapshot,
  ): Promise<PersistedCatalogPublication> {
    const path = this.#snapshotPath(reference);
    const directory = dirname(path);
    const contents = `${stableJson(snapshot)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > maximumCatalogSnapshotBytes) {
      throw new Error('Native Playground catalog snapshot is too large.');
    }
    await this.#catalogStorage.mkdir(directory, { recursive: true });
    await this.#assertCatalogDirectory(reference, directory, false);
    const temporary = join(directory, `.${reference.epoch.id}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    let publicationIdentity: string | undefined;
    let staged: Stats | undefined;
    let primary: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      handle = await this.#catalogStorage.open(temporary, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      staged = await handle.stat();
      if (!staged.isFile() || staged.nlink !== 1) {
        throw new Error('Native Playground catalog staging file is invalid.');
      }
      publicationIdentity = digest({ contents, dev: staged.dev, ino: staged.ino });
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
      // A failed publication withdraws its sidecar while the staging link still
      // exists: concurrent readers keep seeing an in-progress (doubly linked)
      // publication until the path is gone, never a settled singly linked file
      // that is about to be rolled back. If the rollback could not withdraw the
      // sidecar, the staging link stays in place for the same reason.
      let releaseStaging = true;
      if (primary !== undefined && created && publicationIdentity !== undefined) {
        try { await this.#publicationReceipt(path, publicationIdentity, true, true).rollback(); }
        catch (error) { cleanupFailures.push(error); }
        created = false;
        releaseStaging = staged === undefined || !(await this.#sidecarStillLinked(path, staged));
      }
      if (releaseStaging) {
        try { await this.#catalogStorage.remove(temporary, { force: true }); }
        catch (error) { cleanupFailures.push(error); }
      }
    }
    if (primary === undefined && cleanupFailures.length > 0 && created && publicationIdentity !== undefined) {
      try { await this.#publicationReceipt(path, publicationIdentity, true, true).rollback(); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (primary !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [primary, ...cleanupFailures],
          'Native Playground catalog publication and cleanup both failed.',
          { cause: primary },
        );
      }
      throw primary;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        'Native Playground catalog staging cleanup failed.',
        { cause: cleanupFailures[0] },
      );
    }
    const receipt = created && publicationIdentity !== undefined
      ? this.#publicationReceipt(path, publicationIdentity, true)
      : await this.#snapshotReceipt(reference, false);
    try {
      const persisted = await this.#readSnapshot(reference);
      if (persisted === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
      return Object.freeze({ receipt, snapshot: persisted });
    } catch (error) {
      return this.#rollbackPublicationAndThrow(
        receipt,
        error,
        'Native Playground catalog validation and rollback both failed.',
      );
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
    allowMultipleLinks = false,
  ): NativePlaygroundCatalogPublicationReceipt {
    return Object.freeze({
      created,
      identity,
      rollback: async () => {
        if (!created) return;
        await this.#rollbackPublication(path, identity, allowMultipleLinks);
      },
    });
  }

  async #rollbackPublication(path: string, identity: string, allowMultipleLinks: boolean): Promise<void> {
    const quarantineRoot = await mkdtemp(join(dirname(path), '.native-playground-rollback-'));
    const quarantined = join(quarantineRoot, 'catalog.json');
    let quarantineOccupied = false;
    let primary: unknown;
    try {
      try {
        await this.#catalogMove(path, quarantined);
        quarantineOccupied = true;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
      if (quarantineOccupied) {
        let current: SidecarFile | undefined;
        let inspectionFailure: unknown;
        try { current = await this.#readSidecar(quarantined, allowMultipleLinks); }
        catch (error) { inspectionFailure = error; }
        if (inspectionFailure === undefined && current?.identity === identity) {
          await this.#catalogStorage.remove(quarantined, { force: true });
          quarantineOccupied = false;
        } else {
          try { await this.#catalogStorage.link(quarantined, path); }
          catch (error) {
            throw new Error('Native Playground catalog rollback could not restore a replaced sidecar.', { cause: error });
          }
          try {
            await this.#catalogStorage.remove(quarantined, { force: true });
            quarantineOccupied = false;
          } catch (error) {
            throw new Error('Native Playground catalog rollback could not release its restored quarantine.', { cause: error });
          }
          if (inspectionFailure !== undefined) throw inspectionFailure;
        }
      }
    } catch (error) {
      primary = error;
    }
    let cleanupFailure: unknown;
    if (!quarantineOccupied) {
      try { await this.#catalogStorage.remove(quarantineRoot, { force: true, recursive: true }); }
      catch (error) { cleanupFailure = error; }
    }
    if (primary !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError(
        [primary, cleanupFailure],
        'Native Playground catalog rollback and quarantine cleanup both failed.',
        { cause: primary },
      );
    }
    if (primary !== undefined) throw primary;
    if (cleanupFailure !== undefined) throw cleanupFailure;
    await this.#syncCatalogDirectory(dirname(path));
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
    catch (rollbackFailure) {
      throw new AggregateError([primary, rollbackFailure], message, { cause: rollbackFailure });
    }
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
    if (this.#closed) throw this.#closeReason;
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
        manifestPath: reference.epoch.manifestPath,
        source: 'explicit' as const,
        targetDigests: reference.epoch.targetDigests,
      }),
      root: reference.root,
    }),
    ...(options.planFixture === undefined ? {} : { planFixture: options.planFixture }),
    projectRoot: options.projectRoot,
  });
  let receipt: NativePlaygroundCatalogPublicationReceipt | undefined;
  let primary: unknown;
  try {
    receipt = await service.publishCatalogSnapshot(Object.freeze({
      close: async () => undefined,
      epoch: options.epoch,
      root,
    }));
  }
  catch (error) { primary = error; }
  let closeFailure: unknown;
  try { await service.close(); }
  catch (error) { closeFailure = error; }
  if (primary !== undefined && closeFailure !== undefined) {
    throw new AggregateError(
      [primary, closeFailure],
      'Native Playground catalog publication and close both failed.',
      { cause: primary },
    );
  }
  if (primary !== undefined) throw primary;
  if (receipt === undefined) throw new Error('Native Playground catalog snapshot could not be persisted.');
  if (closeFailure !== undefined) {
    let rollbackFailure: unknown;
    try { await receipt.rollback(); }
    catch (error) { rollbackFailure = error; }
    if (rollbackFailure !== undefined) {
      throw new AggregateError(
        [closeFailure, rollbackFailure],
        'Native Playground catalog close and rollback both failed.',
        { cause: closeFailure },
      );
    }
    throw closeFailure;
  }
  return receipt;
};
