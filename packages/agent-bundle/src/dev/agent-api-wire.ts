// Typed wire projections for the Agent API.
//
// Each exported projection maps an already-typed internal value onto the exact
// DTO permitted on the wire, so the compiler verifies what can reach the wire.
// Redaction still fails closed at runtime: every input is detached through an
// accessor-free strict-JSON snapshot and every field must pass an allowlist
// validator before it is copied, so the wire stays path-free and secret-free
// even when a caller's value violates its compile-time type.

import { isRecord, snapshotStrictJsonValue } from '../core/strict-json.ts';
import type { EvalRunRecord } from '../eval/run-store.ts';
import type { ProjectStatus } from './types.ts';

/** Deliberately path-free epoch identity permitted on the Agent API wire. */
export interface AgentApiEpochSummary {
  readonly configDigest?: string;
  readonly createdAt?: string;
  readonly diagnostics?: Readonly<{ readonly errors: number; readonly infos: number; readonly warnings: number }>;
  readonly id: string;
  readonly modelDigest?: string;
  readonly projectRevision?: string;
  readonly targetDigests?: Readonly<Record<string, string>>;
}

export interface AgentApiDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly recovery?: string;
  readonly severity: 'error' | 'info' | 'warning';
  readonly target?: string;
}

export interface AgentApiRunningBuildAttempt {
  readonly diagnostics: readonly AgentApiDiagnostic[];
  readonly id: string;
  readonly outcome: 'running';
  readonly sourceRevision: string;
  readonly startedAt: string;
}

export interface AgentApiCompletedBuildAttempt {
  readonly completedAt: string;
  readonly diagnostics: readonly AgentApiDiagnostic[];
  readonly id: string;
  readonly outcome: 'failed' | 'succeeded';
  /** Present only for a succeeded attempt whose epoch identity is safe to name. */
  readonly result?: Readonly<{ readonly epoch: AgentApiEpochSummary }>;
  readonly sourceRevision: string;
  readonly startedAt: string;
}

export type AgentApiBuildAttempt = AgentApiCompletedBuildAttempt | AgentApiRunningBuildAttempt;

export type AgentApiArtifactStatus =
  | Readonly<{ readonly state: 'missing' }>
  | Readonly<{
      readonly activeEpoch?: AgentApiEpochSummary;
      readonly currentSourceRevision?: string;
      readonly state: 'active' | 'stale';
    }>;

export type AgentApiBuildStatus =
  | Readonly<{
      readonly activeAttempt: AgentApiBuildAttempt;
      readonly lastAttempt?: AgentApiBuildAttempt;
      readonly state: 'building';
    }>
  | Readonly<{ readonly lastAttempt: AgentApiBuildAttempt; readonly state: 'failed' }>
  | Readonly<{ readonly lastAttempt?: AgentApiBuildAttempt; readonly state: 'idle' }>;

export interface AgentApiSourceStatus {
  readonly diagnostics: readonly AgentApiDiagnostic[];
  readonly revision?: string;
  readonly state: 'invalid' | 'ready' | 'unknown';
}

export interface AgentApiProjectStatus {
  readonly artifact: AgentApiArtifactStatus;
  readonly build: AgentApiBuildStatus;
  readonly source: AgentApiSourceStatus;
}

/** Durable, path-free acknowledgement returned when an eval background job is admitted. */
export interface AgentApiEvalRunAdmission {
  readonly id: string;
  readonly status: 'admitted';
}

type AgentApiJsonRecord = Readonly<Record<string, unknown>>;

const maximumDiagnosticTextLength = 4_096;
const safeDiagnosticCodePattern = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const safeDigestPattern = /^[a-f0-9]{64}$/iu;
const safeEpochIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const safeTargetPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const safeTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const secretAssignmentPattern = /\b(?:api[_ -]?key|authorization|password|secret|token)\s*(?:=|:)/iu;
const diagnosticMessageFallback = 'Diagnostic details are available in the local workbench.';
const diagnosticRecoveryFallback = 'Recovery guidance is available in the local workbench.';

const wireError = (code: string, message: string): Error & Readonly<{ readonly code: string }> =>
  Object.assign(new Error(message), { code });

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const snapshotValue = (value: unknown): unknown => {
  try {
    return snapshotStrictJsonValue(value);
  } catch {
    return undefined;
  }
};

const snapshotRecord = (value: unknown): AgentApiJsonRecord | undefined => {
  const snapshot = snapshotValue(value);
  return isRecord(snapshot) ? snapshot as AgentApiJsonRecord : undefined;
};

const snapshotArray = (value: unknown): readonly unknown[] | undefined => {
  const snapshot = snapshotValue(value);
  return Array.isArray(snapshot) ? snapshot : undefined;
};

