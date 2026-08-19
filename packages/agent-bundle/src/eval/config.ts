import { isAbsolute } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { isRecord, snapshotStrictJsonValue } from '../core/strict-json.ts';
import { findCredentialConfiguration } from './credentials.ts';
import { EvalConfigError } from './errors.ts';

export interface EvalSemanticGraderInput {
  readonly harness?: string;
  readonly model?: string;
}

export interface NormalizedEvalSemanticGrader {
  readonly harness: 'claude';
  readonly model: string;
}

export interface EvalConfigInput {
  readonly include?: readonly string[];
  readonly runsDir?: string;
  readonly semanticGrader?: EvalSemanticGraderInput;
}

export interface NormalizedEvalConfig {
  readonly diagnostics: readonly Diagnostic[];
  readonly include: readonly string[];
  readonly runsDir: string;
  readonly semanticGrader?: NormalizedEvalSemanticGrader;
}

export const defaultEvalInclude = Object.freeze(['evals/**/*.eval.ts']);
export const defaultEvalRunsDir = '.agent-bundle/runs';

const configKeys = Object.freeze(['include', 'runsDir', 'semanticGrader']);
const semanticModel = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const configError = (
  code: ConstructorParameters<typeof EvalConfigError>[0],
  message: string,
): EvalConfigError => new EvalConfigError(code, message);

const requireContainedRelativePath = (
  value: unknown,
  code: ConstructorParameters<typeof EvalConfigError>[0],
  label: string,
): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw configError(code, `${label} must be a non-empty string.`);
  }
  if (isAbsolute(value) || /^[a-z]:/iu.test(value)) {
    throw configError(code, `${label} must be relative to the project root.`);
  }
  if (value.split(/[/\\]/u).includes('..')) {
    throw configError(code, `${label} must not escape the project root.`);
  }
  return value;
};

const semanticGraderKeys = Object.freeze(['harness', 'model']);

const normalizeSemanticGrader = (value: unknown): NormalizedEvalSemanticGrader => {
  if (!isPlainRecord(value)) {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration semanticGrader must be an object.');
  }
  const unexpected = Object.keys(value).filter((key) => !semanticGraderKeys.includes(key)).sort();
  if (unexpected.length > 0 || Object.keys(value).length !== semanticGraderKeys.length) {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration semanticGrader must contain exactly "harness" and "model".');
  }
  if (value.harness !== 'claude') {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration semanticGrader harness must be "claude".');
  }
  if (typeof value.model !== 'string' || !semanticModel.test(value.model)) {
    throw configError(
      'EVAL_CONFIG_INVALID',
      'Eval configuration semanticGrader model must be a non-empty safe model identifier, not a path.',
    );
  }
  return Object.freeze({ harness: 'claude', model: value.model });
};

export const normalizeEvalConfig = (value: unknown): NormalizedEvalConfig => {
  if (value === undefined) {
    return Object.freeze({
      diagnostics: Object.freeze([]),
      include: defaultEvalInclude,
      runsDir: defaultEvalRunsDir,
    });
  }
  let snapshot: unknown;
  try {
    snapshot = snapshotStrictJsonValue(value);
  } catch {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration must be a detached plain JSON object.');
  }
  if (!isPlainRecord(snapshot)) throw configError('EVAL_CONFIG_INVALID', 'Eval configuration must be a plain object.');
  const found = findCredentialConfiguration(snapshot);
  if (found !== undefined) {
    throw configError(
      'EVAL_CREDENTIAL_REJECTED',
      `Eval configuration must not carry provider credential material (${found}). Agent Bundle reuses the host CLI's existing signed-in session.`,
    );
  }
  const unexpected = Object.keys(snapshot).filter((key) => !configKeys.includes(key)).sort();
  if (unexpected.length > 0) {
    throw configError('EVAL_CONFIG_INVALID', `Eval configuration does not accept ${JSON.stringify(unexpected)}.`);
  }

  const include = snapshot.include;
  if (include !== undefined && (!Array.isArray(include) || include.length === 0)) {
    throw configError('EVAL_INCLUDE_INVALID', 'Eval configuration include must be a non-empty array of patterns.');
  }
  const runsDir = snapshot.runsDir === undefined
    ? defaultEvalRunsDir
    : requireContainedRelativePath(snapshot.runsDir, 'EVAL_RUNS_DIR_INVALID', 'Eval configuration runsDir');
  const semanticGrader = Object.hasOwn(snapshot, 'semanticGrader')
    ? normalizeSemanticGrader(snapshot.semanticGrader)
    : undefined;

  return Object.freeze({
    diagnostics: Object.freeze([]),
    include: include === undefined
      ? defaultEvalInclude
      : Object.freeze([...new Set(include.map((pattern) =>
        requireContainedRelativePath(pattern, 'EVAL_INCLUDE_INVALID', 'Eval configuration include pattern')))].sort()),
    runsDir,
    ...(semanticGrader === undefined ? {} : { semanticGrader }),
  });
};
