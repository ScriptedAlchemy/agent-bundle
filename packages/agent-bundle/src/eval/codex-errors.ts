import type { EvalHarnessFailure, EvalHarnessFailureCode, EvalHarnessFailureStage } from './types.ts';
import { deepFreeze } from '../core/freeze.ts';
import { YieldableCodedError } from '../effect/errors.ts';


export type CodexEvalHarnessErrorCode =
  | 'CODEX_ARTIFACT_INVALID'
  | 'CODEX_CLI_INCOMPATIBLE'
  | 'CODEX_CLI_MISSING'
  | 'CODEX_CLI_UNAUTHENTICATED'
  | 'CODEX_FIXTURE_UNAVAILABLE'
  | 'CODEX_HOME_MUTATED'
  | 'CODEX_PLUGIN_UNAVAILABLE'
  | 'CODEX_TRACE_INVALID'
  | 'CODEX_TRIAL_CANCELLED';

/** A defect in Agent Bundle or the installed Codex CLI, never evidence about the plugin. */
export class CodexEvalHarnessError extends YieldableCodedError<CodexEvalHarnessErrorCode> {
  constructor(code: CodexEvalHarnessErrorCode, message: string) {
    super('CodexEvalHarnessError', code, message);
  }
}

const failureShapes: Readonly<Record<
  CodexEvalHarnessErrorCode,
  Readonly<{ readonly code: EvalHarnessFailureCode; readonly message: string; readonly stage: EvalHarnessFailureStage }>
>> = deepFreeze({
  CODEX_ARTIFACT_INVALID: {
    code: 'EVAL_ARTIFACT_UNAVAILABLE',
    message: 'The Codex candidate artifact is unavailable.',
    stage: 'artifact',
  },
  CODEX_CLI_INCOMPATIBLE: {
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'The installed Codex CLI is not compatible with this eval harness.',
    stage: 'preflight',
  },
  CODEX_CLI_MISSING: {
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'The Codex CLI is not installed.',
    stage: 'preflight',
  },
  CODEX_CLI_UNAUTHENTICATED: {
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'The Codex CLI has no signed-in session.',
    stage: 'preflight',
  },
  CODEX_FIXTURE_UNAVAILABLE: {
    code: 'EVAL_FIXTURE_UNAVAILABLE',
    message: 'The trial fixture could not be materialized.',
    stage: 'fixture',
  },
  CODEX_HOME_MUTATED: {
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'The normal Codex session state changed during the trial.',
    stage: 'preflight',
  },
  CODEX_PLUGIN_UNAVAILABLE: {
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'The candidate is unavailable in the temporary Codex environment.',
    stage: 'preflight',
  },
  CODEX_TRACE_INVALID: {
    code: 'EVAL_TRACE_UNAVAILABLE',
    message: 'The Codex event stream could not be verified.',
    stage: 'trace',
  },
  CODEX_TRIAL_CANCELLED: {
    code: 'EVAL_TRACE_UNAVAILABLE',
    message: 'The Codex trial was cancelled before a complete trace was recorded.',
    stage: 'trace',
  },
});

/** Everything the native harness can go wrong at is a harness failure, so no trial blames the plugin. */
export const codexHarnessFailure = (error: unknown): EvalHarnessFailure => {
  if (error instanceof CodexEvalHarnessError) {
    const shape = failureShapes[error.code];
    return Object.freeze({ code: shape.code, message: `${error.code}: ${shape.message}`, stage: shape.stage });
  }
  return Object.freeze({
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: 'CODEX_TRIAL_FAILED: The native Codex trial could not be completed.',
    stage: 'preflight',
  });
};
