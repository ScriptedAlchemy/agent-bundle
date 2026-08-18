import { isAbsolute } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { findCredentialConfiguration } from './credentials.ts';
import { EvalConfigError } from './errors.ts';

export interface EvalSemanticGraderInput {
  readonly harness?: string;
  readonly model?: string;
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

/**
 * Native model-backed harnesses do not exist yet, so a configured semantic grader
 * is surfaced as an unsupported diagnostic instead of silently degrading to a
 * deterministic-only run that looks configured.
 */
const semanticGraderDiagnostic = (): Diagnostic => Object.freeze({
  code: 'AB9000',
  message: 'Model-backed eval semantic grader configuration is not supported yet and was ignored.',
  recovery: 'Remove evals.semanticGrader until a native Claude or Codex harness is available.',
  severity: 'warning',
});

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

  return Object.freeze({
    diagnostics: Object.freeze(value.semanticGrader === undefined ? [] : [semanticGraderDiagnostic()]),
    include: include === undefined
      ? defaultEvalInclude
      : Object.freeze([...new Set(include.map((pattern) =>
        requireContainedRelativePath(pattern, 'EVAL_INCLUDE_INVALID', 'Eval configuration include pattern')))].sort()),
    runsDir,
  });
};
