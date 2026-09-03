import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

/** Issue shape shared by every Ajv-backed schema contract. */
export interface SchemaIssue {
  readonly field?: string;
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
}

/** Each contract keeps its own instance so schema `$id` registration cannot collide. */
export const createSchemaValidator = (): Ajv2020 => new Ajv2020({ allErrors: true, strict: true });

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
