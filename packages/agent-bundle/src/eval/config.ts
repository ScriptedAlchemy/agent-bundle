import { isAbsolute } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const requireRunsDirectory = (value: unknown): string => {
  const runsDir = requireContainedRelativePath(value, 'EVAL_RUNS_DIR_INVALID', 'Eval configuration runsDir');
  if (runsDir === '.') {
    throw configError('EVAL_RUNS_DIR_INVALID', 'Eval configuration runsDir must name a child directory of the project root.');
  }
  return runsDir;
};

const semanticGraderKeys = Object.freeze(['harness', 'model']);

const normalizeSemanticGrader = (value: unknown): NormalizedEvalSemanticGrader => {
  if (!isRecord(value)) {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration semanticGrader must be an object.');
  }
  const unexpected = Object.keys(value).filter((key) => !semanticGraderKeys.includes(key)).sort();
  if (unexpected.length > 0 || Object.keys(value).length !== semanticGraderKeys.length) {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration semanticGrader must contain exactly "harness" and "model".');
  }
  if (value.harness !== 'claude') {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration semanticGrader harness must be "claude".');
  }
  if (typeof value.model !== 'string' || value.model.trim().length === 0) {
    throw configError('EVAL_CONFIG_INVALID', 'Eval configuration semanticGrader model must be a non-empty string.');
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
  const found = findCredentialConfiguration(value);
  if (found !== undefined) {
    throw configError(
      'EVAL_CREDENTIAL_REJECTED',
      `Eval configuration must not carry provider credential material (${found}). Agent Bundle reuses the host CLI's existing signed-in session.`,
    );
  }
  if (!isRecord(value)) throw configError('EVAL_CONFIG_INVALID', 'Eval configuration must be a plain object.');
  const unexpected = Object.keys(value).filter((key) => !configKeys.includes(key)).sort();
  if (unexpected.length > 0) {
    throw configError('EVAL_CONFIG_INVALID', `Eval configuration does not accept ${JSON.stringify(unexpected)}.`);
  }

  const include = value.include;
  if (include !== undefined && (!Array.isArray(include) || include.length === 0)) {
    throw configError('EVAL_INCLUDE_INVALID', 'Eval configuration include must be a non-empty array of patterns.');
  }
  const runsDir = value.runsDir === undefined
    ? defaultEvalRunsDir
    : requireRunsDirectory(value.runsDir);
  const semanticGrader = Object.hasOwn(value, 'semanticGrader')
    ? normalizeSemanticGrader(value.semanticGrader)
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
