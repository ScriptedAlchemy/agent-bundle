import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { loadJiti } from './jiti.ts';
import type {
  EvalAssertion,
  EvalAssertionOutcome,
  EvalHarnessFailure,
  EvalScriptOutcome,
} from './types.ts';
import { isErrno } from '../core/errors.ts';
import { deepFreeze } from '../core/freeze.ts';


const runCommand = promisify(execFile);

/** Server-owned result identity; authored graders and expectations may never claim it. */
export const claudeSemanticGraderId = 'claude-semantic';
/** Revision of the server-owned semantic grader request/result contract. */
export const claudeSemanticGraderContractRevision = 'v1';

export interface EvalGraderContext {
  readonly artifactRoot: string;
  readonly fixturePath: string;
  readonly prompt: string;
}

export interface EvalFileGraderSpec {
  readonly contains?: string;
  readonly exists: boolean;
  readonly id: string;
  readonly kind: 'file';
  readonly path: string;
}

export interface EvalJsonSchemaGraderSpec {
  readonly id: string;
  readonly kind: 'json-schema';
  readonly path: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface EvalRepositoryGraderSpec {
  readonly cleanWorktree?: boolean;
  readonly id: string;
  readonly kind: 'repository';
  readonly minimumCommits?: number;
}

export interface EvalScriptGraderSpec {
  readonly id: string;
  readonly kind: 'script';
  readonly script: string;
  readonly suiteDir: string;
}

export type EvalGraderSpec =
  | EvalFileGraderSpec
  | EvalJsonSchemaGraderSpec
  | EvalRepositoryGraderSpec
  | EvalScriptGraderSpec;

export type EvalGraderFunction = (
  context: EvalGraderContext,
) => EvalScriptOutcome | Promise<EvalScriptOutcome>;

export interface EvalGraderFailure {
  readonly id: string;
  readonly message: string;
}

export interface EvalGraderRun {
  readonly failures: readonly EvalGraderFailure[];
  readonly results: Readonly<Record<string, EvalScriptOutcome>>;
}

const outcomes = Object.freeze(['fail', 'inconclusive', 'pass']);

/** Public failure text never retains arbitrary exception details from author-provided graders. */
export const evalGraderFailureMessage = 'The grader could not complete.';

const outcome = (
  verdict: EvalAssertionOutcome,
  detail: string,
): EvalScriptOutcome => Object.freeze({ detail, outcome: verdict });

const containedPath = (root: string, candidate: string): string => {
  const target = resolve(root, candidate);
  const path = relative(root, target);
  if (path.length === 0 || isAbsolute(path) || path === '..' || path.startsWith('..')) {
    throw new RangeError(`Grader path ${JSON.stringify(candidate)} escapes the trial workspace.`);
  }
  return target;
};

const gradeFile = async (
  spec: EvalFileGraderSpec,
  context: EvalGraderContext,
): Promise<EvalScriptOutcome> => {
  const target = containedPath(context.fixturePath, spec.path);
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    return spec.exists
      ? outcome('fail', `${spec.path} does not exist.`)
      : outcome('pass', `${spec.path} does not exist.`);
  }
  if (!spec.exists) return outcome('fail', `${spec.path} exists but was expected to be absent.`);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return outcome('fail', `${spec.path} is not a regular file.`);
  }
  if (spec.contains === undefined) return outcome('pass', `${spec.path} exists.`);
  const contents = await readFile(target, 'utf8');
  return contents.includes(spec.contains)
    ? outcome('pass', `${spec.path} contains the expected content.`)
    : outcome('fail', `${spec.path} does not contain the expected content.`);
};

/** Compiled author schemas are cached per schema object; a compile failure still surfaces on first use. */
const compiledSchemaValidators = new WeakMap<Readonly<Record<string, unknown>>, ValidateFunction>();

const compiledJsonSchemaValidator = (schema: Readonly<Record<string, unknown>>): ValidateFunction => {
  const cached = compiledSchemaValidators.get(schema);
  if (cached !== undefined) return cached;
  // Author schemas are arbitrary JSON Schema documents, so strict vocabulary checking stays off.
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  compiledSchemaValidators.set(schema, validate);
  return validate;
};

