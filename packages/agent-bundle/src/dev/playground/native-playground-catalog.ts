import { isAbsolute, relative, resolve } from 'node:path';

import { digest } from '../../core/digest.ts';
import { isInsideOrEqual } from '../../core/paths.ts';
import { hasExactOwnKeys, isJsonRecord as isRecord, type JsonValue } from '../../core/strict-json.ts';
import type { EvalFixturePlan } from '../../eval/fixtures.ts';
import { normalizeEvalCase } from '../../eval/suite.ts';
import type { EvalCase } from '../../eval/types.ts';
import type { ArtifactEpoch } from '../types.ts';
import type {
  NativePlaygroundCatalogSelection,
  NativePlaygroundHost,
} from './native-playground-types.ts';

export interface CatalogSelection {
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

/** Persisted paths are deliberately relative to their owning project or suite. */
export interface PersistedFixturePlan {
  readonly digest: string;
  readonly entries: readonly EvalFixturePlan['entries'][number][];
  readonly git: boolean;
  readonly sourcePath: string;
}

export interface PersistedCatalogSelection {
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

export interface PersistedCatalogSnapshot {
  readonly epochId: string;
  readonly selections: readonly PersistedCatalogSelection[];
}

export const nativePlaygroundHosts = new Set<NativePlaygroundHost>(['claude', 'codex']);
export const maximumCatalogSelections = 256;
export const maximumCatalogSnapshotBytes = 8 * 1_024 * 1_024;
const maximumCatalogSnapshotNodes = 65_536;
const maximumFixtureEntries = 4_096;
const maximumSnapshotStringLength = 16_384;
const fixtureSha256Text = /^[a-f0-9]{64}$/u;

const isSafeRelativePath = (value: JsonValue | undefined, allowCurrentDirectory = false): value is string =>
  nonemptySnapshotText(value) &&
  !isAbsolute(value) &&
  (allowCurrentDirectory && value === '.' ||
    value !== '.' &&
    !value.split(/[\\/]/u).some((part) => part.length === 0 || part === '.' || part === '..'));

export const relativePathInside = (root: string, path: string, allowCurrentDirectory = false): string => {
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

export const resolveContainedPath = (root: string, value: string, allowCurrentDirectory = false): string => {
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

export const catalogSelectionIdentity = (options: Readonly<{
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


export const selectionKey = (selection: NativePlaygroundCatalogSelection): string =>
  `${selection.caseId}\u0000${selection.fixtureId}\u0000${selection.host}\u0000${selection.modelPinId}`;

const nonemptySnapshotText = (value: JsonValue | undefined): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximumSnapshotStringLength;

export const hasExactKeys = (value: Readonly<Record<string, JsonValue>>, keys: readonly string[]): boolean =>
  hasExactOwnKeys(value, keys);

export const withinCatalogSnapshotNodeBudget = (root: unknown): boolean => {
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

const activationEvidence = (value: JsonValue | undefined): value is 'inferred' | 'observed' | 'unavailable' =>
  value === 'inferred' || value === 'observed' || value === 'unavailable';

const safeInteger = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

const persistedAssertion = (value: JsonValue): EvalCase['assertions'][number] | undefined => {
  if (!isRecord(value) || !nonemptySnapshotText(value.id) || !activationEvidence(value.minimumEvidence) || typeof value.kind !== 'string') return undefined;
  if (value.kind === 'exit-code' && hasExactKeys(value, ['expected', 'id', 'kind', 'minimumEvidence']) && safeInteger(value.expected)) {
    return Object.freeze({ expected: value.expected, id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence });
  }
  if (value.kind === 'mcp-call' && hasExactKeys(value, ['atLeast', 'id', 'kind', 'minimumEvidence', 'server', 'tool']) &&
    safeInteger(value.atLeast) && value.atLeast >= 0 && nonemptySnapshotText(value.server) && nonemptySnapshotText(value.tool)) {
    return Object.freeze({ atLeast: value.atLeast, id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence, server: value.server, tool: value.tool });
  }
  if (value.kind === 'no-mcp-call' && nonemptySnapshotText(value.server) &&
    ((hasExactKeys(value, ['id', 'kind', 'minimumEvidence', 'server'])) ||
      (hasExactKeys(value, ['id', 'kind', 'minimumEvidence', 'server', 'tool']) && nonemptySnapshotText(value.tool)))) {
    return Object.freeze({
      ...(value.tool === undefined ? {} : { tool: value.tool as string }),
      id: value.id,
      kind: value.kind,
      minimumEvidence: value.minimumEvidence,
      server: value.server,
    });
  }
  if (value.kind === 'no-skill-activation' &&
    ((hasExactKeys(value, ['id', 'kind', 'minimumEvidence'])) || (hasExactKeys(value, ['id', 'kind', 'minimumEvidence', 'skill']) && nonemptySnapshotText(value.skill)))) {
    return Object.freeze({ ...(value.skill === undefined ? {} : { skill: value.skill as string }), id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence });
  }
  if (value.kind === 'outcome' && hasExactKeys(value, ['id', 'kind', 'minimumEvidence', 'script']) && nonemptySnapshotText(value.script)) {
    return Object.freeze({ id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence, script: value.script });
  }
  if (value.kind === 'skill-activation' && hasExactKeys(value, ['id', 'kind', 'minimumEvidence', 'skill']) && nonemptySnapshotText(value.skill)) {
    return Object.freeze({ id: value.id, kind: value.kind, minimumEvidence: value.minimumEvidence, skill: value.skill });
  }
  return undefined;
};

const persistedEvalCase = (value: JsonValue): EvalCase | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, ['assertions', 'digest', 'fixture', 'hosts', 'id', 'invocation', 'prompt', 'trials']) ||
    !Array.isArray(value.assertions) || value.assertions.length > maximumFixtureEntries ||
    !nonemptySnapshotText(value.digest) || !nonemptySnapshotText(value.id) || !nonemptySnapshotText(value.prompt) ||
    !safeInteger(value.trials) || value.trials < 1 || !isRecord(value.fixture) || !isRecord(value.hosts) || !isRecord(value.invocation)) return undefined;
  if (!hasExactKeys(value.fixture, ['git', 'include', 'path']) || typeof value.fixture.git !== 'boolean' ||
    !Array.isArray(value.fixture.include) || value.fixture.include.length > maximumFixtureEntries ||
    !value.fixture.include.every(nonemptySnapshotText) || !isSafeRelativePath(value.fixture.path, true)) return undefined;
  const hostEntries = Object.entries(value.hosts);
  if (hostEntries.length > maximumFixtureEntries || hostEntries.some(([host, binding]) => !nonemptySnapshotText(host) ||
    !isRecord(binding) || !hasExactKeys(binding, ['model']) || !nonemptySnapshotText(binding.model))) return undefined;
  const invocation = value.invocation;
  if (!((invocation.mode === 'automatic' || invocation.mode === 'none') && hasExactKeys(invocation, ['mode'])) &&
    !(invocation.mode === 'explicit' && hasExactKeys(invocation, ['mode', 'skill']) && nonemptySnapshotText(invocation.skill))) return undefined;
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
  if (!isRecord(value) || !hasExactKeys(value, ['digest', 'entries', 'git', 'sourcePath']) ||
    !nonemptySnapshotText(value.digest) || typeof value.git !== 'boolean' || !isSafeRelativePath(value.sourcePath, true) ||
    !Array.isArray(value.entries) || value.entries.length > maximumFixtureEntries) return undefined;
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['executable', 'path', 'sha256']) || typeof entry.executable !== 'boolean' ||
      !isSafeRelativePath(entry.path) || typeof entry.sha256 !== 'string' || !fixtureSha256Text.test(entry.sha256)) return undefined;
    return Object.freeze({ executable: entry.executable, path: entry.path, sha256: entry.sha256 });
  });
  if (entries.some((entry) => entry === undefined) || new Set(entries.map((entry) => entry?.path)).size !== entries.length) return undefined;
  const normalizedEntries = Object.freeze(entries as EvalFixturePlan['entries'][number][]);
  return digest({ entries: normalizedEntries, git: value.git }) === value.digest
    ? Object.freeze({ digest: value.digest, entries: normalizedEntries, git: value.git, sourcePath: value.sourcePath })
    : undefined;
};

export const persistedSelection = (value: JsonValue): PersistedCatalogSelection | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, [
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

export const hasCanonicalSelectionIdentity = (epoch: ArtifactEpoch, selection: PersistedCatalogSelection): boolean => {
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
