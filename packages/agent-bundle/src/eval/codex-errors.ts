import type { EvalHarnessFailure, EvalHarnessFailureCode, EvalHarnessFailureStage } from './types.ts';

export type CodexEvalHarnessErrorCode =
  | 'CODEX_ARTIFACT_INVALID'
  | 'CODEX_AUTH_UNAVAILABLE'
  | 'CODEX_CLI_INCOMPATIBLE'
  | 'CODEX_CLI_MISSING'
  | 'CODEX_CLI_UNAUTHENTICATED'
  | 'CODEX_FIXTURE_UNAVAILABLE'
  | 'CODEX_HOME_MUTATED'
  | 'CODEX_PLUGIN_UNAVAILABLE'
  | 'CODEX_TRACE_INVALID'
  | 'CODEX_TRIAL_CANCELLED';

/** A defect in Agent Bundle or the installed Codex CLI, never evidence about the plugin. */
export class CodexEvalHarnessError extends Error {
  readonly code: CodexEvalHarnessErrorCode;

  constructor(code: CodexEvalHarnessErrorCode, message: string) {
    super(message);
    this.name = 'CodexEvalHarnessError';
    this.code = code;
  }
}

const failureShapes: Readonly<Record<
  CodexEvalHarnessErrorCode,
  Readonly<{ readonly code: EvalHarnessFailureCode; readonly stage: EvalHarnessFailureStage }>
>> = Object.freeze({
  CODEX_ARTIFACT_INVALID: Object.freeze({ code: 'EVAL_ARTIFACT_UNAVAILABLE', stage: 'artifact' }),
  CODEX_AUTH_UNAVAILABLE: Object.freeze({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' }),
  CODEX_CLI_INCOMPATIBLE: Object.freeze({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' }),
  CODEX_CLI_MISSING: Object.freeze({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' }),
  CODEX_CLI_UNAUTHENTICATED: Object.freeze({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' }),
  CODEX_FIXTURE_UNAVAILABLE: Object.freeze({ code: 'EVAL_FIXTURE_UNAVAILABLE', stage: 'fixture' }),
  CODEX_HOME_MUTATED: Object.freeze({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' }),
  CODEX_PLUGIN_UNAVAILABLE: Object.freeze({ code: 'EVAL_PROCESS_UNAVAILABLE', stage: 'preflight' }),
  CODEX_TRACE_INVALID: Object.freeze({ code: 'EVAL_TRACE_UNAVAILABLE', stage: 'trace' }),
  CODEX_TRIAL_CANCELLED: Object.freeze({ code: 'EVAL_TRACE_UNAVAILABLE', stage: 'trace' }),
});

/** Everything the native harness can go wrong at is a harness failure, so no trial blames the plugin. */
export const codexHarnessFailure = (error: unknown): EvalHarnessFailure => {
  if (error instanceof CodexEvalHarnessError) {
    const shape = failureShapes[error.code];
    return Object.freeze({ code: shape.code, message: `${error.code}: ${error.message}`, stage: shape.stage });
  }
  return Object.freeze({
    code: 'EVAL_PROCESS_UNAVAILABLE',
    message: `CODEX_TRIAL_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    stage: 'preflight',
  });
};