const gradeJsonSchema = async (
  spec: EvalJsonSchemaGraderSpec,
  context: EvalGraderContext,
): Promise<EvalScriptOutcome> => {
  const target = containedPath(context.fixturePath, spec.path);
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(await readFile(target, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return outcome('fail', `${spec.path} does not exist.`);
    return outcome('fail', `${spec.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validate = compiledJsonSchemaValidator(spec.schema);
  return validate(parsed)
    ? outcome('pass', `${spec.path} matches its JSON Schema.`)
    : outcome('fail', `${spec.path} violates its JSON Schema: ${(validate.errors ?? []).map((issue) => `${issue.instancePath} ${issue.message ?? ''}`.trim()).join('; ')}`);
};

const gradeRepository = async (
  spec: EvalRepositoryGraderSpec,
  context: EvalGraderContext,
): Promise<EvalScriptOutcome> => {
  const details: string[] = [];
  if (spec.minimumCommits !== undefined) {
    const revisions = await runCommand('git', ['rev-list', '--count', 'HEAD'], { cwd: context.fixturePath });
    const commits = Number.parseInt(revisions.stdout.trim(), 10);
    if (!Number.isSafeInteger(commits) || commits < spec.minimumCommits) {
      return outcome('fail', `The repository has ${revisions.stdout.trim()} commits, expected at least ${spec.minimumCommits}.`);
    }
    details.push(`${commits} commits`);
  }
  if (spec.cleanWorktree !== undefined) {
    const status = await runCommand('git', ['status', '--porcelain'], { cwd: context.fixturePath });
    const clean = status.stdout.length === 0;
    if (clean !== spec.cleanWorktree) {
      return outcome('fail', clean ? 'The worktree is clean but changes were expected.' : 'The worktree has uncommitted changes.');
    }
    details.push(clean ? 'clean worktree' : 'modified worktree');
  }
  return outcome('pass', details.length === 0 ? 'No repository check was configured.' : `The repository has ${details.join(' and ')}.`);
};

/** Validates the result shape shared by authored and server-owned graders. */
export const isEvalScriptOutcome = (value: unknown): value is EvalScriptOutcome =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as EvalScriptOutcome).detail === 'string' &&
  outcomes.includes((value as EvalScriptOutcome).outcome);

const gradeScript = async (
  spec: EvalScriptGraderSpec,
  context: EvalGraderContext,
): Promise<EvalScriptOutcome> => {
  const target = containedPath(spec.suiteDir, spec.script);
  const loaded = await (await loadJiti()).import(target);
  const grader = (typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : loaded);
  if (typeof grader !== 'function') {
    throw new TypeError(`Grader ${JSON.stringify(spec.script)} must default-export a grader function.`);
  }
  const value: unknown = await (grader as EvalGraderFunction)({
    artifactRoot: context.artifactRoot,
    fixturePath: context.fixturePath,
    prompt: context.prompt,
  });
  if (!isEvalScriptOutcome(value)) {
    throw new TypeError(`Grader ${JSON.stringify(spec.script)} must return { detail, outcome }.`);
  }
  return outcome(value.outcome, value.detail);
};

export const runEvalGrader = async (
  spec: EvalGraderSpec,
  context: EvalGraderContext,
): Promise<EvalScriptOutcome> => {
  if (spec.kind === 'file') return gradeFile(spec, context);
  if (spec.kind === 'json-schema') return gradeJsonSchema(spec, context);
  if (spec.kind === 'repository') return gradeRepository(spec, context);
  return gradeScript(spec, context);
};

/** A grader defect never becomes plugin evidence: it is reported and its result stays inconclusive. */
export const runEvalGraders = async (
  specs: readonly EvalGraderSpec[],
  context: EvalGraderContext,
): Promise<EvalGraderRun> => {
  const failures: EvalGraderFailure[] = [];
  const results: Record<string, EvalScriptOutcome> = {};
  for (const spec of [...specs].sort((left, right) => left.id.localeCompare(right.id))) {
    try {
      results[spec.id] = await runEvalGrader(spec, context);
    } catch {
      failures.push(Object.freeze({ id: spec.id, message: evalGraderFailureMessage }));
      results[spec.id] = outcome('inconclusive', evalGraderFailureMessage);
    }
  }
  return deepFreeze({ failures: failures, results: results });
};

export const evalScriptGraderSpec = (script: string, suiteDir: string): EvalScriptGraderSpec =>
  Object.freeze({ id: script, kind: 'script', script, suiteDir });

/** Maps a case's outcome assertions to script grader specs, optionally excluding one reserved script id. */
export const outcomeGraderSpecs = (
  assertions: readonly EvalAssertion[],
  suiteDir: string,
  excludedScript?: string,
): readonly EvalScriptGraderSpec[] => Object.freeze(assertions.flatMap((assertion) =>
  assertion.kind === 'outcome' && assertion.script !== excludedScript
    ? [evalScriptGraderSpec(assertion.script, suiteDir)]
    : []));

/** The shared EVAL_GRADER_FAILED harness failure for a trial whose grading is incomplete. */
export const graderFailureFor = (
  failures: readonly (EvalGraderFailure | string)[],
): EvalHarnessFailure | undefined => failures.length === 0
  ? undefined
  : Object.freeze({
    code: 'EVAL_GRADER_FAILED',
    message: `Grading is incomplete: ${failures
      .map((failure) => typeof failure === 'string' ? failure : `${failure.id}: ${failure.message}`)
      .join('; ')}`,
    stage: 'grader',
  });
