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

export class EvalDefinitionError extends Error {
  readonly code: EvalDefinitionErrorCode;

  constructor(code: EvalDefinitionErrorCode, message: string) {
    super(message);
    this.name = 'EvalDefinitionError';
    this.code = code;
  }
}

export type EvalConfigErrorCode =
  | 'EVAL_CONFIG_INVALID'
  | 'EVAL_CREDENTIAL_REJECTED'
  | 'EVAL_INCLUDE_INVALID'
  | 'EVAL_RUNS_DIR_INVALID';

export class EvalConfigError extends Error {
  readonly code: EvalConfigErrorCode;

  constructor(code: EvalConfigErrorCode, message: string) {
    super(message);
    this.name = 'EvalConfigError';
    this.code = code;
  }
}

export type EvalDiscoveryErrorCode =
  | 'EVAL_SUITE_DUPLICATE'
  | 'EVAL_SUITE_EXPORT_INVALID'
  | 'EVAL_SUITE_LOAD_FAILED'
  | 'EVAL_SUITE_PATH_INVALID';

export class EvalDiscoveryError extends Error {
  readonly code: EvalDiscoveryErrorCode;
  readonly sourcePath?: string;

  constructor(code: EvalDiscoveryErrorCode, message: string, sourcePath?: string) {
    super(message);
    this.name = 'EvalDiscoveryError';
    this.code = code;
    this.sourcePath = sourcePath;
  }
}

export type EvalFixtureErrorCode =
  | 'EVAL_FIXTURE_DESTINATION_EXISTS'
  | 'EVAL_FIXTURE_ENTRY_UNSUPPORTED'
  | 'EVAL_FIXTURE_GIT_FAILED'
  | 'EVAL_FIXTURE_SOURCE_INVALID';

export class EvalFixtureError extends Error {
  readonly code: EvalFixtureErrorCode;

  constructor(code: EvalFixtureErrorCode, message: string) {
    super(message);
    this.name = 'EvalFixtureError';
    this.code = code;
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

export class EvalRunStoreError extends Error {
  readonly code: EvalRunStoreErrorCode;

  constructor(code: EvalRunStoreErrorCode, message: string) {
    super(message);
    this.name = 'EvalRunStoreError';
    this.code = code;
  }
}

export type EvalHarnessErrorCode =
  | 'EVAL_ARTIFACT_INVALID'
  | 'EVAL_ARTIFACT_MISSING'
  | 'EVAL_ARTIFACT_TARGET_MISSING'
  | 'EVAL_HARNESS_INPUT_INVALID'
  | 'EVAL_MODEL_BACKED_UNSUPPORTED';

export class EvalHarnessError extends Error {
  readonly code: EvalHarnessErrorCode;

  constructor(code: EvalHarnessErrorCode, message: string) {
    super(message);
    this.name = 'EvalHarnessError';
    this.code = code;
  }
}