const safeDigest = (value: unknown): string | undefined =>
  typeof value === 'string' && safeDigestPattern.test(value) ? value : undefined;

const safeDiagnosticCode = (value: unknown): string | undefined =>
  typeof value === 'string' && safeDiagnosticCodePattern.test(value) ? value : undefined;

const safeEpochId = (value: unknown): string | undefined =>
  typeof value === 'string' && safeEpochIdPattern.test(value) ? value : undefined;

const safeTarget = (value: unknown): string | undefined =>
  typeof value === 'string' && safeTargetPattern.test(value) ? value : undefined;

const safeTimestamp = (value: unknown): string | undefined =>
  typeof value === 'string' && safeTimestampPattern.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : undefined;

/** Deliberately excludes run provenance, artifact bindings, and later execution results. */
export const evalRunAdmissionWireDto = (run: EvalRunRecord): AgentApiEvalRunAdmission => {
  const record = snapshotRecord(run);
  const id = safeEpochId(record?.id);
  if (id === undefined) {
    throw wireError('AGENT_API_OPERATION_FAILED', 'Eval admission did not return a durable run identity.');
  }
  return Object.freeze({ id, status: 'admitted' });
};

/** Messages fail closed: any path-like, control, or secret-assignment text is never partially redacted. */
const safeDiagnosticText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length <= maximumDiagnosticTextLength &&
    !value.includes('/') && !value.includes('\\') && !hasControlCharacter(value) &&
    !secretAssignmentPattern.test(value)
    ? value
    : fallback;

/** Dedicated, detached DTO: only diagnostic fields that can be safely named reach the wire. */
const diagnosticWireDto = (value: unknown): AgentApiDiagnostic | undefined => {
  const diagnostic = snapshotRecord(value);
  if (diagnostic === undefined) return undefined;
  const code = safeDiagnosticCode(diagnostic.code);
  const severity = diagnostic.severity;
  if (code === undefined || (severity !== 'error' && severity !== 'info' && severity !== 'warning')) return undefined;
  const recovery = typeof diagnostic.recovery === 'string'
    ? safeDiagnosticText(diagnostic.recovery, diagnosticRecoveryFallback)
    : undefined;
  const target = safeTarget(diagnostic.target);
  return Object.freeze({
    code,
    message: safeDiagnosticText(diagnostic.message, diagnosticMessageFallback),
    ...(recovery === undefined ? {} : { recovery }),
    severity,
    ...(target === undefined ? {} : { target }),
  });
};

const diagnosticWireDtos = (value: unknown): readonly AgentApiDiagnostic[] => Object.freeze(
  (snapshotArray(value) ?? []).flatMap((diagnostic) => {
    const projected = diagnosticWireDto(diagnostic);
    return projected === undefined ? [] : [projected];
  }),
);

