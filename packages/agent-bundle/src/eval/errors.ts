import { CodedError } from '../core/errors.ts';

export type EvalDefinitionErrorCode =
  | 'EVAL_ASSERTION_INVALID'
  | 'EVAL_CASE_INVALID'
  | 'EVAL_CREDENTIAL_REJECTED'
  | 'EVAL_DRAFT_INVALID'
  | 'EVAL_FIXTURE_INVALID'
  | 'EVAL_HOST_INVALID'
  | 'EVAL_INVOCATION_INVALID'
  | 'EVAL_PROMPT_INVALID'
  | 'EVAL_SUITE_INVALID'
  | 'EVAL_TRIALS_INVALID';

export class EvalDefinitionError extends CodedError<EvalDefinitionErrorCode> {
  constructor(code: EvalDefinitionErrorCode, message: string) {
    super('EvalDefinitionError', code, message);
  }
}

export type EvalConfigErrorCode =
  | 'EVAL_CONFIG_INVALID'
  | 'EVAL_CREDENTIAL_REJECTED'
  | 'EVAL_INCLUDE_INVALID'
  | 'EVAL_RUNS_DIR_INVALID';

export class EvalConfigError extends CodedError<EvalConfigErrorCode> {
  constructor(code: EvalConfigErrorCode, message: string) {
    super('EvalConfigError', code, message);
  }
}

export type EvalDiscoveryErrorCode =
  | 'EVAL_SUITE_DUPLICATE'
  | 'EVAL_SUITE_EXPORT_INVALID'
  | 'EVAL_SUITE_LOAD_FAILED'
  | 'EVAL_SUITE_PATH_INVALID';

export class EvalDiscoveryError extends CodedError<EvalDiscoveryErrorCode> {
  readonly sourcePath?: string;

  constructor(code: EvalDiscoveryErrorCode, message: string, sourcePath?: string) {
    super('EvalDiscoveryError', code, message);
    this.sourcePath = sourcePath;
  }
}

export type EvalFixtureErrorCode =
  | 'EVAL_FIXTURE_DESTINATION_EXISTS'
  | 'EVAL_FIXTURE_ENTRY_UNSUPPORTED'
  | 'EVAL_FIXTURE_GIT_FAILED'
  | 'EVAL_FIXTURE_SOURCE_INVALID';

export class EvalFixtureError extends CodedError<EvalFixtureErrorCode> {
  constructor(code: EvalFixtureErrorCode, message: string) {
    super('EvalFixtureError', code, message);
  }
}

export type EvalRunStoreErrorCode =
  | 'EVAL_RUN_CLOSED'
  | 'EVAL_RUN_CORRUPT'
  | 'EVAL_RUN_EXISTS'
  | 'EVAL_RUN_ID_INVALID'
  | 'EVAL_RUN_NOT_FOUND'
  | 'EVAL_RUN_OWNED'
  | 'EVAL_RUN_RECORD_INVALID';

export class EvalRunStoreError extends CodedError<EvalRunStoreErrorCode> {
  constructor(code: EvalRunStoreErrorCode, message: string) {
    super('EvalRunStoreError', code, message);
  }
}

export type EvalHarnessErrorCode =
  | 'EVAL_ARTIFACT_INVALID'
  | 'EVAL_ARTIFACT_MISSING'
  | 'EVAL_ARTIFACT_TARGET_MISSING'
  | 'EVAL_HARNESS_INPUT_INVALID'
  | 'EVAL_MODEL_BACKED_UNSUPPORTED';

export class EvalHarnessError extends CodedError<EvalHarnessErrorCode> {
  constructor(code: EvalHarnessErrorCode, message: string) {
    super('EvalHarnessError', code, message);
  }
}
