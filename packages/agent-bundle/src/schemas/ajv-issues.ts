import { Ajv2020, type ErrorObject, type Options } from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

/** Issue shape shared by every Ajv-backed schema contract. */
export interface SchemaIssue {
  readonly field?: string;
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

/**
 * Each contract keeps its own instance so schema `$id` registration cannot
 * collide. Strict mode is the baseline; a contract passes `options` only to
 * relax one named restriction its schema shape needs.
 */
export const createSchemaValidator = (options: Options = {}): Ajv2020 => {
  const validator = new Ajv2020({ allErrors: true, strict: true, ...options });
  formatsModule.default(validator);
  return validator;
};

const parameter = (error: ErrorObject, name: string): string | undefined => {
  const value = (error.params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
};

const fieldFor = (error: ErrorObject): string | undefined => {
  if (error.keyword === 'additionalProperties') return parameter(error, 'additionalProperty');
  if (error.keyword === 'required') return parameter(error, 'missingProperty');
  const [field] = error.instancePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  return field;
};

export const toIssue = (error: ErrorObject): SchemaIssue => {
  const field = fieldFor(error);
  return Object.freeze({
    ...(field === undefined ? {} : { field }),
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'schema validation failed',
  });
};

/** Deterministic issue order: instance path, then keyword, then message. */
export const compareSchemaIssues = (left: SchemaIssue, right: SchemaIssue): number => {
  if (left.instancePath !== right.instancePath) {
    return left.instancePath < right.instancePath ? -1 : 1;
  }
  if (left.keyword !== right.keyword) {
    return left.keyword < right.keyword ? -1 : 1;
  }
  if (left.message !== right.message) {
    return left.message < right.message ? -1 : 1;
  }
  return 0;
};

/**
 * One line per issue: the JSON Pointer of the offending value (`/` for the
 * root), Ajv's message, and — for closed-key failures, whose message omits it
 * — the unexpected key.
 */
export const formatSchemaIssue = (issue: SchemaIssue): string => {
  const location = issue.instancePath.length === 0 ? '/' : issue.instancePath;
  const unexpectedKey = issue.keyword === 'additionalProperties' && issue.field !== undefined
    ? `: ${issue.field}`
    : '';
  return `${location} ${issue.message}${unexpectedKey}`;
};