const diagnosticSummaryWireDto = (value: unknown): AgentApiEpochSummary['diagnostics'] | undefined => {
  const summary = snapshotRecord(value);
  if (summary === undefined) return undefined;
  const errors = summary.errors;
  const infos = summary.infos;
  const warnings = summary.warnings;
  if (![errors, infos, warnings].every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return undefined;
  return Object.freeze({ errors: errors as number, infos: infos as number, warnings: warnings as number });
};

const targetDigestsWireDto = (value: unknown): Readonly<Record<string, string>> | undefined => {
  const targetDigests = snapshotRecord(value);
  if (targetDigests === undefined) return undefined;
  const entries = Object.entries(targetDigests);
  if (entries.length === 0 || entries.some(([target, digest]) => safeTarget(target) === undefined || safeDigest(digest) === undefined)) {
    return undefined;
  }
  return Object.freeze(Object.fromEntries(entries.map(([target, digest]) => [target, digest as string])));
};

/** Explicit safe epoch identity; manifest/root/source fields are intentionally not represented. */
const epochWireIdentity = (value: unknown): AgentApiEpochSummary | undefined => {
  const epoch = snapshotRecord(value);
  if (epoch === undefined) return undefined;
  const id = safeEpochId(epoch.id);
  if (id === undefined) return undefined;
  const configDigest = safeDigest(epoch.configDigest);
  const createdAt = safeTimestamp(epoch.createdAt);
  const diagnostics = diagnosticSummaryWireDto(epoch.diagnostics);
  const modelDigest = safeDigest(epoch.modelDigest);
  const projectRevision = safeDigest(epoch.projectRevision);
  const targetDigests = targetDigestsWireDto(epoch.targetDigests);
  return Object.freeze({
    ...(configDigest === undefined ? {} : { configDigest }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    id,
    ...(modelDigest === undefined ? {} : { modelDigest }),
    ...(projectRevision === undefined ? {} : { projectRevision }),
    ...(targetDigests === undefined ? {} : { targetDigests }),
  });
};

export const epochWireIdentities = (epochs: readonly AgentApiEpochSummary[]): readonly AgentApiEpochSummary[] => Object.freeze(
  (snapshotArray(epochs) ?? []).flatMap((epoch) => {
    const projected = epochWireIdentity(epoch);
    return projected === undefined ? [] : [projected];
  }),
);

const sourceWireDto = (value: unknown): AgentApiSourceStatus => {
  const source = snapshotRecord(value);
  const state = source?.state;
  const revision = safeDigest(source?.revision);
  return Object.freeze({
    diagnostics: diagnosticWireDtos(source?.diagnostics),
    ...(revision === undefined ? {} : { revision }),
    state: state === 'invalid' || state === 'ready' || state === 'unknown' ? state : 'unknown',
  });
};

const buildAttemptWireDto = (value: unknown): AgentApiBuildAttempt | undefined => {
  const attempt = snapshotRecord(value);
  if (attempt === undefined) return undefined;
  const outcome = attempt.outcome;
  const id = safeEpochId(attempt.id);
  const sourceRevision = safeDigest(attempt.sourceRevision);
  const startedAt = safeTimestamp(attempt.startedAt);
  if (id === undefined || sourceRevision === undefined || startedAt === undefined ||
    (outcome !== 'failed' && outcome !== 'running' && outcome !== 'succeeded')) return undefined;
  const completedAt = safeTimestamp(attempt.completedAt);
  if (outcome === 'running') {
    return Object.freeze({ diagnostics: diagnosticWireDtos(attempt.diagnostics), id, outcome, sourceRevision, startedAt });
  }
  if (completedAt === undefined) return undefined;
  const result = snapshotRecord(attempt.result);
  const epoch = epochWireIdentity(result?.epoch);
  return Object.freeze({
    completedAt,
    diagnostics: diagnosticWireDtos(attempt.diagnostics),
    id,
    outcome,
    ...(outcome === 'succeeded' && epoch !== undefined ? { result: Object.freeze({ epoch }) } : {}),
    sourceRevision,
    startedAt,
  });
};

const artifactWireDto = (value: unknown): AgentApiArtifactStatus => {
  const artifact = snapshotRecord(value);
  const state = artifact?.state;
  if (artifact === undefined || (state !== 'active' && state !== 'stale')) return Object.freeze({ state: 'missing' });
  const activeEpoch = epochWireIdentity(artifact.activeEpoch);
  const currentSourceRevision = safeDigest(artifact.currentSourceRevision);
  return Object.freeze({
    ...(activeEpoch === undefined ? {} : { activeEpoch }),
    ...(currentSourceRevision === undefined ? {} : { currentSourceRevision }),
    state,
  });
};

const buildWireDto = (value: unknown): AgentApiBuildStatus => {
  const build = snapshotRecord(value);
  const state = build?.state;
  const activeAttempt = buildAttemptWireDto(build?.activeAttempt);
  const lastAttempt = buildAttemptWireDto(build?.lastAttempt);
  if (state === 'building' && activeAttempt !== undefined) {
    return Object.freeze({ activeAttempt, ...(lastAttempt === undefined ? {} : { lastAttempt }), state });
  }
  if (state === 'failed' && lastAttempt !== undefined) return Object.freeze({ lastAttempt, state });
  return Object.freeze({ ...(lastAttempt === undefined ? {} : { lastAttempt }), state: 'idle' });
};

/** Explicit status DTO that carries only safe state, epoch identity, and projected diagnostics. */
export const projectStatusWireDto = (status: ProjectStatus): AgentApiProjectStatus => {
  const record = snapshotRecord(status);
  return Object.freeze({
    artifact: artifactWireDto(record?.artifact),
    build: buildWireDto(record?.build),
    source: sourceWireDto(record?.source),
  });
};

/** Flattens only known diagnostic arrays from a direct service result or a ProjectStatus-shaped result. */
export const diagnosticsListWireDto = (value: unknown): readonly AgentApiDiagnostic[] => {
  const result = snapshotRecord(value);
  if (result === undefined) return Object.freeze([]);
  const direct = snapshotArray(result.diagnostics);
  if (direct !== undefined) return diagnosticWireDtos(direct);
  const source = snapshotRecord(result.source);
  const build = snapshotRecord(result.build);
  const activeAttempt = snapshotRecord(build?.activeAttempt);
  const lastAttempt = snapshotRecord(build?.lastAttempt);
  return Object.freeze([
    ...diagnosticWireDtos(source?.diagnostics),
    ...diagnosticWireDtos(activeAttempt?.diagnostics),
    ...diagnosticWireDtos(lastAttempt?.diagnostics),
  ]);
};
