import { CodedError } from '../core/errors.ts';

export type EvalServiceErrorCode =
  | 'EVAL_ARTIFACT_NOT_FOUND'
  | 'EVAL_ARTIFACT_OUTSIDE_PROJECT'
  | 'EVAL_ARTIFACT_UNAVAILABLE'
  | 'EVAL_EVENTS_CURSOR_INVALID'
  | 'EVAL_HARNESS_UNSUPPORTED'
  | 'EVAL_RUN_NOT_FOUND'
  | 'EVAL_SELECTION_EMPTY'
  | 'EVAL_SEMANTIC_GRADER_UNSUPPORTED'
  | 'EVAL_TARGET_MISSING'
  | 'EVAL_TRIALS_INVALID';

/** Every refusal a caller can act on without reading the eval internals. */
export class EvalServiceError extends CodedError<EvalServiceErrorCode> {
  constructor(code: EvalServiceErrorCode, message: string) {
    super('EvalServiceError', code, message);
  }
}

export const evalServiceError = (code: EvalServiceErrorCode, message: string): EvalServiceError =>
  new EvalServiceError(code, message);
